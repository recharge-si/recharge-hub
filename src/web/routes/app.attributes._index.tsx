import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";
import { z } from "zod";

import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { addAttribute, deleteAttribute } from "~/domain/attributes/mutations";
import {
  pathOf,
  schemaHealth,
  schemaMetrics,
  typesUsing,
} from "~/domain/attributes/resolve";
import { starterSchema } from "~/domain/attributes/starter";
import { DATA_TYPES, SCOPES } from "~/domain/attributes/types";
import { Advanced } from "~/web/components/advanced";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { Dropdown } from "~/web/components/dropdown";
import {
  ATTRIBUTE_ROUTES,
  DATA_TYPE_LABEL,
  DATA_TYPE_OPTIONS,
  SCOPE_OPTIONS,
  countOf,
} from "~/web/lib/attributes";
import {
  commitSchemaChange,
  newId,
  revisionFrom,
  type SchemaActionResult,
} from "~/web/lib/attributes.server";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { redirectWithin } from "~/web/lib/redirects";

/**
 * The attribute catalogue (docs/attributes.md § Screens): every field
 * defined once, with where it is used, and what in the plan needs a person.
 *
 * Nothing here reads or writes Shopify. The schema is a plan of what every
 * product type should carry; the Shopify field on each attribute is where a
 * metafield definition would later be created.
 */
const HELP_MODAL_ID = "about-attributes";
const NEW_MODAL_ID = "new-attribute";
const DELETE_MODAL_ID = "delete-attribute";

