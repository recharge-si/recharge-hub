import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useRef, useState } from "react";
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
  clearRule,
  deleteSet,
  detachSet,
  updateSet,
} from "~/domain/attributes/mutations";
import { pathOf } from "~/domain/attributes/resolve";
import { parseAttributeSchema } from "~/domain/attributes/schema";
import { starterSchema } from "~/domain/attributes/starter";
import { emptySchema } from "~/domain/attributes/types";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { DownloadButton } from "~/web/components/download-button";
import { Dropdown } from "~/web/components/dropdown";
import { ATTRIBUTE_ROUTES, countOf } from "~/web/lib/attributes";
import {
  commitSchemaChange,
  newId,
  revisionFrom,
  type SchemaActionResult,
} from "~/web/lib/attributes.server";
import { formatDateTime } from "~/web/lib/datetime";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";

/**
 * Attribute settings (docs/attributes.md § Screens): the schema as a file,
 * the sets, the rules single types have made for themselves, and starting
 * again. Everything a person needs rarely, behind the page they use daily.
 */
const NEW_SET_MODAL_ID = "new-set";
const RENAME_SET_MODAL_ID = "rename-set";
const DELETE_SET_MODAL_ID = "delete-set";
const IMPORT_MODAL_ID = "import-schema";
const STARTER_MODAL_ID = "load-starter";
const CLEAR_MODAL_ID = "clear-schema";

