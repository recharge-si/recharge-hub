import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import {
  deleteAttribute,
  updateAttribute,
} from "~/domain/attributes/mutations";
import { attributeById, pathOf, typesUsing } from "~/domain/attributes/resolve";
import {
  AttributeFields,
  attributeFormErrors,
  serialiseAttributeForm,
  type AttributeFormValue,
} from "~/web/components/attribute-form";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { PRODUCT_SETUP_ROUTES, countOf } from "~/web/lib/attributes";
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
import { redirectWithin } from "~/web/lib/redirects";
import { useResetWhenSaved, useSaveBar } from "~/web/lib/use-save-bar";

/**
 * One attribute's shared definition (docs/attributes.md § Screens). A change
 * here applies everywhere the attribute is used; what each type requires of
 * it is decided on the product types page. Deleting it is the one action
 * that reaches every type, so it lives here and says how many.
 */
const SAVE_BAR_ID = "attribute-save-bar";
const DELETE_MODAL_ID = "delete-attribute";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const { schema, revision } = await getAttributeSchema(principal);
  const attribute = attributeById(schema, String(params.attributeId ?? ""));
  if (!attribute) throw new Response("Not found", { status: 404 });

  const list = schema.valueLists.find((l) => l.id === attribute.valueListId);
  const form: AttributeFormValue = {
    name: attribute.name,
    dataType: attribute.dataType,
    unit: attribute.unit,
    description: attribute.description,
    scope: attribute.scope,
    requiredDefault: attribute.requiredDefault,
    filterable: attribute.filterable,
    searchable: attribute.searchable,
    comparable: attribute.comparable,
    key: attribute.key,
    setId: attribute.setId ?? "",
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
  const unreadable: SchemaActionResult = {
    ok: false,
    message: "The form could not be read. Reload the page and try again.",
  };

  if (intent === "save") {
    let json: unknown;
    try {
      json = JSON.parse(String(formData.get("form") ?? ""));
    } catch {
      return unreadable;
    }
    const parsed = attributeFormPayload.safeParse(json);
    if (!parsed.success) return unreadable;
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
    // A dialog on another page deletes with `stay`; only the editor page
    // itself has nowhere left to be and goes back to the catalogue.
    if (result.ok && String(formData.get("stay") ?? "") !== "1")
      throw redirectWithin(request, PRODUCT_SETUP_ROUTES.attributes);
    return result;
  }

  return { ok: false, message: "Unknown action." };
};

function normalise(form: AttributeFormValue): string {
  return JSON.stringify(serialiseAttributeForm(form));
}

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

  const [form, setForm] = useState<AttributeFormValue>(saved);
  const [tried, setTried] = useState(false);
  const savedKey = normalise(saved);
  const reset = useCallback(() => {
    setForm(saved);
    setTried(false);
  }, [saved]);
  useResetWhenSaved(savedKey, reset);

  const dirty = normalise(form) !== savedKey;
  useSaveBar(SAVE_BAR_ID, dirty);

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  const errors = tried ? attributeFormErrors(form) : {};

  const save = () => {
    setTried(true);
    if (Object.keys(attributeFormErrors(form)).length > 0) return;
    fetcher.submit(
      {
        intent: "save",
        revision: String(revision),
        form: JSON.stringify(serialiseAttributeForm(form)),
      },
      { method: "post" },
    );
  };

  return (
    <s-page heading={saved.name}>
      <s-link slot="breadcrumb-actions" href={PRODUCT_SETUP_ROUTES.attributes}>
        Attributes
      </s-link>

      <s-button
        slot="secondary-actions"
        tone="critical"
        command="--show"
        commandFor={DELETE_MODAL_ID}
        {...(busy ? { disabled: true } : {})}
      >
        Delete attribute
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
          {usedBy.length === 0
            ? "It is not on any product type. It leaves the catalogue, with its options. This cannot be undone."
            : `It leaves the catalogue and ${countOf(usedBy.length, "product type")}, with every requirement change and removal about it. This cannot be undone.`}
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
          <s-banner tone="critical" heading="Not saved">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="Definition">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              Shared by every product type that has this attribute.
            </s-text>
            <AttributeFields
              value={form}
              onChange={setForm}
              errors={errors}
              sets={sets}
              mode="edit"
            />
            {tried && Object.keys(errors).length > 0 ? (
              <s-text tone="critical">
                {Object.keys(errors).length === 1
                  ? "One field above needs attention before this can be saved."
                  : `${Object.keys(errors).length} fields above need attention before this can be saved.`}
              </s-text>
            ) : null}
          </s-stack>
        </s-section>

        <s-section
          heading={
            usedBy.length === 0
              ? "Not on any product type"
              : `On ${countOf(usedBy.length, "product type")}`
          }
        >
          {usedBy.length === 0 ? (
            <s-stack direction="block" gap="small-300">
              <s-text color="subdued">
                Add it to a product type from that type&apos;s attributes.
              </s-text>
              <s-stack direction="inline">
                <s-button href={PRODUCT_SETUP_ROUTES.types}>
                  Product types
                </s-button>
              </s-stack>
            </s-stack>
          ) : (
            <s-stack direction="block" gap="small-300">
              {usedBy.map((type) => (
                <s-link key={type.id} href={PRODUCT_SETUP_ROUTES.type(type.id)}>
                  {type.label}
                </s-link>
              ))}
            </s-stack>
          )}
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
