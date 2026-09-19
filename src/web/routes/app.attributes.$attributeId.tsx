import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useEffect, useState } from "react";
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
import {
  deleteAttribute,
  updateAttribute,
} from "~/domain/attributes/mutations";
import { attributeById, pathOf, typesUsing } from "~/domain/attributes/resolve";
import {
  DATA_TYPES,
  IMPLEMENTATIONS,
  KEY_PATTERN,
  SCOPES,
  isSelect,
  type DataType,
  type Implementation,
  type Scope,
} from "~/domain/attributes/types";
import { AdvancedSection } from "~/web/components/advanced-section";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { Dropdown } from "~/web/components/dropdown";
import {
  ATTRIBUTE_ROUTES,
  DATA_TYPE_OPTIONS,
  IMPLEMENTATION_LABEL,
  IMPLEMENTATION_OPTIONS,
  SCOPE_LABEL,
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
import { useResetWhenSaved, useSaveBar } from "~/web/lib/use-save-bar";

/**
 * One attribute's shared definition (docs/attributes.md § Screens). A change
 * here applies everywhere the attribute is used; what each type requires of
 * it is decided on the product types page.
 */
const SAVE_BAR_ID = "attribute-save-bar";
const DELETE_MODAL_ID = "delete-attribute";

interface Option {
  key: string;
  code: string;
  en: string;
  si: string;
}

interface Form {
  name: string;
  dataType: DataType;
  unit: string;
  description: string;
  setId: string;
  requiredDefault: boolean;
  filterable: boolean;
  searchable: boolean;
  comparable: boolean;
  key: string;
  scope: Scope;
  implementation: Implementation;
  options: Option[];
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const { schema, revision } = await getAttributeSchema(principal);
  const attribute = attributeById(schema, String(params.attributeId ?? ""));
  if (!attribute) throw new Response("Not found", { status: 404 });

  const list = schema.valueLists.find((l) => l.id === attribute.valueListId);
  const form: Form = {
    name: attribute.name,
    dataType: attribute.dataType,
    unit: attribute.unit,
    description: attribute.description,
    setId: attribute.setId ?? "",
    requiredDefault: attribute.requiredDefault,
    filterable: attribute.filterable,
    searchable: attribute.searchable,
    comparable: attribute.comparable,
    key: attribute.key,
    scope: attribute.scope,
    implementation: attribute.implementation,
    options: (list?.items ?? []).map((item, index) => ({
      key: `saved-${index}`,
      ...item,
    })),
  };

  return {
    revision,
    form,
    sets: schema.sets
      .map((set) => ({ value: set.id, label: set.name }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    usedBy: typesUsing(schema, attribute.id)
      .map((type) => ({
        id: type.id,
        label: pathOf(schema, type.id).join(" › "),
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
};

const saveForm = z.object({
  name: z.string(),
  dataType: z.enum(DATA_TYPES),
  unit: z.string(),
  description: z.string(),
  setId: z.string(),
  requiredDefault: z.boolean(),
  filterable: z.boolean(),
  searchable: z.boolean(),
  comparable: z.boolean(),
  key: z.string(),
  scope: z.enum(SCOPES),
  implementation: z.enum(IMPLEMENTATIONS),
  options: z.array(
    z.object({ code: z.string(), en: z.string(), si: z.string() }),
  ),
});

export const action = async ({
  request,
  params,
}: ActionFunctionArgs): Promise<SchemaActionResult> => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);
  const attributeId = String(params.attributeId ?? "");
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const revision = revisionFrom(formData);

  if (intent === "save") {
    let json: unknown;
    try {
      json = JSON.parse(String(formData.get("form") ?? ""));
    } catch {
      return {
        ok: false,
        message: "The form could not be read. Reload the page and try again.",
      };
    }
    const parsed = saveForm.safeParse(json);
    if (!parsed.success) {
      return {
        ok: false,
        message: "The form could not be read. Reload the page and try again.",
      };
    }
    const input = parsed.data;
    return commitSchemaChange(
      principal,
      revision,
      "attribute_schema.attribute.saved",
      (schema) =>
        updateAttribute(
          schema,
          attributeId,
          { ...input, setId: input.setId || null },
          newId,
        ),
      actor,
    );
  }

  if (intent === "delete") {
    const result = await commitSchemaChange(
      principal,
      revision,
      "attribute_schema.attribute.deleted",
      (schema) => deleteAttribute(schema, attributeId),
      actor,
    );
    if (result.ok) throw redirectWithin(request, ATTRIBUTE_ROUTES.index);
    return result;
  }

  return { ok: false, message: "Unknown action." };
};

function normalise(form: Form): string {
  return JSON.stringify({
    ...form,
    name: form.name.trim(),
    unit: form.unit.trim(),
    description: form.description.trim(),
    key: form.key.trim(),
    options: isSelect(form.dataType)
      ? form.options.map((o) => ({
          code: o.code.trim(),
          en: o.en.trim(),
          si: o.si.trim(),
        }))
      : [],
  });
}

let nextOptionKey = 0;

export default function AttributeEditor() {
  const {
    revision,
    form: saved,
    sets,
    usedBy,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;

  const [form, setForm] = useState<Form>(saved);
  const savedKey = normalise(saved);
  const reset = useCallback(() => setForm(saved), [saved]);
  useResetWhenSaved(savedKey, reset);

  const dirty = normalise(form) !== savedKey;
  useSaveBar(SAVE_BAR_ID, dirty);

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  const patch = (changes: Partial<Form>) =>
    setForm((current) => ({ ...current, ...changes }));

  const save = () =>
    fetcher.submit(
      {
        intent: "save",
        revision: String(revision),
        form: JSON.stringify({
          ...form,
          setId: form.setId,
          options: form.options.map(({ code, en, si }) => ({ code, en, si })),
        }),
      },
      { method: "post" },
    );

  const keyLooksWrong =
    form.implementation === "custom" &&
    form.key.trim() !== "" &&
    !KEY_PATTERN.test(form.key.trim());

  const setOptions = [
    { value: "", label: "No set — attached to types one by one" },
    ...sets,
  ];

  return (
    <s-page heading={saved.name}>
      <s-link slot="breadcrumb-actions" href={ATTRIBUTE_ROUTES.index}>
        Attributes
      </s-link>

      <s-button
        slot="secondary-actions"
        tone="critical"
        command="--show"
        commandFor={DELETE_MODAL_ID}
        {...(busy ? { disabled: true } : {})}
      >
        Delete everywhere
      </s-button>

      <ConfirmModal
        id={DELETE_MODAL_ID}
        heading={`Delete “${saved.name}” everywhere?`}
        confirmLabel="Delete everywhere"
        onConfirm={() =>
          fetcher.submit(
            { intent: "delete", revision: String(revision) },
            { method: "post" },
          )
        }
      >
        <s-paragraph>
          {`It leaves the catalogue and ${countOf(usedBy.length, "product type")}, with every requirement change and removal about it. This cannot be undone.`}
        </s-paragraph>
      </ConfirmModal>

      <ui-save-bar id={SAVE_BAR_ID}>
        <button
          variant="primary"
          onClick={save}
          {...(busy ? { loading: "" } : {})}
        >
          Save
        </button>
        <button onClick={reset}>Discard</button>
      </ui-save-bar>

      <s-stack direction="block" gap="large">
        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="Definition">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              Shared by every product type that uses this attribute.
            </s-text>
            <s-text-field
              label="Name"
              value={form.name}
              onInput={(event) => patch({ name: event.currentTarget.value })}
              {...(form.name.trim() === "" ? { error: "Enter a name." } : {})}
            />
            <s-grid
              gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr 1fr"
              gap="base"
            >
              <Dropdown
                name="dataType"
                label="Type"
                value={form.dataType}
                options={DATA_TYPE_OPTIONS}
                onChange={(dataType) =>
                  patch({ dataType: dataType as DataType })
                }
              />
              <s-text-field
                label="Unit"
                details="For a measurement: cm, L, m²."
                value={form.unit}
                onInput={(event) => patch({ unit: event.currentTarget.value })}
              />
            </s-grid>
            <s-text-field
              label="Description"
              value={form.description}
              onInput={(event) =>
                patch({ description: event.currentTarget.value })
              }
            />
            <s-grid
              gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr 1fr"
              gap="small-300"
            >
              <s-checkbox
                label="Required by default"
                details="A product type can still decide otherwise for itself."
                checked={form.requiredDefault}
                onChange={(event) =>
                  patch({ requiredDefault: event.currentTarget.checked })
                }
              />
              <s-checkbox
                label="Filterable"
                checked={form.filterable}
                onChange={(event) =>
                  patch({ filterable: event.currentTarget.checked })
                }
              />
              <s-checkbox
                label="Searchable"
                checked={form.searchable}
                onChange={(event) =>
                  patch({ searchable: event.currentTarget.checked })
                }
              />
              <s-checkbox
                label="Comparable"
                checked={form.comparable}
                onChange={(event) =>
                  patch({ comparable: event.currentTarget.checked })
                }
              />
            </s-grid>
          </s-stack>
        </s-section>

        {isSelect(form.dataType) ? (
          <s-section heading="Options">
            <s-stack direction="block" gap="base">
              <s-text color="subdued">
                The choices a product can hold. The code is what is stored and
                stays the same when a label changes; left empty, it is made from
                the English label.
              </s-text>
              {form.options.length === 0 ? (
                <s-text color="subdued">No options yet.</s-text>
              ) : null}
              {form.options.map((option, index) => (
                <s-box
                  key={option.key}
                  padding="base"
                  borderRadius="base"
                  borderWidth="base"
                  borderStyle="solid"
                  borderColor="subdued"
                >
                  <s-stack direction="block" gap="small-300">
                    <s-stack
                      direction="inline"
                      justifyContent="space-between"
                      alignItems="center"
                    >
                      <s-text type="strong">{`Option ${index + 1}`}</s-text>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        accessibilityLabel={`Remove option ${index + 1}`}
                        onClick={() =>
                          patch({
                            options: form.options.filter(
                              (entry) => entry.key !== option.key,
                            ),
                          })
                        }
                      >
                        Remove
                      </s-button>
                    </s-stack>
                    <s-grid
                      gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr 1fr 1fr"
                      gap="base"
                    >
                      <s-text-field
                        label="English label"
                        value={option.en}
                        onInput={(event) =>
                          patch({
                            options: form.options.map((entry) =>
                              entry.key === option.key
                                ? { ...entry, en: event.currentTarget.value }
                                : entry,
                            ),
                          })
                        }
                        {...(option.en.trim() === ""
                          ? { error: "Enter the English label." }
                          : {})}
                      />
                      <s-text-field
                        label="Slovenian label"
                        value={option.si}
                        onInput={(event) =>
                          patch({
                            options: form.options.map((entry) =>
                              entry.key === option.key
                                ? { ...entry, si: event.currentTarget.value }
                                : entry,
                            ),
                          })
                        }
                      />
                      <s-text-field
                        label="Code"
                        placeholder="Made from the label"
                        value={option.code}
                        onInput={(event) =>
                          patch({
                            options: form.options.map((entry) =>
                              entry.key === option.key
                                ? { ...entry, code: event.currentTarget.value }
                                : entry,
                            ),
                          })
                        }
                      />
                    </s-grid>
                  </s-stack>
                </s-box>
              ))}
              <s-stack direction="inline">
                <s-button
                  variant="secondary"
                  onClick={() => {
                    nextOptionKey += 1;
                    patch({
                      options: [
                        ...form.options,
                        {
                          key: `new-${nextOptionKey}`,
                          code: "",
                          en: "",
                          si: "",
                        },
                      ],
                    });
                  }}
                >
                  Add option
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>
        ) : null}

        <s-section
          heading={`Used by ${countOf(usedBy.length, "product type")}`}
        >
          {usedBy.length === 0 ? (
            <s-text color="subdued">
              No product type has this attribute yet. Add it to one on the
              product types page.
            </s-text>
          ) : (
            <s-stack direction="block" gap="small-300">
              {usedBy.map((type) => (
                <s-link key={type.id} href={ATTRIBUTE_ROUTES.type(type.id)}>
                  {type.label}
                </s-link>
              ))}
            </s-stack>
          )}
        </s-section>

        <AdvancedSection
          summary={`${form.setId ? `In ${sets.find((set) => set.value === form.setId)?.label ?? "a set"}` : "In no set"} · ${form.key.trim() || "no Shopify field"} · ${SCOPE_LABEL[form.scope].toLowerCase()} · ${IMPLEMENTATION_LABEL[form.implementation].toLowerCase()}.`}
        >
          <s-stack direction="block" gap="base">
            <Dropdown
              name="setId"
              label="Attribute set"
              details="Changing the set adds or removes this attribute wherever the old and new sets are attached. Direct assignments stay."
              value={form.setId}
              options={setOptions}
              onChange={(setId) => patch({ setId })}
            />
            <s-text-field
              label="Shopify field"
              details="namespace.key, for example recharge.sail_size. Where a metafield definition would be created."
              value={form.key}
              onInput={(event) => patch({ key: event.currentTarget.value })}
              {...(keyLooksWrong
                ? {
                    error:
                      "A field key is namespace.key: letters, numbers, - and _, at least three characters each side of the dot.",
                  }
                : {})}
            />
            <s-grid
              gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr 1fr"
              gap="base"
            >
              <Dropdown
                name="scope"
                label="Applies to"
                value={form.scope}
                options={SCOPE_OPTIONS}
                onChange={(scope) => patch({ scope: scope as Scope })}
              />
              <Dropdown
                name="implementation"
                label="Field implementation"
                value={form.implementation}
                options={IMPLEMENTATION_OPTIONS}
                onChange={(implementation) =>
                  patch({ implementation: implementation as Implementation })
                }
              />
            </s-grid>
          </s-stack>
        </AdvancedSection>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