const AREA_HREF = {
  types: ATTRIBUTE_ROUTES.types,
  attributes: ATTRIBUTE_ROUTES.index,
  settings: ATTRIBUTE_ROUTES.settings,
} as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const { schema, revision } = await getAttributeSchema(principal);

  return {
    revision,
    empty: schema.types.length === 0 && schema.attributes.length === 0,
    metrics: schemaMetrics(schema),
    problems: schemaHealth(schema)
      .filter((check) => check.count > 0)
      .map((check) => ({
        id: check.id,
        message: check.message,
        href: AREA_HREF[check.area],
      })),
    attributes: schema.attributes
      .map((attribute) => ({
        id: attribute.id,
        name: attribute.name,
        key: attribute.key,
        type: DATA_TYPE_LABEL[attribute.dataType],
        unit: attribute.unit,
        usedBy: typesUsing(schema, attribute.id).length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    types: schema.types
      .map((type) => ({
        id: type.id,
        label: pathOf(schema, type.id).join(" › "),
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    sets: schema.sets
      .map((set) => ({ id: set.id, name: set.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
};

const newAttributeForm = z.object({
  name: z.string().trim(),
  dataType: z.enum(DATA_TYPES),
  unit: z.string().trim(),
  scope: z.enum(SCOPES),
  key: z.string().trim(),
  setId: z.string().trim(),
  requiredDefault: z.enum(["on", "off"]),
  attachTo: z.string().trim(),
});

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<SchemaActionResult> => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const revision = revisionFrom(formData);

  if (intent === "create") {
    const parsed = newAttributeForm.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!parsed.success) {
      return {
        ok: false,
        message: "The form could not be read. Reload the page and try again.",
      };
    }
    const input = parsed.data;
    let createdId: string | null = null;
    const result = await commitSchemaChange(
      principal,
      revision,
      "attribute_schema.attribute.added",
      (schema) => {
        const outcome = addAttribute(
          schema,
          {
            name: input.name,
            dataType: input.dataType,
            unit: input.unit,
            scope: input.scope,
            key: input.key,
            setId: input.setId || null,
            requiredDefault: input.requiredDefault === "on",
            attachToTypeId: input.attachTo || null,
          },
          newId,
        );
        createdId = outcome.attributeId ?? null;
        return outcome;
      },
      actor,
    );
    if (result.ok && createdId !== null) {
      throw redirectWithin(request, ATTRIBUTE_ROUTES.attribute(createdId));
    }
    return result;
  }

  if (intent === "delete") {
    const id = String(formData.get("id") ?? "");
    return commitSchemaChange(
      principal,
      revision,
      "attribute_schema.attribute.deleted",
      (schema) => deleteAttribute(schema, id),
      actor,
    );
  }

  if (intent === "starter") {
    return commitSchemaChange(
      principal,
      revision,
      "attribute_schema.starter.loaded",
      (schema) =>
        schema.types.length === 0 && schema.attributes.length === 0
          ? {
              ok: true,
              schema: starterSchema(),
              message: "Starter schema loaded.",
            }
          : {
              ok: false,
              message:
                "The schema is not empty, so the starter was not loaded.",
            },
      actor,
    );
  }

  return { ok: false, message: "Unknown action." };
};

const BLANK_FORM = {
  name: "",
  dataType: "text",
  unit: "",
  scope: "product",
  key: "",
  setId: "",
  requiredDefault: false,
  attachTo: "",
};

export default function Attributes() {
  const { revision, empty, metrics, problems, attributes, types, sets } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;

  const [query, setQuery] = useState("");
  const [form, setForm] = useState(BLANK_FORM);
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    name: string;
    usedBy: number;
  } | null>(null);

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  const submit = (fields: Record<string, string>) =>
    fetcher.submit(
      { ...fields, revision: String(revision) },
      { method: "post" },
    );

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? attributes.filter((attribute) =>
        `${attribute.name} ${attribute.key}`.toLowerCase().includes(needle),
      )
    : attributes;

  const typeOptions = [
    { value: "", label: "Not yet" },
    ...types.map((type) => ({ value: type.id, label: type.label })),
  ];
  const setOptions = [
    { value: "", label: "No set — attach it to types one by one" },
    ...sets.map((set) => ({ value: set.id, label: set.name })),
  ];

  return (
    <s-page heading="Attributes">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-button
        slot="primary-action"
        variant="primary"
        command="--show"
        commandFor={NEW_MODAL_ID}
        onClick={() => setForm(BLANK_FORM)}
      >
        New attribute
      </s-button>
      <s-button slot="secondary-actions" href={ATTRIBUTE_ROUTES.types}>
        Product types
      </s-button>
      <s-button slot="secondary-actions" href={ATTRIBUTE_ROUTES.settings}>
        Settings
      </s-button>
      <s-button
        slot="secondary-actions"
        icon="question-circle"
        command="--show"
        commandFor={HELP_MODAL_ID}
      >
        Help
      </s-button>

      <s-modal id={HELP_MODAL_ID} heading="About attributes">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            An attribute is one piece of information a product carries — a sail
            size, a volume, a skill level. Define each one once here, then
            decide which product types need it on the product types page.
          </s-paragraph>
          <s-paragraph>
            Product types form a tree. An attribute or a set attached to a type
            flows down to every type beneath it; a requirement changed or a
            field removed on one type stays on that type alone.
          </s-paragraph>
          <s-paragraph>
            This is a plan. Nothing here reads or writes Shopify; the Shopify
            field on an attribute is where a definition would be created later.
          </s-paragraph>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          command="--hide"
          commandFor={HELP_MODAL_ID}
        >
          Close
        </s-button>
      </s-modal>

      <s-modal id={NEW_MODAL_ID} heading="New attribute">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Name"
            placeholder="Sail size"
            value={form.name}
            onInput={(event) =>
              setForm({ ...form, name: event.currentTarget.value })
            }
          />
          <s-grid
            gridTemplateColumns="@container (inline-size <= 480px) 1fr, 1fr 1fr"
            gap="base"
          >
            <Dropdown
              name="dataType"
              label="Type"
              value={form.dataType}
              options={DATA_TYPE_OPTIONS}
              onChange={(dataType) => setForm({ ...form, dataType })}
            />
            <s-text-field
              label="Unit"
              placeholder="cm, L, m²"
              value={form.unit}
              onInput={(event) =>
                setForm({ ...form, unit: event.currentTarget.value })
              }
            />
            <Dropdown
              name="scope"
              label="Applies to"
              value={form.scope}
              options={SCOPE_OPTIONS}
              onChange={(scope) => setForm({ ...form, scope })}
            />
            <Dropdown
              name="attachTo"
              label="Add to a product type"
              details="Its descendants get it too."
              value={form.attachTo}
              options={typeOptions}
              onChange={(attachTo) => setForm({ ...form, attachTo })}
            />
          </s-grid>
          <s-checkbox
            label="Required by default"
            checked={form.requiredDefault}
            onChange={(event) =>
              setForm({ ...form, requiredDefault: event.currentTarget.checked })
            }
          />
          <Advanced
            summary={
              form.setId
                ? `In ${sets.find((set) => set.id === form.setId)?.name ?? "a set"}; the Shopify field is ${form.key || "generated from the name"}.`
                : `No set; the Shopify field is ${form.key || "generated from the name"}.`
            }
          >
            <s-stack direction="block" gap="base">
              <Dropdown
                name="setId"
                label="Attribute set"
                value={form.setId}
                options={setOptions}
                onChange={(setId) => setForm({ ...form, setId })}
              />
              <s-text-field
                label="Shopify field"
                details="namespace.key, for example recharge.sail_size. Left empty, one is made from the name."
                value={form.key}
                onInput={(event) =>
                  setForm({ ...form, key: event.currentTarget.value })
                }
              />
            </s-stack>
          </Advanced>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          command="--hide"
          commandFor={NEW_MODAL_ID}
          {...(form.name.trim() === "" || busy ? { disabled: true } : {})}
          onClick={() =>
            submit({
              intent: "create",
              name: form.name,
              dataType: form.dataType,
              unit: form.unit,
              scope: form.scope,
              key: form.key,
              setId: form.setId,
              requiredDefault: form.requiredDefault ? "on" : "off",
              attachTo: form.attachTo,
            })
          }
        >
          Add attribute
        </s-button>
        <s-button
          slot="secondary-actions"
          command="--hide"
          commandFor={NEW_MODAL_ID}
        >
          Cancel
        </s-button>
      </s-modal>

      <ConfirmModal
        id={DELETE_MODAL_ID}
        heading={`Delete “${pendingDelete?.name ?? ""}” everywhere?`}
        confirmLabel="Delete everywhere"
        onConfirm={() => {
          if (pendingDelete) submit({ intent: "delete", id: pendingDelete.id });
        }}
      >
        <s-paragraph>
          {pendingDelete
            ? `It leaves the catalogue and ${countOf(pendingDelete.usedBy, "product type")}, with every requirement change and removal about it. This cannot be undone.`
            : ""}
        </s-paragraph>
      </ConfirmModal>

      <s-stack direction="block" gap="large">
        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {empty ? (
          <s-section heading="Nothing planned yet">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Start from a small example of sails, boards and wetsuits and
                change it to fit, import a file exported earlier, or add the
                first attribute and product type yourself.
              </s-paragraph>
              <s-stack direction="inline" gap="small-300">
                <s-button
                  type="button"
                  onClick={() => submit({ intent: "starter" })}
                  {...(busy ? { disabled: true, loading: true } : {})}
                >
                  Start from the example
                </s-button>
                <s-button href={ATTRIBUTE_ROUTES.settings}>
                  Import a file
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>
        ) : (
          <s-section heading="Overview">
            <s-stack direction="block" gap="base">
              <s-text color="subdued">
                {`${countOf(metrics.assignableTypes, "product type")} and ${countOf(metrics.categories, "category", "categories")} · ${countOf(metrics.attributes, "attribute")} · ${countOf(metrics.sets, "set")}`}
              </s-text>
              {problems.length === 0 ? (
                <s-text color="subdued">
                  Every product type has attributes, every attribute is used and
                  mapped, and every choice has options.
                </s-text>
              ) : (
                <s-stack direction="block" gap="small-300">
                  {problems.map((problem) => (
                    <s-stack
                      key={problem.id}
                      direction="inline"
                      gap="small-300"
                      alignItems="center"
                    >
                      <s-icon type="alert-circle" tone="warning" />
                      <s-text>{problem.message}</s-text>
                      {problem.href !== ATTRIBUTE_ROUTES.index ? (
                        <s-link href={problem.href}>Review</s-link>
                      ) : null}
                    </s-stack>
                  ))}
                </s-stack>
              )}
            </s-stack>
          </s-section>
        )}

        <s-section heading="Attributes">
          <s-stack direction="block" gap="base">
            <s-search-field
              label="Search attributes"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search by name or Shopify field"
              value={query}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
            {attributes.length === 0 ? (
              <s-text color="subdued">No attributes yet.</s-text>
            ) : shown.length === 0 ? (
              <s-text color="subdued">No attribute matches the search.</s-text>
            ) : (
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header listSlot="primary">Attribute</s-table-header>
                  <s-table-header listSlot="secondary">Type</s-table-header>
                  <s-table-header listSlot="kicker">Used by</s-table-header>
                  <s-table-header listSlot="inline">Actions</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {shown.map((attribute) => (
                    <s-table-row key={attribute.id}>
                      <s-table-cell>
                        <s-stack direction="block" gap="small-500">
                          <s-link
                            href={ATTRIBUTE_ROUTES.attribute(attribute.id)}
                          >
                            {attribute.name}
                          </s-link>
                          <s-text color="subdued">
                            {attribute.key || "No Shopify field"}
                          </s-text>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        {attribute.unit
                          ? `${attribute.type} · ${attribute.unit}`
                          : attribute.type}
                      </s-table-cell>
                      <s-table-cell>
                        {countOf(attribute.usedBy, "type")}
                      </s-table-cell>
                      <s-table-cell>
                        <s-button
                          variant="tertiary"
                          tone="critical"
                          accessibilityLabel={`Delete ${attribute.name} everywhere`}
                          command="--show"
                          commandFor={DELETE_MODAL_ID}
                          onClick={() => setPendingDelete(attribute)}
                          {...(busy ? { disabled: true } : {})}
                        >
                          Delete
                        </s-button>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
