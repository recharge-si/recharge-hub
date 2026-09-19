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
  addType,
  attachAttribute,
  attachSet,
  deleteType,
  detachAttribute,
  detachSet,
  excludeAttribute,
  moveType,
  restoreAttribute,
  setRequirement,
  updateType,
} from "~/domain/attributes/mutations";
import {
  activeAttributes,
  ancestry,
  childrenOf,
  isWithin,
  pathOf,
  typeById,
} from "~/domain/attributes/resolve";
import type { AttributeSchema } from "~/domain/attributes/types";
import { Advanced } from "~/web/components/advanced";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { Dropdown } from "~/web/components/dropdown";
import {
  ATTRIBUTE_ROUTES,
  DATA_TYPE_LABEL,
  SCOPE_LABEL,
  countOf,
  describeAttribute,
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
 * Product types (docs/attributes.md § Screens): the tree on the left, the
 * selected type on the right — what it carries, where each field comes
 * from, and what this exact type decides differently.
 *
 * One route with an optional segment rather than a layout and a child: the
 * tree and the editor read one document and change it through one action,
 * and a change on either side moves the other.
 */
const SAVE_BAR_ID = "product-type-save-bar";
const HELP_MODAL_ID = "about-product-types";
const ADD_MODAL_ID = "add-product-type";
const PICKER_MODAL_ID = "add-attributes";
const DELETE_MODAL_ID = "delete-product-type";
const DETACH_MODAL_ID = "detach-source";

interface Details {
  name: string;
  parentId: string;
  leaf: boolean;
  shopifyCategory: string;
  archetype: string;
}

/** The tree flattened in display order, so the client only decides what to hide. */
function flatten(schema: AttributeSchema) {
  const rows: Array<{
    id: string;
    name: string;
    parentId: string | null;
    depth: number;
    count: number;
    hasChildren: boolean;
    path: string;
  }> = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const type of childrenOf(schema, parentId)) {
      rows.push({
        id: type.id,
        name: type.name,
        parentId,
        depth,
        count: activeAttributes(schema, type.id).length,
        hasChildren: childrenOf(schema, type.id).length > 0,
        path: pathOf(schema, type.id).join(" › ").toLowerCase(),
      });
      walk(type.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

function describeSelected(schema: AttributeSchema, typeId: string) {
  const type = typeById(schema, typeId);
  if (!type) return null;
  const nameOf = (id: string) => typeById(schema, id)?.name ?? "";
  const chain = ancestry(schema, typeId);
  const rows = activeAttributes(schema, typeId);
  const excludedIds = new Set(
    schema.exclusions
      .filter((row) => row.typeId === typeId)
      .map((row) => row.attributeId),
  );
  const activeIds = new Set(rows.map((row) => row.attribute.id));
  const setsHere = new Set(
    schema.setAssignments
      .filter((row) => row.typeId === typeId)
      .map((row) => row.setId),
  );

  return {
    id: type.id,
    name: type.name,
    path: pathOf(schema, typeId),
    details: {
      name: type.name,
      parentId: type.parentId ?? "",
      leaf: type.leaf,
      shopifyCategory: type.shopifyCategory,
      archetype: type.archetype,
    } satisfies Details,
    required: rows.filter((row) => row.required).length,
    rows: rows.map((row) => ({
      attributeId: row.attribute.id,
      name: row.attribute.name,
      detail: describeAttribute(row.attribute),
      sourceTypeId: row.sourceTypeId,
      sourceName: nameOf(row.sourceTypeId),
      here: row.sourceTypeId === typeId,
      required: row.required,
      overridden: row.override !== null,
    })),
    removed: schema.exclusions
      .filter((row) => row.typeId === typeId)
      .map((row) => ({
        attributeId: row.attributeId,
        name:
          schema.attributes.find((a) => a.id === row.attributeId)?.name ?? "",
      })),
    setSources: schema.setAssignments
      .filter((row) => chain.includes(row.typeId))
      .map((row) => ({
        assignmentId: row.id,
        name: schema.sets.find((set) => set.id === row.setId)?.name ?? "",
        typeId: row.typeId,
        typeName: nameOf(row.typeId),
        here: row.typeId === typeId,
      })),
    attributeSources: schema.attributeAssignments
      .filter((row) => chain.includes(row.typeId))
      .map((row) => ({
        assignmentId: row.id,
        name:
          schema.attributes.find((a) => a.id === row.attributeId)?.name ?? "",
        typeId: row.typeId,
        typeName: nameOf(row.typeId),
        here: row.typeId === typeId,
      })),
    preview: rows.map((row) => ({
      attributeId: row.attribute.id,
      name: row.attribute.name,
      key: row.attribute.key,
      type: `${DATA_TYPE_LABEL[row.attribute.dataType]} / ${SCOPE_LABEL[row.attribute.scope]}`,
      required: row.required,
    })),
    picker: {
      sets: schema.sets
        .map((set) => ({
          id: set.id,
          name: set.name,
          members: schema.attributes
            .filter((a) => a.setId === set.id)
            .map((a) => a.name)
            .join(", "),
          attachedHere: setsHere.has(set.id),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      attributes: schema.attributes
        .map((attribute) => ({
          id: attribute.id,
          name: attribute.name,
          type: DATA_TYPE_LABEL[attribute.dataType],
          state: activeIds.has(attribute.id)
            ? ("added" as const)
            : excludedIds.has(attribute.id)
              ? ("removed" as const)
              : ("available" as const),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    },
    parentOptions: [
      { value: "", label: "— Top level —" },
      ...schema.types
        .filter((candidate) => !isWithin(schema, candidate.id, typeId))
        .map((candidate) => ({
          value: candidate.id,
          label: pathOf(schema, candidate.id).join(" › "),
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ],
    isFirst: childrenOf(schema, type.parentId)[0]?.id === typeId,
    isLast: childrenOf(schema, type.parentId).at(-1)?.id === typeId,
  };
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const { schema, revision } = await getAttributeSchema(principal);
  const tree = flatten(schema);

  const typeId = params.typeId ?? null;
  if (typeId === null && tree.length > 0) {
    throw redirectWithin(request, ATTRIBUTE_ROUTES.type(tree[0]?.id ?? ""));
  }
  const selected = typeId === null ? null : describeSelected(schema, typeId);
  if (typeId !== null && selected === null) {
    throw new Response("Not found", { status: 404 });
  }

  return {
    revision,
    tree,
    selected,
    allParentOptions: [
      { value: "", label: "— Top level —" },
      ...schema.types
        .map((type) => ({
          value: type.id,
          label: pathOf(schema, type.id).join(" › "),
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ],
  };
};

const addForm = z.object({
  name: z.string(),
  parentId: z.string(),
  leaf: z.enum(["on", "off"]),
  shopifyCategory: z.string(),
});

const detailsForm = z.object({
  name: z.string(),
  parentId: z.string(),
  leaf: z.boolean(),
  shopifyCategory: z.string(),
  archetype: z.string(),
});

export const action = async ({
  request,
  params,
}: ActionFunctionArgs): Promise<SchemaActionResult> => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);
  const typeId = String(params.typeId ?? "");
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const revision = revisionFrom(formData);
  const field = (name: string) => String(formData.get(name) ?? "");
  const unreadable: SchemaActionResult = {
    ok: false,
    message: "The form could not be read. Reload the page and try again.",
  };

  const commit = (
    event: string,
    change: Parameters<typeof commitSchemaChange>[3],
  ) => commitSchemaChange(principal, revision, event, change, actor);

  switch (intent) {
    case "add-type": {
      const parsed = addForm.safeParse(Object.fromEntries(formData.entries()));
      if (!parsed.success) return unreadable;
      let createdId: string | null = null;
      const result = await commit("attribute_schema.type.added", (schema) => {
        const outcome = addType(
          schema,
          {
            name: parsed.data.name,
            parentId: parsed.data.parentId || null,
            leaf: parsed.data.leaf === "on",
            shopifyCategory: parsed.data.shopifyCategory,
          },
          newId,
        );
        createdId = outcome.typeId ?? null;
        return outcome;
      });
      if (result.ok && createdId !== null)
        throw redirectWithin(request, ATTRIBUTE_ROUTES.type(createdId));
      return result;
    }
    case "save-details": {
      let json: unknown;
      try {
        json = JSON.parse(field("form"));
      } catch {
        return unreadable;
      }
      const parsed = detailsForm.safeParse(json);
      if (!parsed.success) return unreadable;
      return commit("attribute_schema.type.saved", (schema) =>
        updateType(schema, typeId, {
          ...parsed.data,
          parentId: parsed.data.parentId || null,
        }),
      );
    }
    case "delete-type": {
      const current = await getAttributeSchema(principal);
      const parentId = typeById(current.schema, typeId)?.parentId ?? null;
      const result = await commit("attribute_schema.type.deleted", (schema) =>
        deleteType(schema, typeId),
      );
      if (result.ok)
        throw redirectWithin(
          request,
          parentId === null
            ? ATTRIBUTE_ROUTES.types
            : ATTRIBUTE_ROUTES.type(parentId),
        );
      return result;
    }
    case "move-up":
    case "move-down":
      return commit("attribute_schema.type.moved", (schema) =>
        moveType(schema, typeId, intent === "move-up" ? "up" : "down"),
      );
    case "attach-set":
      return commit("attribute_schema.set.attached", (schema) =>
        attachSet(schema, typeId, field("setId"), newId),
      );
    case "detach-set":
      return commit("attribute_schema.set.detached", (schema) =>
        detachSet(schema, field("assignmentId")),
      );
    case "attach-attribute":
      return commit("attribute_schema.attribute.attached", (schema) =>
        attachAttribute(schema, typeId, field("attributeId"), newId),
      );
    case "detach-attribute":
      return commit("attribute_schema.attribute.detached", (schema) =>
        detachAttribute(schema, field("assignmentId")),
      );
    case "set-requirement": {
      const value = field("value");
      if (value !== "required" && value !== "optional" && value !== "reset")
        return unreadable;
      return commit("attribute_schema.requirement.changed", (schema) =>
        setRequirement(schema, typeId, field("attributeId"), value, newId),
      );
    }
    case "remove":
      return commit("attribute_schema.attribute.removed_here", (schema) =>
        excludeAttribute(schema, typeId, field("attributeId"), newId),
      );
    case "restore":
      return commit("attribute_schema.attribute.restored_here", (schema) =>
        restoreAttribute(schema, typeId, field("attributeId"), newId),
      );
    default:
      return { ok: false, message: "Unknown action." };
  }
};

function normalise(details: Details): string {
  return JSON.stringify({
    ...details,
    name: details.name.trim(),
    shopifyCategory: details.shopifyCategory.trim(),
    archetype: details.archetype.trim(),
  });
}

const BLANK_TYPE = { name: "", parentId: "", leaf: true, shopifyCategory: "" };

export default function ProductTypes() {
  const { revision, tree, selected, allParentOptions } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;

  const [treeQuery, setTreeQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [fieldQuery, setFieldQuery] = useState("");
  const [requirementFilter, setRequirementFilter] = useState("all");
  const [pickerQuery, setPickerQuery] = useState("");
  const [newType, setNewType] = useState(BLANK_TYPE);
  const [pendingDetach, setPendingDetach] = useState<{
    kind: "set" | "attribute";
    assignmentId: string;
    name: string;
  } | null>(null);

  const savedDetails = selected?.details ?? null;
  const [details, setDetails] = useState<Details | null>(savedDetails);
  const savedKey = savedDetails ? normalise(savedDetails) : "";
  const reset = useCallback(() => setDetails(savedDetails), [savedDetails]);
  useResetWhenSaved(`${selected?.id ?? ""}:${savedKey}`, reset);

  const dirty =
    details !== null &&
    savedDetails !== null &&
    normalise(details) !== savedKey;
  useSaveBar(SAVE_BAR_ID, dirty);

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  const submit = (fields: Record<string, string>) =>
    fetcher.submit(
      { ...fields, revision: String(revision) },
      { method: "post" },
    );

  const saveDetails = () => {
    if (!details) return;
    submit({ intent: "save-details", form: JSON.stringify(details) });
  };

  // Which tree rows to show: a search shows every match and its ancestors,
  // with nothing collapsed; otherwise a collapsed row hides its descendants.
  const needle = treeQuery.trim().toLowerCase();
  const visibleIds = new Set<string>();
  if (needle) {
    const byId = new Map(tree.map((row) => [row.id, row]));
    for (const row of tree) {
      if (!row.path.includes(needle)) continue;
      let current: string | null = row.id;
      while (current !== null && !visibleIds.has(current)) {
        visibleIds.add(current);
        current = byId.get(current)?.parentId ?? null;
      }
    }
  } else {
    const hidden = new Set<string>();
    for (const row of tree) {
      if (
        row.parentId !== null &&
        (hidden.has(row.parentId) || collapsed[row.parentId])
      )
        hidden.add(row.id);
      else visibleIds.add(row.id);
    }
  }

  const fieldNeedle = fieldQuery.trim().toLowerCase();
  const rows = (selected?.rows ?? []).filter(
    (row) =>
      `${row.name} ${row.detail}`.toLowerCase().includes(fieldNeedle) &&
      (requirementFilter === "all" ||
        (requirementFilter === "required") === row.required),
  );
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = groups.get(row.sourceTypeId) ?? [];
    group.push(row);
    groups.set(row.sourceTypeId, group);
  }

  const pickerNeedle = pickerQuery.trim().toLowerCase();

  return (
    <s-page heading="Product types">
      <s-link slot="breadcrumb-actions" href={ATTRIBUTE_ROUTES.index}>
        Attributes
      </s-link>

      <s-button
        slot="primary-action"
        variant="primary"
        command="--show"
        commandFor={ADD_MODAL_ID}
        onClick={() =>
          setNewType({ ...BLANK_TYPE, parentId: selected?.id ?? "" })
        }
      >
        Add product type
      </s-button>
      <s-button
        slot="secondary-actions"
        icon="question-circle"
        command="--show"
        commandFor={HELP_MODAL_ID}
      >
        Help
      </s-button>

      <s-modal id={HELP_MODAL_ID} heading="About product types">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Product types form a tree. A category organises; a type products can
            use is what a product is assigned to. Attach an attribute set or a
            single attribute to any type and every type beneath it gets it too.
          </s-paragraph>
          <s-paragraph>
            What one type decides differently — a field required here, a field
            removed here — stays on that exact type and passes to none of its
            descendants.
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

      <s-modal id={ADD_MODAL_ID} heading="Add product type">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Name"
            placeholder="Freeride sails"
            value={newType.name}
            onInput={(event) =>
              setNewType({ ...newType, name: event.currentTarget.value })
            }
          />
          <Dropdown
            name="parentId"
            label="Under"
            value={newType.parentId}
            options={allParentOptions}
            onChange={(parentId) => setNewType({ ...newType, parentId })}
          />
          <s-checkbox
            label="Products can use this type"
            details="Off makes it a category that only organises the types beneath it."
            checked={newType.leaf}
            onChange={(event) =>
              setNewType({ ...newType, leaf: event.currentTarget.checked })
            }
          />
          <s-text-field
            label="Shopify category"
            details="Planning only; nothing is set in Shopify."
            value={newType.shopifyCategory}
            onInput={(event) =>
              setNewType({
                ...newType,
                shopifyCategory: event.currentTarget.value,
              })
            }
          />
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          command="--hide"
          commandFor={ADD_MODAL_ID}
          {...(newType.name.trim() === "" || busy ? { disabled: true } : {})}
          onClick={() =>
            submit({
              intent: "add-type",
              name: newType.name,
              parentId: newType.parentId,
              leaf: newType.leaf ? "on" : "off",
              shopifyCategory: newType.shopifyCategory,
            })
          }
        >
          Add product type
        </s-button>
        <s-button
          slot="secondary-actions"
          command="--hide"
          commandFor={ADD_MODAL_ID}
        >
          Cancel
        </s-button>
      </s-modal>

      {selected ? (
        <>
          <s-modal
            id={PICKER_MODAL_ID}
            heading={`Add attributes to ${selected.name}`}
          >
            <s-stack direction="block" gap="base">
              <s-text color="subdued">
                A set or an attribute added here reaches this type and every
                type beneath it. Restoring a removed attribute affects this type
                alone.
              </s-text>
              <s-search-field
                label="Search sets and attributes"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search"
                value={pickerQuery}
                onInput={(event) => setPickerQuery(event.currentTarget.value)}
              />
              <s-text type="strong">Sets</s-text>
              {selected.picker.sets
                .filter((set) =>
                  `${set.name} ${set.members}`
                    .toLowerCase()
                    .includes(pickerNeedle),
                )
                .map((set) => (
                  <s-grid
                    key={set.id}
                    gridTemplateColumns="1fr auto"
                    gap="base"
                    alignItems="center"
                  >
                    <s-stack direction="block" gap="small-500">
                      <s-text type="strong">{set.name}</s-text>
                      <s-text color="subdued">
                        {set.members || "Empty set"}
                      </s-text>
                    </s-stack>
                    <s-button
                      onClick={() =>
                        submit({ intent: "attach-set", setId: set.id })
                      }
                      {...(set.attachedHere || busy ? { disabled: true } : {})}
                    >
                      {set.attachedHere ? "Attached here" : "Add set"}
                    </s-button>
                  </s-grid>
                ))}
              {selected.picker.sets.length === 0 ? (
                <s-text color="subdued">No sets yet.</s-text>
              ) : null}
              <s-text type="strong">Attributes</s-text>
              {selected.picker.attributes
                .filter((attribute) =>
                  attribute.name.toLowerCase().includes(pickerNeedle),
                )
                .map((attribute) => (
                  <s-grid
                    key={attribute.id}
                    gridTemplateColumns="1fr auto"
                    gap="base"
                    alignItems="center"
                  >
                    <s-stack direction="block" gap="small-500">
                      <s-text type="strong">{attribute.name}</s-text>
                      <s-text color="subdued">{attribute.type}</s-text>
                    </s-stack>
                    <s-button
                      onClick={() =>
                        submit({
                          intent:
                            attribute.state === "removed"
                              ? "restore"
                              : "attach-attribute",
                          attributeId: attribute.id,
                        })
                      }
                      {...(attribute.state === "added" || busy
                        ? { disabled: true }
                        : {})}
                    >
                      {attribute.state === "added"
                        ? "Added"
                        : attribute.state === "removed"
                          ? "Restore"
                          : "Add"}
                    </s-button>
                  </s-grid>
                ))}
              {selected.picker.attributes.length === 0 ? (
                <s-text color="subdued">No attributes yet.</s-text>
              ) : null}
            </s-stack>
            <s-button
              slot="primary-action"
              variant="primary"
              command="--hide"
              commandFor={PICKER_MODAL_ID}
            >
              Done
            </s-button>
            <s-button slot="secondary-actions" href={ATTRIBUTE_ROUTES.index}>
              New attribute
            </s-button>
          </s-modal>

          <ConfirmModal
            id={DELETE_MODAL_ID}
            heading={`Delete “${selected.name}”?`}
            confirmLabel="Delete"
            onConfirm={() => submit({ intent: "delete-type" })}
          >
            <s-paragraph>
              Its child types move up one level. Sets and attributes attached
              here, and every requirement change and removal made here, go with
              it, so types beneath it may lose fields. This cannot be undone.
            </s-paragraph>
          </ConfirmModal>

          <ConfirmModal
            id={DETACH_MODAL_ID}
            heading={`Detach “${pendingDetach?.name ?? ""}”?`}
            confirmLabel="Detach"
            onConfirm={() => {
              if (!pendingDetach) return;
              submit({
                intent:
                  pendingDetach.kind === "set"
                    ? "detach-set"
                    : "detach-attribute",
                assignmentId: pendingDetach.assignmentId,
              });
            }}
          >
            <s-paragraph>
              Types beneath this one that inherit it lose it too. Fields
              supplied by another source stay. To hide a field on this type
              alone, remove it instead.
            </s-paragraph>
          </ConfirmModal>

          <ui-save-bar id={SAVE_BAR_ID}>
            <button
              variant="primary"
              onClick={saveDetails}
              {...(busy ? { loading: "" } : {})}
            >
              Save
            </button>
            <button onClick={reset}>Discard</button>
          </ui-save-bar>
        </>
      ) : null}

      <s-stack direction="block" gap="large">
        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {tree.length === 0 ? (
          <s-section heading="No product types yet">
            <s-paragraph>
              Add the first product type, or start from the example on the
              attributes page.
            </s-paragraph>
          </s-section>
        ) : (
          <s-grid
            gridTemplateColumns="@container (inline-size <= 720px) 1fr, minmax(240px, 300px) minmax(0, 1fr)"
            gap="base"
            alignItems="start"
          >
            <s-section heading="Types">
              <s-stack direction="block" gap="small-300">
                <s-search-field
                  label="Search product types"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="Search"
                  value={treeQuery}
                  onInput={(event) => setTreeQuery(event.currentTarget.value)}
                />
                <s-text color="subdued">Numbers are active attributes.</s-text>
                {tree.filter((row) => visibleIds.has(row.id)).length === 0 ? (
                  <s-text color="subdued">No product type matches.</s-text>
                ) : null}
                {tree
                  .filter((row) => visibleIds.has(row.id))
                  .map((row) => (
                    <s-box
                      key={row.id}
                      paddingInlineStart={
                        row.depth === 0
                          ? "none"
                          : row.depth === 1
                            ? "base"
                            : row.depth === 2
                              ? "large-200"
                              : "large-500"
                      }
                    >
                      <s-grid
                        gridTemplateColumns="auto 1fr"
                        gap="small-500"
                        alignItems="center"
                      >
                        {row.hasChildren ? (
                          <s-button
                            variant="tertiary"
                            icon={
                              collapsed[row.id] && !needle
                                ? "chevron-right"
                                : "chevron-down"
                            }
                            accessibilityLabel={`${collapsed[row.id] ? "Expand" : "Collapse"} ${row.name}`}
                            {...(needle ? { disabled: true } : {})}
                            onClick={() =>
                              setCollapsed({
                                ...collapsed,
                                [row.id]: !collapsed[row.id],
                              })
                            }
                          />
                        ) : (
                          <s-box inlineSize="28px" />
                        )}
                        <s-clickable
                          href={ATTRIBUTE_ROUTES.type(row.id)}
                          borderRadius="base"
                          paddingInline="small-300"
                          paddingBlock="small-400"
                          inlineSize="100%"
                          background={
                            selected?.id === row.id ? "subdued" : "transparent"
                          }
                          accessibilityLabel={`${row.name}, ${countOf(row.count, "attribute")}`}
                        >
                          <s-grid
                            gridTemplateColumns="1fr auto"
                            gap="small-300"
                            alignItems="center"
                          >
                            <s-text
                              {...(selected?.id === row.id
                                ? { type: "strong" as const }
                                : {})}
                            >
                              {row.name}
                            </s-text>
                            <s-text color="subdued">{String(row.count)}</s-text>
                          </s-grid>
                        </s-clickable>
                      </s-grid>
                    </s-box>
                  ))}
              </s-stack>
            </s-section>

            {selected && details ? (
              <s-stack direction="block" gap="base">
                <s-section heading={selected.name}>
                  <s-stack direction="block" gap="base">
                    <s-stack direction="block" gap="small-500">
                      <s-text color="subdued">
                        {selected.path.join(" › ")}
                      </s-text>
                      <s-text>
                        {`${countOf(selected.rows.length, "attribute")} · ${selected.required} required · ${selected.rows.length - selected.required} optional`}
                      </s-text>
                    </s-stack>
                    <s-stack direction="inline" gap="small-300">
                      <s-button
                        command="--show"
                        commandFor={ADD_MODAL_ID}
                        onClick={() =>
                          setNewType({ ...BLANK_TYPE, parentId: selected.id })
                        }
                      >
                        Add child
                      </s-button>
                      <s-button
                        onClick={() => submit({ intent: "move-up" })}
                        {...(selected.isFirst || busy
                          ? { disabled: true }
                          : {})}
                      >
                        Move up
                      </s-button>
                      <s-button
                        onClick={() => submit({ intent: "move-down" })}
                        {...(selected.isLast || busy ? { disabled: true } : {})}
                      >
                        Move down
                      </s-button>
                      <s-button
                        tone="critical"
                        command="--show"
                        commandFor={DELETE_MODAL_ID}
                        {...(busy ? { disabled: true } : {})}
                      >
                        Delete
                      </s-button>
                    </s-stack>
                  </s-stack>
                </s-section>

                <s-section heading="Attributes">
                  <s-stack direction="block" gap="base">
                    <s-grid
                      gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr 160px auto"
                      gap="small-300"
                      alignItems="end"
                    >
                      <s-search-field
                        label="Find an attribute"
                        labelAccessibilityVisibility="exclusive"
                        placeholder="Find an attribute"
                        value={fieldQuery}
                        onInput={(event) =>
                          setFieldQuery(event.currentTarget.value)
                        }
                      />
                      <Dropdown
                        name="requirementFilter"
                        label="Show"
                        hideLabel
                        value={requirementFilter}
                        options={[
                          { value: "all", label: "All fields" },
                          { value: "required", label: "Required" },
                          { value: "optional", label: "Optional" },
                        ]}
                        onChange={setRequirementFilter}
                      />
                      <s-button
                        variant="primary"
                        command="--show"
                        commandFor={PICKER_MODAL_ID}
                        onClick={() => setPickerQuery("")}
                      >
                        Add attributes
                      </s-button>
                    </s-grid>
                    <s-text color="subdued">
                      {`A requirement changed or a field removed here affects only ${selected.name}; other types and its descendants stay as they are.`}
                    </s-text>

                    {rows.length === 0 ? (
                      <s-text color="subdued">
                        {selected.rows.length === 0
                          ? "No attributes yet. Add a set or an attribute."
                          : "No attribute matches."}
                      </s-text>
                    ) : null}

                    {[...groups.entries()].map(([sourceTypeId, group]) => (
                      <s-stack
                        key={sourceTypeId}
                        direction="block"
                        gap="small-300"
                      >
                        <s-text type="strong">
                          {sourceTypeId === selected.id
                            ? "Added here"
                            : `From ${group[0]?.sourceName ?? ""}`}
                        </s-text>
                        {group.map((row) => (
                          <s-box
                            key={row.attributeId}
                            padding="small-300"
                            borderRadius="base"
                            borderWidth="base"
                            borderStyle="solid"
                            borderColor="subdued"
                          >
                            <s-grid
                              gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr 140px auto"
                              gap="small-300"
                              alignItems="center"
                            >
                              <s-stack direction="block" gap="small-500">
                                <s-link
                                  href={ATTRIBUTE_ROUTES.attribute(
                                    row.attributeId,
                                  )}
                                >
                                  {row.name}
                                </s-link>
                                <s-text color="subdued">
                                  {row.overridden
                                    ? `${row.detail} · changed here`
                                    : row.detail}
                                </s-text>
                              </s-stack>
                              <Dropdown
                                name={`requirement-${row.attributeId}`}
                                label={`Requirement for ${row.name}`}
                                hideLabel
                                value={row.required ? "required" : "optional"}
                                options={[
                                  { value: "required", label: "Required" },
                                  { value: "optional", label: "Optional" },
                                ]}
                                disabled={busy}
                                onChange={(value) =>
                                  submit({
                                    intent: "set-requirement",
                                    attributeId: row.attributeId,
                                    value,
                                  })
                                }
                              />
                              <s-stack direction="inline" gap="small-400">
                                {row.overridden ? (
                                  <s-button
                                    variant="tertiary"
                                    accessibilityLabel={`Reset the requirement of ${row.name}`}
                                    onClick={() =>
                                      submit({
                                        intent: "set-requirement",
                                        attributeId: row.attributeId,
                                        value: "reset",
                                      })
                                    }
                                    {...(busy ? { disabled: true } : {})}
                                  >
                                    Reset
                                  </s-button>
                                ) : null}
                                <s-button
                                  variant="tertiary"
                                  tone="critical"
                                  accessibilityLabel={`Remove ${row.name} from ${selected.name}`}
                                  onClick={() =>
                                    submit({
                                      intent: "remove",
                                      attributeId: row.attributeId,
                                    })
                                  }
                                  {...(busy ? { disabled: true } : {})}
                                >
                                  Remove
                                </s-button>
                              </s-stack>
                            </s-grid>
                          </s-box>
                        ))}
                      </s-stack>
                    ))}

                    {selected.removed.length > 0 ? (
                      <s-stack direction="block" gap="small-300">
                        <s-divider />
                        <s-text type="strong">
                          {`Removed from this type (${selected.removed.length})`}
                        </s-text>
                        {selected.removed.map((row) => (
                          <s-grid
                            key={row.attributeId}
                            gridTemplateColumns="1fr auto"
                            gap="small-300"
                            alignItems="center"
                          >
                            <s-text>{row.name}</s-text>
                            <s-button
                              onClick={() =>
                                submit({
                                  intent: "restore",
                                  attributeId: row.attributeId,
                                })
                              }
                              {...(busy ? { disabled: true } : {})}
                            >
                              Restore
                            </s-button>
                          </s-grid>
                        ))}
                      </s-stack>
                    ) : null}

                    <s-divider />
                    <s-stack direction="block" gap="small-300">
                      <s-text type="strong">
                        Where its attributes come from
                      </s-text>
                      <s-text color="subdued">
                        Detaching a source changes this type and its
                        descendants. Removing a field above hides it on this
                        type alone.
                      </s-text>
                      {selected.setSources.length === 0 &&
                      selected.attributeSources.length === 0 ? (
                        <s-text color="subdued">No sources yet.</s-text>
                      ) : null}
                      {selected.setSources.map((source) => (
                        <s-grid
                          key={source.assignmentId}
                          gridTemplateColumns="1fr auto"
                          gap="small-300"
                          alignItems="center"
                        >
                          <s-stack direction="block" gap="small-500">
                            <s-text type="strong">{source.name}</s-text>
                            <s-text color="subdued">
                              {source.here
                                ? "Set attached here"
                                : `Set attached on ${source.typeName}`}
                            </s-text>
                          </s-stack>
                          {source.here ? (
                            <s-button
                              variant="tertiary"
                              tone="critical"
                              command="--show"
                              commandFor={DETACH_MODAL_ID}
                              onClick={() =>
                                setPendingDetach({
                                  kind: "set",
                                  assignmentId: source.assignmentId,
                                  name: source.name,
                                })
                              }
                              {...(busy ? { disabled: true } : {})}
                            >
                              Detach
                            </s-button>
                          ) : (
                            <s-link href={ATTRIBUTE_ROUTES.type(source.typeId)}>
                              Go to source
                            </s-link>
                          )}
                        </s-grid>
                      ))}
                      {selected.attributeSources.map((source) => (
                        <s-grid
                          key={source.assignmentId}
                          gridTemplateColumns="1fr auto"
                          gap="small-300"
                          alignItems="center"
                        >
                          <s-stack direction="block" gap="small-500">
                            <s-text type="strong">{source.name}</s-text>
                            <s-text color="subdued">
                              {source.here
                                ? "Attribute added here"
                                : `Attribute added on ${source.typeName}`}
                            </s-text>
                          </s-stack>
                          {source.here ? (
                            <s-button
                              variant="tertiary"
                              tone="critical"
                              command="--show"
                              commandFor={DETACH_MODAL_ID}
                              onClick={() =>
                                setPendingDetach({
                                  kind: "attribute",
                                  assignmentId: source.assignmentId,
                                  name: source.name,
                                })
                              }
                              {...(busy ? { disabled: true } : {})}
                            >
                              Detach
                            </s-button>
                          ) : (
                            <s-link href={ATTRIBUTE_ROUTES.type(source.typeId)}>
                              Go to source
                            </s-link>
                          )}
                        </s-grid>
                      ))}
                    </s-stack>
                  </s-stack>
                </s-section>

                <s-section heading="Details">
                  <s-stack direction="block" gap="base">
                    <s-text-field
                      label="Name"
                      value={details.name}
                      onInput={(event) =>
                        setDetails({
                          ...details,
                          name: event.currentTarget.value,
                        })
                      }
                      {...(details.name.trim() === ""
                        ? { error: "Enter a name." }
                        : {})}
                    />
                    <Dropdown
                      name="parentId"
                      label="Under"
                      details="Moving a type changes what it and its descendants inherit."
                      value={details.parentId}
                      options={selected.parentOptions}
                      onChange={(parentId) =>
                        setDetails({ ...details, parentId })
                      }
                    />
                    <s-text-field
                      label="Shopify category"
                      details="Planning only; nothing is set in Shopify."
                      value={details.shopifyCategory}
                      onInput={(event) =>
                        setDetails({
                          ...details,
                          shopifyCategory: event.currentTarget.value,
                        })
                      }
                    />
                    <s-checkbox
                      label="Products can use this type"
                      details="Off makes it a category that only organises the types beneath it."
                      checked={details.leaf}
                      onChange={(event) =>
                        setDetails({
                          ...details,
                          leaf: event.currentTarget.checked,
                        })
                      }
                    />
                    <Advanced
                      summary={
                        details.archetype.trim()
                          ? `Archetype ${details.archetype.trim()}.`
                          : "No archetype."
                      }
                    >
                      <s-text-field
                        label="Archetype"
                        value={details.archetype}
                        onInput={(event) =>
                          setDetails({
                            ...details,
                            archetype: event.currentTarget.value,
                          })
                        }
                      />
                    </Advanced>
                  </s-stack>
                </s-section>

                <s-section heading="Preview">
                  <s-stack direction="block" gap="base">
                    <s-text color="subdued">
                      {`The fields a product assigned to ${selected.name} would carry. Nothing is published to Shopify.`}
                    </s-text>
                    {selected.preview.length === 0 ? (
                      <s-text color="subdued">No fields yet.</s-text>
                    ) : (
                      <s-table variant="auto">
                        <s-table-header-row>
                          <s-table-header listSlot="primary">
                            Field
                          </s-table-header>
                          <s-table-header listSlot="secondary">
                            Shopify field
                          </s-table-header>
                          <s-table-header listSlot="kicker">
                            Type / applies to
                          </s-table-header>
                          <s-table-header listSlot="inline">
                            Requirement
                          </s-table-header>
                        </s-table-header-row>
                        <s-table-body>
                          {selected.preview.map((row) => (
                            <s-table-row key={row.attributeId}>
                              <s-table-cell>{row.name}</s-table-cell>
                              <s-table-cell>
                                {row.key || "Not mapped"}
                              </s-table-cell>
                              <s-table-cell>{row.type}</s-table-cell>
                              <s-table-cell>
                                {row.required ? "Required" : "Optional"}
                              </s-table-cell>
                            </s-table-row>
                          ))}
                        </s-table-body>
                      </s-table>
                    )}
                  </s-stack>
                </s-section>
              </s-stack>
            ) : null}
          </s-grid>
        )}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