const IMPORT_LIMIT = 5 * 1024 * 1024;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const { schema, revision, updatedAt } = await getAttributeSchema(principal);
  const attributeName = (id: string) =>
    schema.attributes.find((a) => a.id === id)?.name ?? "";

  return {
    revision,
    updatedAt: updatedAt?.toISOString() ?? null,
    empty: schema.types.length === 0 && schema.attributes.length === 0,
    counts: {
      types: schema.types.length,
      attributes: schema.attributes.length,
    },
    sets: schema.sets
      .map((set) => ({
        id: set.id,
        name: set.name,
        description: set.description,
        attributes: schema.attributes.filter((a) => a.setId === set.id).length,
        attachedTo: schema.setAssignments
          .filter((row) => row.setId === set.id)
          .map((row) => ({
            assignmentId: row.id,
            label: pathOf(schema, row.typeId).join(" › "),
          })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    typeOptions: schema.types
      .map((type) => ({
        value: type.id,
        label: pathOf(schema, type.id).join(" › "),
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    rules: [
      ...schema.overrides.map((row) => ({
        kind: "override" as const,
        id: row.id,
        type: pathOf(schema, row.typeId).join(" › "),
        attribute: attributeName(row.attributeId),
        what: row.required ? "Required here" : "Optional here",
        reason: row.reason,
      })),
      ...schema.exclusions.map((row) => ({
        kind: "exclusion" as const,
        id: row.id,
        type: pathOf(schema, row.typeId).join(" › "),
        attribute: attributeName(row.attributeId),
        what: "Removed here",
        reason: "",
      })),
    ].sort(
      (a, b) =>
        a.type.localeCompare(b.type) || a.attribute.localeCompare(b.attribute),
    ),
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
    case "import": {
      const text = field("file");
      if (text.length > IMPORT_LIMIT)
        return {
          ok: false,
          message: "A schema file must be smaller than 5 MB.",
        };
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return {
          ok: false,
          message:
            "The file is not JSON. Export a schema from this page or from the standalone builder and import that.",
        };
      }
      const parsed = parseAttributeSchema(raw);
      if (!parsed.ok)
        return {
          ok: false,
          message: `Import rejected, nothing changed. ${parsed.message}`,
        };
      return commit("attribute_schema.imported", () => ({
        ok: true,
        schema: parsed.schema,
        message: `Imported ${countOf(parsed.schema.types.length, "product type")} and ${countOf(parsed.schema.attributes.length, "attribute")}.`,
      }));
    }
    case "starter":
      return commit("attribute_schema.starter.loaded", () => ({
        ok: true,
        schema: starterSchema(),
        message: "Starter schema loaded.",
      }));
    case "clear":
      return commit("attribute_schema.cleared", () => ({
        ok: true,
        schema: emptySchema(),
        message: "Everything removed.",
      }));
    case "add-set":
      return commit("attribute_schema.set.added", (schema) =>
        addSet(
          schema,
          { name: field("name"), description: field("description") },
          newId,
        ),
      );
    case "rename-set":
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
    case "clear-rule": {
      const kind = field("kind");
      if (kind !== "override" && kind !== "exclusion")
        return { ok: false, message: "Unknown action." };
      return commit("attribute_schema.rule.cleared", (schema) =>
        clearRule(schema, kind, field("ruleId")),
      );
    }
    default:
      return { ok: false, message: "Unknown action." };
  }
};

export default function AttributeSettings() {
  const { revision, updatedAt, empty, counts, sets, typeOptions, rules } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;

  const fileInput = useRef<HTMLInputElement>(null);
  const [pendingImport, setPendingImport] = useState<{
    name: string;
    text: string;
  } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [newSet, setNewSet] = useState({ name: "", description: "" });
  const [renaming, setRenaming] = useState<{
    id: string;
    name: string;
    description: string;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    name: string;
    attributes: number;
    sources: number;
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

  const chooseFile = async (file: File | undefined) => {
    setImportError(null);
    if (!file) return;
    if (file.size > IMPORT_LIMIT) {
      setImportError("A schema file must be smaller than 5 MB.");
      return;
    }
    setPendingImport({ name: file.name, text: await file.text() });
    (
      document.getElementById(IMPORT_MODAL_ID) as {
        showOverlay?: () => void;
      } | null
    )?.showOverlay?.();
  };

  const setOptions = sets.map((set) => ({ value: set.id, label: set.name }));

  return (
    <s-page heading="Attribute settings">
      <s-link slot="breadcrumb-actions" href={ATTRIBUTE_ROUTES.index}>
        Attributes
      </s-link>

      <s-modal
        id={IMPORT_MODAL_ID}
        heading="Replace the schema with this file?"
      >
        <s-stack direction="block" gap="base">
          <s-paragraph>
            {`Everything planned here — ${countOf(counts.types, "product type")} and ${countOf(counts.attributes, "attribute")} — is replaced by what “${pendingImport?.name ?? ""}” holds. Export a backup first if you may want it back. The file is checked before anything changes.`}
          </s-paragraph>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          command="--hide"
          commandFor={IMPORT_MODAL_ID}
          onClick={() => {
            if (pendingImport)
              submit({ intent: "import", file: pendingImport.text });
            setPendingImport(null);
          }}
        >
          Replace
        </s-button>
        <s-button
          slot="secondary-actions"
          command="--hide"
          commandFor={IMPORT_MODAL_ID}
          onClick={() => setPendingImport(null)}
        >
          Keep it
        </s-button>
      </s-modal>

      <ConfirmModal
        id={STARTER_MODAL_ID}
        heading="Replace everything with the example?"
        confirmLabel="Replace"
        onConfirm={() => submit({ intent: "starter" })}
      >
        <s-paragraph>
          {`${countOf(counts.types, "product type")} and ${countOf(counts.attributes, "attribute")} are replaced by the small example of sails, boards and wetsuits. Export a backup first if you may want them back.`}
        </s-paragraph>
      </ConfirmModal>

      <ConfirmModal
        id={CLEAR_MODAL_ID}
        heading="Remove everything?"
        confirmLabel="Remove everything"
        onConfirm={() => submit({ intent: "clear" })}
      >
        <s-paragraph>
          {`${countOf(counts.types, "product type")}, ${countOf(counts.attributes, "attribute")} and every set and rule are removed. Nothing in Shopify changes. Export a backup first if you may want them back.`}
        </s-paragraph>
      </ConfirmModal>

      <s-modal id={NEW_SET_MODAL_ID} heading="New attribute set">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Name"
            placeholder="Sail specifications"
            value={newSet.name}
            onInput={(event) =>
              setNewSet({ ...newSet, name: event.currentTarget.value })
            }
          />
          <s-text-field
            label="Description"
            value={newSet.description}
            onInput={(event) =>
              setNewSet({ ...newSet, description: event.currentTarget.value })
            }
          />
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          command="--hide"
          commandFor={NEW_SET_MODAL_ID}
          {...(newSet.name.trim() === "" || busy ? { disabled: true } : {})}
          onClick={() => submit({ intent: "add-set", ...newSet })}
        >
          Create set
        </s-button>
        <s-button
          slot="secondary-actions"
          command="--hide"
          commandFor={NEW_SET_MODAL_ID}
        >
          Cancel
        </s-button>
      </s-modal>

      <s-modal id={RENAME_SET_MODAL_ID} heading="Edit attribute set">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Name"
            value={renaming?.name ?? ""}
            onInput={(event) =>
              setRenaming(
                renaming
                  ? { ...renaming, name: event.currentTarget.value }
                  : null,
              )
            }
          />
          <s-text-field
            label="Description"
            value={renaming?.description ?? ""}
            onInput={(event) =>
              setRenaming(
                renaming
                  ? { ...renaming, description: event.currentTarget.value }
                  : null,
              )
            }
          />
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          command="--hide"
          commandFor={RENAME_SET_MODAL_ID}
          {...(!renaming || renaming.name.trim() === "" || busy
            ? { disabled: true }
            : {})}
          onClick={() => {
            if (renaming)
              submit({
                intent: "rename-set",
                setId: renaming.id,
                name: renaming.name,
                description: renaming.description,
              });
          }}
        >
          Save
        </s-button>
        <s-button
          slot="secondary-actions"
          command="--hide"
          commandFor={RENAME_SET_MODAL_ID}
        >
          Cancel
        </s-button>
      </s-modal>

      <ConfirmModal
        id={DELETE_SET_MODAL_ID}
        heading={`Delete the set “${pendingDelete?.name ?? ""}”?`}
        confirmLabel="Delete set"
        onConfirm={() => {
          if (pendingDelete)
            submit({ intent: "delete-set", setId: pendingDelete.id });
        }}
      >
        <s-paragraph>
          {pendingDelete
            ? `Its ${countOf(pendingDelete.attributes, "attribute")} stay in the catalogue, and every type that had them through the set keeps them: each of its ${countOf(pendingDelete.sources, "source")} becomes direct assignments.`
            : ""}
        </s-paragraph>
      </ConfirmModal>

      <s-stack direction="block" gap="large">
        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="Import and export">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              {updatedAt
                ? `The whole plan as one file. Last changed ${formatDateTime(updatedAt)}.`
                : "The whole plan as one file. Nothing has been saved yet."}
            </s-text>
            <s-stack direction="inline" gap="small-300">
              <DownloadButton
                href={ATTRIBUTE_ROUTES.export}
                fallbackName="attributes.json"
                icon="export"
                disabled={empty}
              >
                Export JSON
              </DownloadButton>
              <s-button
                onClick={() => fileInput.current?.click()}
                {...(busy ? { disabled: true } : {})}
              >
                Import JSON
              </s-button>
              <input
                ref={fileInput}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(event) => {
                  void chooseFile(event.currentTarget.files?.[0]);
                  event.currentTarget.value = "";
                }}
              />
            </s-stack>
            {importError ? (
              <s-text tone="critical">{importError}</s-text>
            ) : null}
            <s-text color="subdued">
              A file exported here or from the standalone builder. It is checked
              whole before it replaces anything.
            </s-text>
          </s-stack>
        </s-section>

        <s-section heading="Attribute sets">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              A set bundles attributes so a product type takes them as one.
              Attaching a set to a type gives it, and every type beneath it,
              every attribute in the set.
            </s-text>
            {sets.length === 0 ? (
              <s-text color="subdued">No sets yet.</s-text>
            ) : (
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header listSlot="primary">Set</s-table-header>
                  <s-table-header listSlot="kicker">Attributes</s-table-header>
                  <s-table-header listSlot="secondary">
                    Attached to
                  </s-table-header>
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
                      <s-table-cell>{String(set.attributes)}</s-table-cell>
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
                                <s-text>{source.label}</s-text>
                                <s-button
                                  variant="tertiary"
                                  accessibilityLabel={`Detach ${set.name} from ${source.label}`}
                                  onClick={() =>
                                    submit({
                                      intent: "detach-set",
                                      assignmentId: source.assignmentId,
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
                        <s-stack direction="inline" gap="small-400">
                          <s-button
                            variant="tertiary"
                            command="--show"
                            commandFor={RENAME_SET_MODAL_ID}
                            onClick={() =>
                              setRenaming({
                                id: set.id,
                                name: set.name,
                                description: set.description,
                              })
                            }
                          >
                            Edit
                          </s-button>
                          <s-button
                            variant="tertiary"
                            tone="critical"
                            command="--show"
                            commandFor={DELETE_SET_MODAL_ID}
                            onClick={() =>
                              setPendingDelete({
                                id: set.id,
                                name: set.name,
                                attributes: set.attributes,
                                sources: set.attachedTo.length,
                              })
                            }
                            {...(busy ? { disabled: true } : {})}
                          >
                            Delete
                          </s-button>
                        </s-stack>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
            <s-stack direction="inline" gap="small-300">
              <s-button
                command="--show"
                commandFor={NEW_SET_MODAL_ID}
                onClick={() => setNewSet({ name: "", description: "" })}
              >
                New set
              </s-button>
            </s-stack>

            {sets.length > 0 && typeOptions.length > 0 ? (
              <>
                <s-divider />
                <s-text type="strong">Attach a set to a product type</s-text>
                <s-grid
                  gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr 1fr auto"
                  gap="base"
                  alignItems="end"
                >
                  <Dropdown
                    name="typeId"
                    label="Product type"
                    value={attach.typeId}
                    options={typeOptions}
                    onChange={(typeId) => setAttach({ ...attach, typeId })}
                  />
                  <Dropdown
                    name="setId"
                    label="Attribute set"
                    value={attach.setId}
                    options={setOptions}
                    onChange={(setId) => setAttach({ ...attach, setId })}
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
              </>
            ) : null}
          </s-stack>
        </s-section>

        <s-section heading="Decisions single types have made">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              A requirement changed or a field removed on one exact type. These
              pass to no descendant; resetting one returns the type to what it
              inherits.
            </s-text>
            {rules.length === 0 ? (
              <s-text color="subdued">
                None. Every type takes what it inherits.
              </s-text>
            ) : (
              rules.map((rule) => (
                <s-grid
                  key={`${rule.kind}-${rule.id}`}
                  gridTemplateColumns="1fr auto"
                  gap="small-300"
                  alignItems="center"
                >
                  <s-stack direction="block" gap="small-500">
                    <s-text>
                      {rule.type}
                      {" · "}
                      <s-text type="strong">{rule.attribute}</s-text>
                    </s-text>
                    <s-text color="subdued">
                      {rule.reason
                        ? `${rule.what} · ${rule.reason}`
                        : rule.what}
                    </s-text>
                  </s-stack>
                  <s-button
                    variant="tertiary"
                    accessibilityLabel={`Reset ${rule.attribute} on ${rule.type}`}
                    onClick={() =>
                      submit({
                        intent: "clear-rule",
                        kind: rule.kind,
                        ruleId: rule.id,
                      })
                    }
                    {...(busy ? { disabled: true } : {})}
                  >
                    Reset
                  </s-button>
                </s-grid>
              ))
            )}
          </s-stack>
        </s-section>

        <s-section heading="Start again">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              Either replaces the whole plan. Nothing in Shopify changes.
            </s-text>
            <s-stack direction="inline" gap="small-300">
              <s-button
                command="--show"
                commandFor={STARTER_MODAL_ID}
                {...(busy ? { disabled: true } : {})}
              >
                Replace with the example
              </s-button>
              <s-button
                tone="critical"
                command="--show"
                commandFor={CLEAR_MODAL_ID}
                {...(busy || empty ? { disabled: true } : {})}
              >
                Remove everything
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
