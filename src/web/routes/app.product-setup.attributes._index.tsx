import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useSearchParams,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";
import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { workspaceState } from "~/domain/attributes/impact";
import { addAttribute } from "~/domain/attributes/mutations";
import { pathOf, typesUsing } from "~/domain/attributes/resolve";
import { starterSchema } from "~/domain/attributes/starter";
import {
  AttributeCreateModal,
  AttributeEditModal,
  editableAttribute,
} from "~/web/components/attribute-form";
import { ProductSetupNav } from "~/web/components/product-setup-nav";
import {
  PRODUCT_SETUP_ROUTES,
  countOf,
  formatLabel,
} from "~/web/lib/attributes";
import {
  attributeFormPayload,
  commitSchemaChange,
  newId,
  revisionFrom,
  type SchemaActionResult,
} from "~/web/lib/attributes.server";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";

/**
 * The attribute catalogue (docs/attributes.md § Screens): every reusable
 * definition, what format it has, where it is used and whether it has a
 * Shopify field. Editing and deleting happen in the attribute's own editor;
 * creating happens here, in one dialog, complete with options.
 */
const NEW_MODAL_ID = "new-attribute";
const EDIT_MODAL_ID = "edit-attribute";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const { schema, revision } = await getAttributeSchema(principal);

  return {
    revision,
    stage: workspaceState(schema).stage,
    hasTypes: schema.types.length > 0,
    attributes: schema.attributes
      .map((attribute) => {
        const usedBy = typesUsing(schema, attribute.id).length;
        return {
          id: attribute.id,
          name: attribute.name,
          key: attribute.key,
          format: formatLabel(attribute),
          usedBy,
          editable: editableAttribute(
            attribute,
            schema.valueLists.find((l) => l.id === attribute.valueListId)
              ?.items ?? [],
            usedBy,
          ),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    types: schema.types
      .map((type) => ({
        value: type.id,
        label: pathOf(schema, type.id).join(" › "),
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    sets: schema.sets
      .map((set) => ({ value: set.id, label: set.name }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
};

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<SchemaActionResult> => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const revision = revisionFrom(formData);
  const unreadable: SchemaActionResult = {
    ok: false,
    message: "The form could not be read. Reload the page and try again.",
  };

  if (intent === "create") {
    let json: unknown;
    try {
      json = JSON.parse(String(formData.get("form") ?? ""));
    } catch {
      return unreadable;
    }
    const parsed = attributeFormPayload.safeParse(json);
    if (!parsed.success) return unreadable;
    const input = parsed.data;
    const attachTo = String(formData.get("attachTo") ?? "");
    return commitSchemaChange(
      principal,
      revision,
      "attribute_schema.attribute.added",
      (schema) =>
        addAttribute(
          schema,
          {
            ...input,
            setId: input.setId || null,
            attachToTypeId: attachTo || null,
          },
          newId,
        ),
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
          ? { ok: true, schema: starterSchema(), message: "Example loaded." }
          : {
              ok: false,
              message:
                "There is already something here, so the example was not loaded.",
            },
      actor,
    );
  }

  return { ok: false, message: "Unknown action." };
};

export default function AttributeCatalogue() {
  const { revision, stage, hasTypes, attributes, types, sets } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing =
    attributes.find((attribute) => attribute.id === editingId)?.editable ??
    null;

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  const setQuery = (next: string) =>
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (next.trim() === "") params.delete("q");
        else params.set("q", next);
        return params;
      },
      { replace: true },
    );

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? attributes.filter((attribute) =>
        `${attribute.name} ${attribute.key} ${attribute.format}`
          .toLowerCase()
          .includes(needle),
      )
    : attributes;

  return (
    <s-page heading="Metafields">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-button
        slot="primary-action"
        variant="primary"
        command="--show"
        commandFor={NEW_MODAL_ID}
      >
        New attribute
      </s-button>

      <AttributeCreateModal
        id={NEW_MODAL_ID}
        revision={revision}
        sets={sets}
        types={types}
        preselectedTypeId={null}
      />
      <AttributeEditModal
        id={EDIT_MODAL_ID}
        revision={revision}
        sets={sets}
        attribute={editing}
      />

      <s-stack direction="block" gap="base">
        <ProductSetupNav current="attributes" />

        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {attributes.length === 0 ? (
          <s-section heading="No attributes yet">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                An attribute is one piece of information a product carries — a
                sail size, a volume, a skill level. Define each one once, then
                decide which product types need it.
              </s-paragraph>
              <s-stack direction="inline" gap="small-300">
                <s-button
                  variant="primary"
                  command="--show"
                  commandFor={NEW_MODAL_ID}
                >
                  New attribute
                </s-button>
                {stage === "empty" ? (
                  <s-button
                    onClick={() =>
                      fetcher.submit(
                        { intent: "starter", revision: String(revision) },
                        { method: "post" },
                      )
                    }
                    {...(busy ? { disabled: true, loading: true } : {})}
                  >
                    Start from the example
                  </s-button>
                ) : null}
                {!hasTypes && stage !== "empty" ? (
                  <s-button href={PRODUCT_SETUP_ROUTES.types}>
                    Add a product type first
                  </s-button>
                ) : null}
              </s-stack>
            </s-stack>
          </s-section>
        ) : (
          <s-section>
            <s-stack direction="block" gap="base">
              <s-search-field
                label="Search attributes"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search by name, format or Shopify field"
                value={query}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
              {shown.length === 0 ? (
                <s-text color="subdued">{`No attribute matches “${query.trim()}”.`}</s-text>
              ) : (
                <s-table variant="auto">
                  <s-table-header-row>
                    <s-table-header listSlot="primary">Name</s-table-header>
                    <s-table-header listSlot="secondary">Format</s-table-header>
                    <s-table-header listSlot="kicker">Used by</s-table-header>
                    <s-table-header listSlot="labeled">
                      Shopify field
                    </s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {shown.map((attribute) => (
                      <s-table-row key={attribute.id}>
                        <s-table-cell>
                          <s-link
                            command="--show"
                            commandFor={EDIT_MODAL_ID}
                            onClick={() => setEditingId(attribute.id)}
                          >
                            {attribute.name}
                          </s-link>
                        </s-table-cell>
                        <s-table-cell>{attribute.format}</s-table-cell>
                        <s-table-cell>
                          {attribute.usedBy === 0 ? (
                            <s-text color="subdued">Not used yet</s-text>
                          ) : (
                            countOf(attribute.usedBy, "product type")
                          )}
                        </s-table-cell>
                        <s-table-cell>
                          {attribute.key ? (
                            <s-text color="subdued">{attribute.key}</s-text>
                          ) : (
                            <s-badge tone="warning">Not mapped</s-badge>
                          )}
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              )}
            </s-stack>
          </s-section>
        )}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
