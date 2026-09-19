import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useState } from "react";
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
  addSet,
  attachSet,
  deleteSet,
  detachSet,
  updateSet,
} from "~/domain/attributes/mutations";
import { pathOf } from "~/domain/attributes/resolve";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { Dropdown } from "~/web/components/dropdown";
import { ProductSetupNav } from "~/web/components/product-setup-nav";
import { PRODUCT_SETUP_ROUTES, countOf } from "~/web/lib/attributes";
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

/**
 * Attribute sets (docs/attributes.md § Screens): reusable bundles, what is
 * in each, and where each is attached. An attribute joins a set from its own
 * editor; a set reaches a type from here or from the type's picker.
 */
const NEW_MODAL_ID = "new-set";
const EDIT_MODAL_ID = "edit-set";
const DELETE_MODAL_ID = "delete-set";
const DETACH_MODAL_ID = "detach-set";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const { schema, revision } = await getAttributeSchema(principal);

  return {
    revision,
    hasAttributes: schema.attributes.length > 0,
    sets: schema.sets
      .map((set) => ({
        id: set.id,
        name: set.name,
        description: set.description,
        members: schema.attributes
          .filter((a) => a.setId === set.id)
          .map((a) => ({ id: a.id, name: a.name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        attachedTo: schema.setAssignments
          .filter((row) => row.setId === set.id)
          .map((row) => ({
            assignmentId: row.id,
            typeId: row.typeId,
            label: pathOf(schema, row.typeId).join(" › "),
          }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    typeOptions: schema.types
      .map((type) => ({
        value: type.id,
        label: pathOf(schema, type.id).join(" › "),
      }))
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
  const field = (name: string) => String(formData.get(name) ?? "");
  const commit = (
    event: string,
    change: Parameters<typeof commitSchemaChange>[3],
  ) => commitSchemaChange(principal, revision, event, change, actor);

  switch (intent) {
    case "add-set":
      return commit("attribute_schema.set.added", (schema) =>
        addSet(
          schema,
          { name: field("name"), description: field("description") },
          newId,
        ),
      );
    case "edit-set":
      return commit("attribute_schema.set.renamed", (schema) =>
        updateSet(schema, field("setId"), {
          name: field("name"),
          description: field("description"),
        }),
      );
    case "delete-set":
      return commit("attribute_schema.set.deleted", (schema) =>
        deleteSet(schema, field("setId"), newId),
      );
    case "attach-set":
      return commit("attribute_schema.set.attached", (schema) =>
        attachSet(schema, field("typeId"), field("setId"), newId),
      );
    case "detach-set":
      return commit("attribute_schema.set.detached", (schema) =>
        detachSet(schema, field("assignmentId")),
      );
    default:
      return { ok: false, message: "Unknown action." };
  }
};

interface SetDraft {
  id: string;
  name: string;
  description: string;
}

export default function AttributeSets() {
  const { revision, hasAttributes, sets, typeOptions } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;

  const [draft, setDraft] = useState<SetDraft>({
    id: "",
    name: "",
    description: "",
  });
  const [draftTried, setDraftTried] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<
    (typeof sets)[number] | null
  >(null);
  const [pendingDetach, setPendingDetach] = useState<{
    assignmentId: string;
    setName: string;
    typeLabel: string;
  } | null>(null);
  const [attach, setAttach] = useState({ typeId: "", setId: "" });

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  const submit = (fields: Record<string, string>) =>
    fetcher.submit(
      { ...fields, revision: String(revision) },
      { method: "post" },
    );

  const draftError =
    draftTried && draft.name.trim() === "" ? "Enter a name." : undefined;
  const setOptions = sets.map((set) => ({ value: set.id, label: set.name }));

  const setForm = (modalId: string, intent: "add-set" | "edit-set") => (
    <s-modal
      id={modalId}
      heading={
        intent === "add-set" ? "New attribute set" : "Edit attribute set"
      }
    >
      <s-stack direction="block" gap="base">
        <s-text-field
          label="Name"
          placeholder="Sail specifications"
          value={draft.name}
          onInput={(event) =>
            setDraft({ ...draft, name: event.currentTarget.value })
          }
          {...(draftError ? { error: draftError } : {})}
        />
        <s-text-field
          label="Description (optional)"
          value={draft.description}
          onInput={(event) =>
            setDraft({ ...draft, description: event.currentTarget.value })
          }
        />
        {intent === "add-set" ? (
          <s-text color="subdued">
            Attributes join a set from their own editor, under Advanced.
          </s-text>
        ) : null}
      </s-stack>
      <s-button
        slot="primary-action"
        variant="primary"
        {...(draft.name.trim() !== ""
          ? { command: "--hide", commandFor: modalId }
          : {})}
        onClick={() => {
          setDraftTried(true);
          if (draft.name.trim() === "") return;
          submit({
            intent,
            setId: draft.id,
            name: draft.name,
            description: draft.description,
          });
        }}
        {...(busy ? { disabled: true } : {})}
      >
        {intent === "add-set" ? "Create set" : "Save"}
      </s-button>
      <s-button slot="secondary-actions" command="--hide" commandFor={modalId}>
        Cancel
      </s-button>
    </s-modal>
  );

  return (
    <s-page heading="Product setup">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-button
        slot="primary-action"
        variant="primary"
        command="--show"
        commandFor={NEW_MODAL_ID}
        onClick={() => {
          setDraft({ id: "", name: "", description: "" });
          setDraftTried(false);
        }}
      >
        New set
      </s-button>

      {setForm(NEW_MODAL_ID, "add-set")}
      {setForm(EDIT_MODAL_ID, "edit-set")}

      <ConfirmModal
        id={DELETE_MODAL_ID}
        heading={`Delete the set “${pendingDelete?.name ?? ""}”?`}
        confirmLabel="Delete set"
        onConfirm={() => {
          if (pendingDelete)
            submit({ intent: "delete-set", setId: pendingDelete.id });
        }}
      >
        <s-paragraph>
          {pendingDelete
            ? pendingDelete.attachedTo.length === 0
              ? `Its ${countOf(pendingDelete.members.length, "attribute")} stay in the catalogue, no longer grouped. No product type changes.`
              : `Its ${countOf(pendingDelete.members.length, "attribute")} stay in the catalogue, and the ${countOf(pendingDelete.attachedTo.length, "product type")} it is attached to keep every one of them as direct assignments. No type loses a field.`
            : ""}
        </s-paragraph>
      </ConfirmModal>

      <ConfirmModal
        id={DETACH_MODAL_ID}
        heading={`Detach “${pendingDetach?.setName ?? ""}” from ${pendingDetach?.typeLabel ?? ""}?`}
        confirmLabel="Detach"
        onConfirm={() => {
          if (pendingDetach)
            submit({
              intent: "detach-set",
              assignmentId: pendingDetach.assignmentId,
            });
        }}
      >
        <s-paragraph>
          The type and every type beneath it lose the set&apos;s attributes,
          unless another source supplies them.
        </s-paragraph>
      </ConfirmModal>

      <s-stack direction="block" gap="base">
        <ProductSetupNav current="sets" />

        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {sets.length === 0 ? (
          <s-section heading="No attribute sets yet">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                A set bundles attributes so a product type takes them as one —
                sail specifications, board dimensions, clothing sizing. Attach a
                set to a type and every type beneath it gets every attribute in
                the set.
              </s-paragraph>
              <s-stack direction="inline" gap="small-300">
                <s-button
                  variant="primary"
                  command="--show"
                  commandFor={NEW_MODAL_ID}
                  onClick={() => {
                    setDraft({ id: "", name: "", description: "" });
                    setDraftTried(false);
                  }}
                >
                  New set
                </s-button>
                {!hasAttributes ? (
                  <s-button href={PRODUCT_SETUP_ROUTES.attributes}>
                    Define attributes first
                  </s-button>
                ) : null}
              </s-stack>
            </s-stack>
          </s-section>
        ) : (
          <s-section>
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Set</s-table-header>
                <s-table-header listSlot="secondary">Attributes</s-table-header>
                <s-table-header listSlot="labeled">Attached to</s-table-header>
                <s-table-header listSlot="inline">Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {sets.map((set) => (
                  <s-table-row key={set.id}>
                    <s-table-cell>
                      <s-stack direction="block" gap="small-500">
                        <s-text type="strong">{set.name}</s-text>
                        {set.description ? (
                          <s-text color="subdued">{set.description}</s-text>
                        ) : null}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      {set.members.length === 0 ? (
                        <s-text color="subdued">Empty</s-text>
                      ) : (
                        <s-text>
                          {set.members.map((m) => m.name).join(", ")}
                        </s-text>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      {set.attachedTo.length === 0 ? (
                        <s-text color="subdued">Not attached</s-text>
                      ) : (
                        <s-stack direction="block" gap="small-500">
                          {set.attachedTo.map((source) => (
                            <s-stack
                              key={source.assignmentId}
                              direction="inline"
                              gap="small-400"
                              alignItems="center"
                            >
                              <s-link
                                href={PRODUCT_SETUP_ROUTES.type(source.typeId)}
                              >
                                {source.label}
                              </s-link>
                              <s-button
                                variant="tertiary"
                                accessibilityLabel={`Detach ${set.name} from ${source.label}`}
                                command="--show"
                                commandFor={DETACH_MODAL_ID}
                                onClick={() =>
                                  setPendingDetach({
                                    assignmentId: source.assignmentId,
                                    setName: set.name,
                                    typeLabel: source.label,
                                  })
                                }
                                {...(busy ? { disabled: true } : {})}
                              >
                                Detach
                              </s-button>
                            </s-stack>
                          ))}
                        </s-stack>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        icon="menu-horizontal"
                        variant="tertiary"
                        accessibilityLabel={`Actions for ${set.name}`}
                        command="--show"
                        commandFor={`set-menu-${set.id}`}
                      />
                      <s-menu
                        id={`set-menu-${set.id}`}
                        accessibilityLabel={`Actions for ${set.name}`}
                      >
                        <s-button
                          command="--show"
                          commandFor={EDIT_MODAL_ID}
                          onClick={() => {
                            setDraft({
                              id: set.id,
                              name: set.name,
                              description: set.description,
                            });
                            setDraftTried(false);
                          }}
                        >
                          Edit
                        </s-button>
                        <s-button
                          tone="critical"
                          command="--show"
                          commandFor={DELETE_MODAL_ID}
                          onClick={() => setPendingDelete(set)}
                        >
                          Delete set
                        </s-button>
                      </s-menu>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-section>
        )}

        {sets.length > 0 && typeOptions.length > 0 ? (
          <s-section heading="Attach a set to a product type">
            <s-grid
              gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr 1fr auto"
              gap="base"
              alignItems="end"
            >
              <Dropdown
                name="setId"
                label="Attribute set"
                value={attach.setId}
                options={setOptions}
                onChange={(setId) => setAttach({ ...attach, setId })}
              />
              <Dropdown
                name="typeId"
                label="Product type"
                details="The type and every type beneath it."
                value={attach.typeId}
                options={typeOptions}
                onChange={(typeId) => setAttach({ ...attach, typeId })}
              />
              <s-button
                onClick={() => submit({ intent: "attach-set", ...attach })}
                {...(!attach.typeId || !attach.setId || busy
                  ? { disabled: true }
                  : {})}
              >
                Attach
              </s-button>
            </s-grid>
          </s-section>
        ) : null}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
