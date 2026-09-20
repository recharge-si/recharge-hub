import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useSearchParams,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";
import { z } from "zod";

import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import {
  impactOfDeletingType,
  impactOfMovingType,
  workspaceState,
  type StructuralImpact,
} from "~/domain/attributes/impact";
import {
  addType,
  attachAttributes,
  attachSet,
  deleteType,
  detachAttribute,
  detachSet,
  excludeAttribute,
  moveType,
  placeType,
  restoreAttribute,
  setRequirement,
  updateType,
  type MutationResult,
} from "~/domain/attributes/mutations";
import {
  activeAttributes,
  ancestry,
  childrenOf,
  isWithin,
  pathOf,
  typeById,
} from "~/domain/attributes/resolve";
import { starterSchema } from "~/domain/attributes/starter";
import type { AttributeSchema } from "~/domain/attributes/types";
import { Advanced } from "~/web/components/advanced";
import {
  AttributeCreateModal,
  AttributeEditModal,
  editableAttribute,
} from "~/web/components/attribute-form";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { Dropdown } from "~/web/components/dropdown";
import {
  ProductSetupNav,
  rememberType,
  useNarrow,
} from "~/web/components/product-setup-nav";
import {
  LAST_TYPE_KEY,
  PRODUCT_SETUP_ROUTES,
  SCOPE_LABEL,
  countOf,
  formatLabel,
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
 * Product types (docs/attributes.md § Screens): the tree beside the
 * selected type. Choose a type, decide what information it needs.
 *
 * One route with an optional segment: the tree and the editor read one
 * document and change it through one action, and the URL says which type
 * and which tab, so a refresh, a link and the back button all land where
 * the person was. On a narrow screen the tree and the editor take turns.
 */
const SAVE_BAR_ID = "product-type-save-bar";
const ADD_MODAL_ID = "add-product-type";
const NEW_ATTRIBUTE_MODAL_ID = "new-attribute-from-type";
const PICKER_MODAL_ID = "add-attributes";
const DELETE_MODAL_ID = "delete-product-type";
const DETACH_MODAL_ID = "detach-source";
const MOVE_MODAL_ID = "move-product-type";
const MENU_ID = "product-type-actions";
const DROP_MODAL_ID = "confirm-drop";
const EDIT_ATTRIBUTE_MODAL_ID = "edit-attribute";
const EDIT_TYPE_MODAL_ID = "edit-product-type";

const TABS = ["attributes", "details", "preview"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  attributes: "Attributes",
  details: "Details",
  preview: "Preview",
};

interface Details {
  name: string;
  parentId: string;
  kind: "type" | "category";
  shopifyCategory: string;
  archetype: string;
}

type Overlay = { showOverlay?: () => void; hideOverlay?: () => void };

/** Where a dragged row lands: among a row's siblings, or beneath it. */
type DropPosition = "before" | "after" | "inside";

/** The top and bottom quarters of a row place beside it; the middle nests. */
function positionFrom(event: {
  clientY: number;
  currentTarget: Element;
}): DropPosition {
  const box = event.currentTarget.getBoundingClientRect();
  const y = (event.clientY - box.top) / Math.max(box.height, 1);
  return y < 0.25 ? "before" : y > 0.75 ? "after" : "inside";
}

/** The tree flattened in display order, so the client only decides what to hide. */
function flatten(schema: AttributeSchema) {
  const rows: Array<{
    id: string;
    name: string;
    parentId: string | null;
    depth: number;
    count: number;
    leaf: boolean;
    hasChildren: boolean;
    path: string;
    label: string;
  }> = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const type of childrenOf(schema, parentId)) {
      rows.push({
        id: type.id,
        name: type.name,
        parentId,
        depth,
        count: activeAttributes(schema, type.id).length,
        leaf: type.leaf,
        hasChildren: childrenOf(schema, type.id).length > 0,
        path: pathOf(schema, type.id).join(" › ").toLowerCase(),
        label: pathOf(schema, type.id).join(" › "),
      });
      walk(type.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

function typesUsingCount(schema: AttributeSchema, attributeId: string) {
  return schema.types.filter((type) =>
    activeAttributes(schema, type.id).some(
      (row) => row.attribute.id === attributeId,
    ),
  ).length;
}

function describeSelected(schema: AttributeSchema, typeId: string) {
  const type = typeById(schema, typeId);
  if (!type) return null;
  const nameOf = (id: string) => typeById(schema, id)?.name ?? "";
  const chain = ancestry(schema, typeId);
  const rows = activeAttributes(schema, typeId);
  const excludedIds = new Set(
    schema.exclusions
      .filter((r) => r.typeId === typeId)
      .map((r) => r.attributeId),
  );
  const activeIds = new Set(rows.map((row) => row.attribute.id));
  const setsHere = new Set(
    schema.setAssignments
      .filter((r) => r.typeId === typeId)
      .map((r) => r.setId),
  );
  const parentOptions = [
    { value: "", label: "Top level" },
    ...schema.types
      .filter((candidate) => !isWithin(schema, candidate.id, typeId))
      .map((candidate) => ({
        value: candidate.id,
        label: pathOf(schema, candidate.id).join(" › "),
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];
  const moveImpacts: Record<string, StructuralImpact> = {};
  for (const option of parentOptions) {
    if (option.value === (type.parentId ?? "")) continue;
    const impact = impactOfMovingType(schema, typeId, option.value || null);
    if (impact) moveImpacts[option.value] = impact;
  }
  const path = pathOf(schema, typeId);
  const siblings = childrenOf(schema, type.parentId);

  return {
    id: type.id,
    name: type.name,
    leaf: type.leaf,
    parentName: type.parentId === null ? null : nameOf(type.parentId),
    parents: path.slice(0, -1),
    details: {
      name: type.name,
      parentId: type.parentId ?? "",
      kind: type.leaf ? ("type" as const) : ("category" as const),
      shopifyCategory: type.shopifyCategory,
      archetype: type.archetype,
    } satisfies Details,
    required: rows.filter((row) => row.required).length,
    rows: rows.map((row) => ({
      attributeId: row.attribute.id,
      name: row.attribute.name,
      editable: editableAttribute(
        row.attribute,
        schema.valueLists.find((l) => l.id === row.attribute.valueListId)
          ?.items ?? [],
        typesUsingCount(schema, row.attribute.id),
      ),
      format: formatLabel(row.attribute),
      scope: SCOPE_LABEL[row.attribute.scope],
      sourceTypeId: row.sourceTypeId,
      sourceName: nameOf(row.sourceTypeId),
      here: row.sourceTypeId === typeId,
      required: row.required,
      overridden: row.override !== null,
    })),
    removed: schema.exclusions
      .filter((r) => r.typeId === typeId)
      .map((r) => ({
        attributeId: r.attributeId,
        name: schema.attributes.find((a) => a.id === r.attributeId)?.name ?? "",
      })),
    setSources: schema.setAssignments
      .filter((r) => chain.includes(r.typeId))
      .map((r) => ({
        assignmentId: r.id,
        name: schema.sets.find((set) => set.id === r.setId)?.name ?? "",
        typeId: r.typeId,
        typeName: nameOf(r.typeId),
        here: r.typeId === typeId,
      })),
    attributeSources: schema.attributeAssignments
      .filter((r) => chain.includes(r.typeId))
      .map((r) => ({
        assignmentId: r.id,
        name: schema.attributes.find((a) => a.id === r.attributeId)?.name ?? "",
        typeId: r.typeId,
        typeName: nameOf(r.typeId),
        here: r.typeId === typeId,
      })),
    preview: rows.map((row) => ({
      attributeId: row.attribute.id,
      name: row.attribute.name,
      key: row.attribute.key,
      format: `${formatLabel(row.attribute)} · ${SCOPE_LABEL[row.attribute.scope]}`,
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
          format: formatLabel(attribute),
          state: activeIds.has(attribute.id)
            ? ("added" as const)
            : excludedIds.has(attribute.id)
              ? ("removed" as const)
              : ("available" as const),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    },
    parentOptions,
    moveImpacts,
    deleteImpact: impactOfDeletingType(schema, typeId),
    isFirst: siblings[0]?.id === typeId,
    isLast: siblings.at(-1)?.id === typeId,
  };
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const { schema, revision } = await getAttributeSchema(principal);
  const tree = flatten(schema);

  const typeId = params.typeId ?? null;
  const selected = typeId === null ? null : describeSelected(schema, typeId);
  // A type that no longer exists — deleted in another tab, or a stale
  // bookmark — sends the person to the tree rather than to an error.
  if (typeId !== null && selected === null) {
    throw redirectWithin(request, PRODUCT_SETUP_ROUTES.types);
  }
  const state = workspaceState(schema);

  // A drop asks what it would do before it happens: `?impact=<type>&to=<parent>`.
  const url = new URL(request.url);
  const impactOf = url.searchParams.get("impact");
  const dragImpact =
    impactOf === null
      ? null
      : impactOfMovingType(
          schema,
          impactOf,
          url.searchParams.get("to") || null,
        );

  return {
    revision,
    stage: state.stage,
    summary: state.summary,
    tree,
    selected,
    dragImpact,
    typeOptions: schema.types
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

const addForm = z.object({
  name: z.string(),
  parentId: z.string(),
  kind: z.enum(["type", "category"]),
  shopifyCategory: z.string(),
});

const detailsForm = z.object({
  name: z.string(),
  parentId: z.string(),
  kind: z.enum(["type", "category"]),
  shopifyCategory: z.string(),
  archetype: z.string(),
});

const idList = z.array(z.string()).max(1000);

export const action = async ({
  request,
  params,
}: ActionFunctionArgs): Promise<SchemaActionResult> => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const revision = revisionFrom(formData);
  const field = (name: string) => String(formData.get(name) ?? "");
  // The tree edits and moves rows other than the selected one, so a form
  // may name its type; the editor's own forms leave it to the address.
  const typeId = field("typeId") || String(params.typeId ?? "");
  const json = (name: string): unknown => {
    try {
      return JSON.parse(field(name));
    } catch {
      return null;
    }
  };
  const unreadable: SchemaActionResult = {
    ok: false,
    message: "The form could not be read. Reload the page and try again.",
  };
  const commit = (
    event: string,
    change: (schema: AttributeSchema) => MutationResult,
  ) => commitSchemaChange(principal, revision, event, change, actor);

  switch (intent) {
    case "starter":
      return commit("attribute_schema.starter.loaded", (schema) =>
        schema.types.length === 0 && schema.attributes.length === 0
          ? { ok: true, schema: starterSchema(), message: "Example loaded." }
          : {
              ok: false,
              message:
                "There is already something here, so the example was not loaded.",
            },
      );
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
            leaf: parsed.data.kind === "type",
            shopifyCategory: parsed.data.shopifyCategory,
          },
          newId,
        );
        createdId = outcome.typeId ?? null;
        return outcome;
      });
      if (result.ok && createdId !== null)
        throw redirectWithin(request, PRODUCT_SETUP_ROUTES.type(createdId));
      return result;
    }
    case "save-details": {
      const parsed = detailsForm.safeParse(json("form"));
      if (!parsed.success) return unreadable;
      return commit("attribute_schema.type.saved", (schema) =>
        updateType(schema, typeId, {
          name: parsed.data.name,
          parentId: parsed.data.parentId || null,
          leaf: parsed.data.kind === "type",
          shopifyCategory: parsed.data.shopifyCategory,
          archetype: parsed.data.archetype,
        }),
      );
    }
    case "edit-type": {
      const parsed = detailsForm
        .omit({ shopifyCategory: true, archetype: true })
        .safeParse(json("form"));
      if (!parsed.success) return unreadable;
      return commit("attribute_schema.type.saved", (schema) => {
        const type = typeById(schema, typeId);
        if (!type)
          return { ok: false, message: "That product type no longer exists." };
        return updateType(schema, typeId, {
          name: parsed.data.name,
          parentId: parsed.data.parentId || null,
          leaf: parsed.data.kind === "type",
          shopifyCategory: type.shopifyCategory,
          archetype: type.archetype,
        });
      });
    }
    case "place-type": {
      const position = field("position");
      if (
        position !== "before" &&
        position !== "after" &&
        position !== "inside"
      )
        return unreadable;
      const target = field("target") || null;
      return commit("attribute_schema.type.moved", (schema) => {
        if (position === "inside")
          return placeType(schema, typeId, target, null);
        if (target === null) return placeType(schema, typeId, null, null);
        const anchor = typeById(schema, target);
        if (!anchor)
          return { ok: false, message: "That product type no longer exists." };
        const siblings = childrenOf(schema, anchor.parentId).filter(
          (t) => t.id !== typeId,
        );
        const index = siblings.findIndex((t) => t.id === target);
        const before =
          position === "before" ? target : (siblings[index + 1]?.id ?? null);
        return placeType(schema, typeId, anchor.parentId, before);
      });
    }
    case "move-to":
      return commit("attribute_schema.type.moved", (schema) => {
        const type = typeById(schema, typeId);
        if (!type)
          return { ok: false, message: "That product type no longer exists." };
        return updateType(schema, typeId, {
          name: type.name,
          parentId: field("parentId") || null,
          leaf: type.leaf,
          shopifyCategory: type.shopifyCategory,
          archetype: type.archetype,
        });
      });
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
            ? PRODUCT_SETUP_ROUTES.types
            : PRODUCT_SETUP_ROUTES.type(parentId),
        );
      return result;
    }
    case "move-up":
    case "move-down":
      return commit("attribute_schema.type.moved", (schema) =>
        moveType(schema, typeId, intent === "move-up" ? "up" : "down"),
      );
    case "attach-many": {
      const attributeIds = idList.safeParse(json("attributeIds"));
      const setIds = idList.safeParse(json("setIds"));
      if (!attributeIds.success || !setIds.success) return unreadable;
      return commit("attribute_schema.attributes.attached", (schema) => {
        let next = schema;
        const notes: string[] = [];
        for (const setId of setIds.data) {
          const result = attachSet(next, typeId, setId, newId);
          if (!result.ok) return result;
          next = result.schema;
        }
        if (setIds.data.length > 0)
          notes.push(countOf(setIds.data.length, "set") + " attached");
        if (attributeIds.data.length > 0) {
          const result = attachAttributes(
            next,
            typeId,
            attributeIds.data,
            newId,
          );
          if (result.ok) {
            next = result.schema;
            notes.push(result.message.replace(/\.$/, "").toLowerCase());
          } else if (setIds.data.length === 0) {
            return result;
          }
        }
        if (notes.length === 0)
          return {
            ok: false,
            message: "Choose at least one attribute or set.",
          };
        return { ok: true, schema: next, message: `${notes.join(", ")}.` };
      });
    }
    case "detach-set":
      return commit("attribute_schema.set.detached", (schema) =>
        detachSet(schema, field("assignmentId")),
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

/** "This type and 2 types beneath it gain 1 field and lose 3 fields." */
function describeMove(impact: StructuralImpact | undefined): string {
  if (!impact) return "";
  const who =
    impact.descendants === 0
      ? "This type"
      : `This type and the ${countOf(impact.descendants, "type")} beneath it`;
  if (impact.fieldsGained === 0 && impact.fieldsLost === 0)
    return `${who} keep exactly the same fields.`;
  const parts: string[] = [];
  if (impact.fieldsGained > 0)
    parts.push(`gain ${countOf(impact.fieldsGained, "field")}`);
  if (impact.fieldsLost > 0)
    parts.push(`lose ${countOf(impact.fieldsLost, "field")}`);
  return `${who} ${parts.join(" and ")}${impact.typesAffected > 1 ? ` across ${countOf(impact.typesAffected, "type")}` : ""}.`;
}

function describeDelete(
  name: string,
  parentName: string | null,
  impact: StructuralImpact | null,
): string {
  if (!impact) return "";
  const sentences: string[] = [];
  if (impact.children > 0)
    sentences.push(
      `Its ${countOf(impact.children, "child type")} ${impact.children === 1 ? "moves" : "move"} up ${parentName ? `under ${parentName}` : "to the top level"}.`,
    );
  if (impact.sourcesHere > 0 || impact.rulesHere > 0) {
    const what: string[] = [];
    if (impact.sourcesHere > 0)
      what.push(
        `${countOf(impact.sourcesHere, "set or attribute", "sets and attributes")} attached here`,
      );
    if (impact.rulesHere > 0)
      what.push(`${countOf(impact.rulesHere, "exception")} made here`);
    sentences.push(
      `${what.join(" and ")} ${what.length === 1 && impact.sourcesHere + impact.rulesHere === 1 ? "goes" : "go"} with it.`,
    );
  }
  if (impact.fieldsLost > 0)
    sentences.push(
      `${countOf(impact.typesAffected, "type")} beneath it ${impact.typesAffected === 1 ? "loses" : "lose"} ${countOf(impact.fieldsLost, "field")}.`,
    );
  if (sentences.length === 0)
    sentences.push(
      `“${name}” has no children, sources or exceptions; nothing else changes.`,
    );
  sentences.push("This cannot be undone.");
  return sentences.join(" ");
}

const BLANK_TYPE = {
  name: "",
  parentId: "",
  kind: "type" as "type" | "category",
  shopifyCategory: "",
};

export default function ProductTypes() {
  const { revision, stage, summary, tree, selected, typeOptions, sets } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const navigate = useNavigate();
  const narrow = useNarrow();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: Tab = TABS.includes(tabParam as Tab)
    ? (tabParam as Tab)
    : "attributes";

  const [treeQuery, setTreeQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [fieldQuery, setFieldQuery] = useState("");
  const [requirementFilter, setRequirementFilter] = useState("all");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickedAttributes, setPickedAttributes] = useState<string[]>([]);
  const [pickedSets, setPickedSets] = useState<string[]>([]);
  const [pickerTried, setPickerTried] = useState(false);
  const [newType, setNewType] = useState<typeof BLANK_TYPE>(BLANK_TYPE);
  const [newTypeTried, setNewTypeTried] = useState(false);
  const [moveTarget, setMoveTarget] = useState("");
  const [pendingDetach, setPendingDetach] = useState<{
    kind: "set" | "attribute";
    assignmentId: string;
    name: string;
  } | null>(null);
  const pickerOverlay = useRef<Overlay | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    position: DropPosition;
  } | null>(null);
  const [pendingDrop, setPendingDrop] = useState<{
    sourceId: string;
    sourceName: string;
    target: string | null;
    position: DropPosition;
    parentName: string;
  } | null>(null);
  const impactFetcher = useFetcher<typeof loader>();
  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    details: Details;
  } | null>(null);
  const [editTried, setEditTried] = useState(false);
  const [editingAttributeId, setEditingAttributeId] = useState<string | null>(
    null,
  );
  const editingAttribute =
    selected?.rows.find((row) => row.attributeId === editingAttributeId)
      ?.editable ?? null;

  const savedDetails = selected?.details ?? null;
  const [details, setDetails] = useState<Details | null>(savedDetails);
  const [detailsTried, setDetailsTried] = useState(false);
  const savedKey = savedDetails ? normalise(savedDetails) : "";
  const reset = useCallback(() => {
    setDetails(savedDetails);
    setDetailsTried(false);
  }, [savedDetails]);
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

  // Remember the type on show, so the workspace's own link comes back here.
  useEffect(() => {
    if (selected) rememberType(selected.id);
  }, [selected]);

  // With room for both columns, an unchosen tree chooses: the remembered
  // type, else the first. A narrow screen shows the list and lets the person
  // choose.
  useEffect(() => {
    if (selected || narrow !== false || tree.length === 0) return;
    let remembered: string | null = null;
    try {
      remembered = window.localStorage.getItem(LAST_TYPE_KEY);
    } catch {
      remembered = null;
    }
    const target = tree.find((row) => row.id === remembered)?.id ?? tree[0]?.id;
    if (target)
      void navigate(PRODUCT_SETUP_ROUTES.type(target), { replace: true });
  }, [selected, narrow, tree, navigate]);

  const submit = (fields: Record<string, string>) =>
    fetcher.submit(
      { ...fields, revision: String(revision) },
      { method: "post" },
    );

  const setTab = (next: Tab) =>
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (next === "attributes") params.delete("tab");
        else params.set("tab", next);
        return params;
      },
      { replace: true },
    );

  const saveDetails = () => {
    if (!details) return;
    setDetailsTried(true);
    if (details.name.trim() === "") return;
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
  const visibleTree = tree.filter((row) => visibleIds.has(row.id));

  const fieldNeedle = fieldQuery.trim().toLowerCase();
  const rows = (selected?.rows ?? []).filter(
    (row) =>
      `${row.name} ${row.format}`.toLowerCase().includes(fieldNeedle) &&
      (requirementFilter === "all" ||
        (requirementFilter === "required") === row.required),
  );

  const pickerNeedle = pickerQuery.trim().toLowerCase();
  const pickableAttributes = (selected?.picker.attributes ?? []).filter((a) =>
    a.name.toLowerCase().includes(pickerNeedle),
  );
  const pickableSets = (selected?.picker.sets ?? []).filter((s) =>
    `${s.name} ${s.members}`.toLowerCase().includes(pickerNeedle),
  );
  const pickedCount = pickedAttributes.length + pickedSets.length;

  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((entry) => entry !== id);

  const openPicker = () => {
    setPickerQuery("");
    setPickedAttributes([]);
    setPickedSets([]);
    setPickerTried(false);
  };

  // Ancestry from the flattened tree, for what a row may be dropped on.
  const parentOf = new Map(tree.map((row) => [row.id, row.parentId]));
  const isWithinRow = (candidate: string, ancestor: string): boolean => {
    let current: string | null = candidate;
    while (current !== null) {
      if (current === ancestor) return true;
      current = parentOf.get(current) ?? null;
    }
    return false;
  };
  const nameOfRow = (id: string) =>
    tree.find((row) => row.id === id)?.name ?? "";

  const drop = (
    sourceId: string,
    target: string | null,
    position: DropPosition,
  ) => {
    setDragging(null);
    setDropTarget(null);
    if (target !== null && isWithinRow(target, sourceId)) return;
    if (target === sourceId) return;
    const newParent =
      target === null
        ? null
        : position === "inside"
          ? target
          : (parentOf.get(target) ?? null);
    const sameParent = (parentOf.get(sourceId) ?? null) === newParent;
    if (sameParent && position === "inside") return;
    // A reorder among the same siblings changes what nobody inherits, so it
    // just happens; a new parent is confirmed with what it changes.
    if (sameParent) {
      submit({
        intent: "place-type",
        typeId: sourceId,
        target: target ?? "",
        position,
      });
      return;
    }
    setPendingDrop({
      sourceId,
      sourceName: nameOfRow(sourceId),
      target,
      position,
      parentName: newParent === null ? "the top level" : nameOfRow(newParent),
    });
    const query = new URLSearchParams({
      impact: sourceId,
      to: newParent ?? "",
    });
    void impactFetcher.load(
      `${PRODUCT_SETUP_ROUTES.types}?${query.toString()}`,
    );
    (document.getElementById(DROP_MODAL_ID) as Overlay | null)?.showOverlay?.();
  };

  const editOptions = (id: string) => [
    { value: "", label: "Top level" },
    ...tree
      .filter((row) => !isWithinRow(row.id, id))
      .map((row) => ({ value: row.id, label: row.label })),
  ];

  const showTree = narrow !== true || selected === null;
  const showEditor = narrow !== true || selected !== null;

  const treeColumn = (
    <s-section heading="Product types">
      <s-stack direction="block" gap="small-300">
        {tree.length > 6 ? (
          <s-search-field
            label="Search product types"
            labelAccessibilityVisibility="exclusive"
            placeholder="Search"
            value={treeQuery}
            onInput={(event) => setTreeQuery(event.currentTarget.value)}
          />
        ) : null}
        {visibleTree.length === 0 ? (
          <s-text color="subdued">No product type matches.</s-text>
        ) : null}
        {visibleTree.map((row) => (
          /*
           * A plain element carries the drag, because the Polaris row owns
           * its own DOM: dragging starts anywhere on the row and lands on
           * another row, which becomes the new parent after a confirmation
           * that says what changes. Move to… in the menu is the keyboard way.
           */
          <div
            key={row.id}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", row.id);
              setDragging(row.id);
            }}
            onDragEnd={() => {
              setDragging(null);
              setDropTarget(null);
            }}
            onDragOver={(event) => {
              if (dragging === null || dragging === row.id) return;
              if (isWithinRow(row.id, dragging)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const position = positionFrom(event);
              if (dropTarget?.id !== row.id || dropTarget.position !== position)
                setDropTarget({ id: row.id, position });
            }}
            onDragLeave={() => {
              if (dropTarget?.id === row.id) setDropTarget(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const sourceId =
                dragging ?? event.dataTransfer.getData("text/plain");
              if (sourceId) drop(sourceId, row.id, positionFrom(event));
            }}
          >
            {dropTarget?.id === row.id && dropTarget.position === "before" ? (
              <s-box blockSize="3px" background="strong" borderRadius="base" />
            ) : null}
            <s-box
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
                gridTemplateColumns="auto auto 1fr auto"
                gap="none"
                alignItems="center"
              >
                <s-box paddingInlineEnd="small-500">
                  <s-icon type="drag-handle" color="subdued" />
                </s-box>
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
                  href={PRODUCT_SETUP_ROUTES.type(row.id)}
                  borderRadius="base"
                  paddingInline="small-300"
                  paddingBlock="small-400"
                  inlineSize="100%"
                  background={
                    dropTarget?.id === row.id &&
                    dropTarget.position === "inside"
                      ? "strong"
                      : selected?.id === row.id
                        ? "subdued"
                        : "transparent"
                  }
                  accessibilityLabel={`${row.name}, ${row.leaf ? "product type" : "category"}, ${countOf(row.count, "attribute")}${selected?.id === row.id ? ", selected" : ""}`}
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
                    <s-text color="subdued">
                      {row.leaf
                        ? String(row.count)
                        : row.count > 0
                          ? `${row.count} ·`
                          : "·"}
                    </s-text>
                  </s-grid>
                </s-clickable>
                <s-button
                  variant="tertiary"
                  icon="edit"
                  accessibilityLabel={`Edit ${row.name}`}
                  command="--show"
                  commandFor={EDIT_TYPE_MODAL_ID}
                  onClick={() => {
                    setEditing({
                      id: row.id,
                      name: row.name,
                      details: {
                        name: row.name,
                        parentId: row.parentId ?? "",
                        kind: row.leaf ? "type" : "category",
                        shopifyCategory: "",
                        archetype: "",
                      },
                    });
                    setEditTried(false);
                  }}
                />
              </s-grid>
            </s-box>
            {dropTarget?.id === row.id && dropTarget.position === "after" ? (
              <s-box blockSize="3px" background="strong" borderRadius="base" />
            ) : null}
          </div>
        ))}
        {dragging !== null && (parentOf.get(dragging) ?? null) !== null ? (
          <div
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (dropTarget?.id !== "")
                setDropTarget({ id: "", position: "inside" });
            }}
            onDragLeave={() => {
              if (dropTarget?.id === "") setDropTarget(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging) drop(dragging, null, "inside");
            }}
          >
            <s-box
              padding="small-300"
              borderRadius="base"
              borderWidth="base"
              borderStyle="dashed"
              borderColor={dropTarget?.id === "" ? "strong" : "subdued"}
              background={dropTarget?.id === "" ? "strong" : "transparent"}
            >
              <s-text color="subdued">
                Drop here to make it a top-level type
              </s-text>
            </s-box>
          </div>
        ) : null}
        <s-text color="subdued">
          {`Numbers are attributes on the type. A dot marks a category, which only organises the types beneath it. Drag a row onto another to put it beneath, or to the edge of a row to place it beside.`}
        </s-text>
      </s-stack>
    </s-section>
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
        commandFor={ADD_MODAL_ID}
        onClick={() => {
          setNewType({ ...BLANK_TYPE, parentId: selected?.id ?? "" });
          setNewTypeTried(false);
        }}
      >
        Add product type
      </s-button>

      <s-modal id={ADD_MODAL_ID} heading="Add product type">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Name"
            placeholder="Freeride sails"
            value={newType.name}
            onInput={(event) =>
              setNewType({ ...newType, name: event.currentTarget.value })
            }
            {...(newTypeTried && newType.name.trim() === ""
              ? { error: "Enter a name." }
              : {})}
          />
          <Dropdown
            name="parentId"
            label="Under (optional)"
            details="It inherits every attribute of the type above it."
            value={newType.parentId}
            options={[{ value: "", label: "Top level" }, ...typeOptions]}
            onChange={(parentId) => setNewType({ ...newType, parentId })}
          />
          <s-choice-list
            label="Kind"
            name="kind"
            values={[newType.kind]}
            onChange={(event) => {
              const next = event.currentTarget.values[0];
              if (next === "type" || next === "category")
                setNewType({ ...newType, kind: next });
            }}
          >
            <s-choice value="type">
              Product type
              <s-text slot="details" color="subdued">
                Products can be assigned to it. This is the usual choice.
              </s-text>
            </s-choice>
            <s-choice value="category">
              Organising category
              <s-text slot="details" color="subdued">
                Only groups the types beneath it; no product is assigned to it
                directly.
              </s-text>
            </s-choice>
          </s-choice-list>
          <s-text-field
            label="Shopify category (optional)"
            details="The standard product category this matches; a note for now."
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
          {...(newType.name.trim() !== ""
            ? { command: "--hide", commandFor: ADD_MODAL_ID }
            : {})}
          onClick={() => {
            setNewTypeTried(true);
            if (newType.name.trim() === "") return;
            submit({
              intent: "add-type",
              name: newType.name,
              parentId: newType.parentId,
              kind: newType.kind,
              shopifyCategory: newType.shopifyCategory,
            });
          }}
          {...(busy ? { disabled: true } : {})}
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

      <s-modal
        id={DROP_MODAL_ID}
        heading={`Move “${pendingDrop?.sourceName ?? ""}” under ${pendingDrop?.parentName ?? ""}?`}
      >
        <s-paragraph>
          {impactFetcher.state !== "idle"
            ? "Working out what changes…"
            : impactFetcher.data?.dragImpact
              ? describeMove(impactFetcher.data.dragImpact)
              : "It takes what the new parent inherits instead of what the old one did."}
        </s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          command="--hide"
          commandFor={DROP_MODAL_ID}
          onClick={() => {
            if (!pendingDrop) return;
            submit({
              intent: "place-type",
              typeId: pendingDrop.sourceId,
              target: pendingDrop.target ?? "",
              position: pendingDrop.position,
            });
            setPendingDrop(null);
          }}
          {...(busy ? { disabled: true } : {})}
        >
          Move
        </s-button>
        <s-button
          slot="secondary-actions"
          command="--hide"
          commandFor={DROP_MODAL_ID}
          onClick={() => setPendingDrop(null)}
        >
          Cancel
        </s-button>
      </s-modal>

      <s-modal
        id={EDIT_TYPE_MODAL_ID}
        heading={editing ? `Edit “${editing.name}”` : "Edit product type"}
        onAfterHide={(event) => {
          if (event.target !== event.currentTarget) return;
          setEditing(null);
          setEditTried(false);
        }}
      >
        {editing ? (
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Name"
              value={editing.details.name}
              onInput={(event) =>
                setEditing({
                  ...editing,
                  details: {
                    ...editing.details,
                    name: event.currentTarget.value,
                  },
                })
              }
              {...(editTried && editing.details.name.trim() === ""
                ? { error: "Enter a name." }
                : {})}
            />
            <Dropdown
              name="editParentId"
              label="Under"
              details={
                editing.details.parentId === (parentOf.get(editing.id) ?? "")
                  ? "It inherits every attribute of the type above it."
                  : "Moving it changes what it and the types beneath it inherit."
              }
              value={editing.details.parentId}
              options={editOptions(editing.id)}
              onChange={(parentId) =>
                setEditing({
                  ...editing,
                  details: { ...editing.details, parentId },
                })
              }
            />
            <s-choice-list
              label="Kind"
              name="editKind"
              values={[editing.details.kind]}
              onChange={(event) => {
                const next = event.currentTarget.values[0];
                if (next === "type" || next === "category")
                  setEditing({
                    ...editing,
                    details: { ...editing.details, kind: next },
                  });
              }}
            >
              <s-choice value="type">
                Product type
                <s-text slot="details" color="subdued">
                  Products can be assigned to it.
                </s-text>
              </s-choice>
              <s-choice value="category">
                Organising category
                <s-text slot="details" color="subdued">
                  Only groups the types beneath it.
                </s-text>
              </s-choice>
            </s-choice-list>
            <s-text color="subdued">
              Its attributes, Shopify category and archetype are edited from the
              type itself.
            </s-text>
          </s-stack>
        ) : null}
        <s-button
          slot="primary-action"
          variant="primary"
          {...(editing && editing.details.name.trim() !== ""
            ? { command: "--hide", commandFor: EDIT_TYPE_MODAL_ID }
            : {})}
          onClick={() => {
            setEditTried(true);
            if (!editing || editing.details.name.trim() === "") return;
            submit({
              intent: "edit-type",
              typeId: editing.id,
              form: JSON.stringify(editing.details),
            });
          }}
          {...(busy ? { disabled: true } : {})}
        >
          Save
        </s-button>
        <s-button
          slot="secondary-actions"
          command="--hide"
          commandFor={EDIT_TYPE_MODAL_ID}
        >
          Cancel
        </s-button>
      </s-modal>

      <AttributeEditModal
        id={EDIT_ATTRIBUTE_MODAL_ID}
        revision={revision}
        sets={sets}
        attribute={editingAttribute}
      />

      <AttributeCreateModal
        id={NEW_ATTRIBUTE_MODAL_ID}
        revision={revision}
        sets={sets}
        types={typeOptions}
        preselectedTypeId={selected?.id ?? null}
      />

      {selected ? (
        <>
          <s-modal
            id={PICKER_MODAL_ID}
            heading={`Add attributes to ${selected.name}`}
            size="large"
            ref={(element) => {
              pickerOverlay.current = (element as Overlay) ?? null;
            }}
          >
            <s-stack direction="block" gap="base">
              <s-text color="subdued">
                {`Whatever is added here reaches ${selected.name} and every type beneath it.`}
              </s-text>
              {selected.picker.attributes.length + selected.picker.sets.length >
              6 ? (
                <s-search-field
                  label="Search attributes and sets"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="Search"
                  value={pickerQuery}
                  onInput={(event) => setPickerQuery(event.currentTarget.value)}
                />
              ) : null}

              {selected.picker.attributes.length === 0 ? (
                <s-text color="subdued">
                  No attributes are defined yet. Create the first one below.
                </s-text>
              ) : (
                <s-stack direction="block" gap="small-300">
                  <s-text type="strong">Attributes</s-text>
                  {pickableAttributes.length === 0 ? (
                    <s-text color="subdued">No attribute matches.</s-text>
                  ) : null}
                  {pickableAttributes.map((attribute) => (
                    <s-checkbox
                      key={attribute.id}
                      label={attribute.name}
                      details={
                        attribute.state === "added"
                          ? `${attribute.format} · already on this type`
                          : attribute.state === "removed"
                            ? `${attribute.format} · removed from this type; adding it restores it`
                            : attribute.format
                      }
                      checked={pickedAttributes.includes(attribute.id)}
                      {...(attribute.state === "added"
                        ? { disabled: true }
                        : {})}
                      onChange={(event) =>
                        setPickedAttributes(
                          toggle(
                            pickedAttributes,
                            attribute.id,
                            event.currentTarget.checked,
                          ),
                        )
                      }
                    />
                  ))}
                </s-stack>
              )}

              {selected.picker.sets.length > 0 ? (
                <s-stack direction="block" gap="small-300">
                  <s-text type="strong">Attribute sets</s-text>
                  {pickableSets.length === 0 ? (
                    <s-text color="subdued">No set matches.</s-text>
                  ) : null}
                  {pickableSets.map((set) => (
                    <s-checkbox
                      key={set.id}
                      label={set.name}
                      details={
                        set.attachedHere
                          ? `${set.members || "Empty set"} · already attached here`
                          : set.members || "Empty set"
                      }
                      checked={pickedSets.includes(set.id)}
                      {...(set.attachedHere ? { disabled: true } : {})}
                      onChange={(event) =>
                        setPickedSets(
                          toggle(
                            pickedSets,
                            set.id,
                            event.currentTarget.checked,
                          ),
                        )
                      }
                    />
                  ))}
                </s-stack>
              ) : null}

              {pickerTried && pickedCount === 0 ? (
                <s-text tone="critical">
                  Choose at least one attribute or set.
                </s-text>
              ) : null}
            </s-stack>
            <s-button
              slot="primary-action"
              variant="primary"
              {...(pickedCount > 0
                ? { command: "--hide", commandFor: PICKER_MODAL_ID }
                : {})}
              onClick={() => {
                setPickerTried(true);
                if (pickedCount === 0) return;
                submit({
                  intent: "attach-many",
                  attributeIds: JSON.stringify(pickedAttributes),
                  setIds: JSON.stringify(pickedSets),
                });
              }}
              {...(busy ? { disabled: true } : {})}
            >
              {pickedCount === 0
                ? "Add selected"
                : `Add ${pickedCount} selected`}
            </s-button>
            <s-button
              slot="secondary-actions"
              onClick={() => {
                pickerOverlay.current?.hideOverlay?.();
                (
                  document.getElementById(
                    NEW_ATTRIBUTE_MODAL_ID,
                  ) as Overlay | null
                )?.showOverlay?.();
              }}
            >
              New attribute
            </s-button>
            <s-button
              slot="secondary-actions"
              command="--hide"
              commandFor={PICKER_MODAL_ID}
            >
              Cancel
            </s-button>
          </s-modal>

          <ConfirmModal
            id={DELETE_MODAL_ID}
            heading={`Delete “${selected.name}”?`}
            confirmLabel="Delete"
            onConfirm={() => submit({ intent: "delete-type" })}
          >
            <s-paragraph>
              {describeDelete(
                selected.name,
                selected.parentName,
                selected.deleteImpact,
              )}
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
              {`${selected.name} and every type beneath it lose ${pendingDetach?.kind === "set" ? "the set's attributes" : "it"}, unless another source supplies ${pendingDetach?.kind === "set" ? "them" : "it"}. To hide an attribute on this type alone, remove it from the list instead.`}
            </s-paragraph>
          </ConfirmModal>

          <s-modal id={MOVE_MODAL_ID} heading={`Move “${selected.name}”`}>
            <s-stack direction="block" gap="base">
              <Dropdown
                name="moveTarget"
                label="Under"
                value={moveTarget}
                options={selected.parentOptions}
                onChange={setMoveTarget}
              />
              <s-text color="subdued">
                {moveTarget === (selected.details.parentId ?? "")
                  ? "That is where it is now."
                  : describeMove(selected.moveImpacts[moveTarget])}
              </s-text>
            </s-stack>
            <s-button
              slot="primary-action"
              variant="primary"
              command="--hide"
              commandFor={MOVE_MODAL_ID}
              onClick={() =>
                submit({ intent: "move-to", parentId: moveTarget })
              }
              {...(moveTarget === selected.details.parentId || busy
                ? { disabled: true }
                : {})}
            >
              Move
            </s-button>
            <s-button
              slot="secondary-actions"
              command="--hide"
              commandFor={MOVE_MODAL_ID}
            >
              Cancel
            </s-button>
          </s-modal>

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

      <s-stack direction="block" gap="base">
        <ProductSetupNav current="types" />

        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : stage === "partial" ? (
          <s-banner tone="info">
            <s-paragraph>{summary}</s-paragraph>
          </s-banner>
        ) : stage === "issues" ? (
          <s-banner tone="warning">
            <s-paragraph>{summary}</s-paragraph>
            <s-link slot="primary-action" href={PRODUCT_SETUP_ROUTES.settings}>
              See the checks
            </s-link>
          </s-banner>
        ) : null}

        {tree.length === 0 ? (
          <s-section heading="Nothing configured yet">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Product types form a tree — windsurf sails under sails under
                windsurfing. Choose a type and decide what information every
                product of that type needs; each type beneath it inherits the
                answer. Nothing here reads or writes Shopify.
              </s-paragraph>
              <s-stack direction="inline" gap="small-300">
                <s-button
                  variant="primary"
                  command="--show"
                  commandFor={ADD_MODAL_ID}
                  onClick={() => {
                    setNewType(BLANK_TYPE);
                    setNewTypeTried(false);
                  }}
                >
                  Add product type
                </s-button>
                {stage === "empty" ? (
                  <s-button
                    onClick={() => submit({ intent: "starter" })}
                    {...(busy ? { disabled: true, loading: true } : {})}
                  >
                    Start from the example
                  </s-button>
                ) : null}
                <s-button href={PRODUCT_SETUP_ROUTES.settings}>
                  Import a file
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>
        ) : (
          <s-grid
            gridTemplateColumns={
              showTree && showEditor ? "280px minmax(0, 1fr)" : "1fr"
            }
            gap="base"
            alignItems="start"
          >
            {showTree ? treeColumn : null}

            {showEditor && !selected ? (
              <s-section heading="Choose a product type">
                <s-text color="subdued">
                  Pick one on the left to see and decide what it needs.
                </s-text>
              </s-section>
            ) : null}

            {showEditor && selected && details ? (
              <s-stack direction="block" gap="base">
                {narrow ? (
                  <s-stack direction="inline">
                    <s-button
                      variant="tertiary"
                      icon="chevron-left"
                      onClick={() => {
                        rememberType(null);
                        void navigate(PRODUCT_SETUP_ROUTES.types);
                      }}
                    >
                      All product types
                    </s-button>
                  </s-stack>
                ) : null}

                <s-section>
                  <s-stack direction="block" gap="base">
                    <s-grid
                      gridTemplateColumns="1fr auto"
                      gap="base"
                      alignItems="start"
                    >
                      <s-stack direction="block" gap="small-500">
                        {selected.parents.length > 0 ? (
                          <s-text color="subdued">
                            {selected.parents.join(" › ")}
                          </s-text>
                        ) : null}
                        <s-heading>{selected.name}</s-heading>
                        <s-text color="subdued">
                          {selected.rows.length === 0
                            ? selected.leaf
                              ? "Product type · no attributes yet"
                              : "Organising category · no attributes yet"
                            : `${selected.leaf ? "Product type" : "Organising category"} · ${countOf(selected.rows.length, "attribute")} · ${selected.required} required · ${selected.rows.length - selected.required} optional`}
                        </s-text>
                      </s-stack>
                      <s-stack direction="inline" gap="small-300">
                        <s-button
                          icon="menu-horizontal"
                          accessibilityLabel={`More actions for ${selected.name}`}
                          command="--show"
                          commandFor={MENU_ID}
                        />
                        <s-menu
                          id={MENU_ID}
                          accessibilityLabel={`Actions for ${selected.name}`}
                        >
                          <s-button
                            command="--show"
                            commandFor={ADD_MODAL_ID}
                            onClick={() => {
                              setNewType({
                                ...BLANK_TYPE,
                                parentId: selected.id,
                              });
                              setNewTypeTried(false);
                            }}
                          >
                            Add child type
                          </s-button>
                          <s-button onClick={() => setTab("details")}>
                            Rename or edit details
                          </s-button>
                          <s-button
                            command="--show"
                            commandFor={MOVE_MODAL_ID}
                            onClick={() =>
                              setMoveTarget(selected.details.parentId)
                            }
                          >
                            Move to…
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
                            {...(selected.isLast || busy
                              ? { disabled: true }
                              : {})}
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
                        </s-menu>
                      </s-stack>
                    </s-grid>

                    <s-stack
                      direction="inline"
                      gap="small-300"
                      accessibilityRole="navigation"
                      accessibilityLabel="Sections of this product type"
                    >
                      {TABS.map((entry) => (
                        <s-button
                          key={entry}
                          variant={tab === entry ? "secondary" : "tertiary"}
                          accessibilityLabel={`${TAB_LABEL[entry]}${tab === entry ? ", current" : ""}`}
                          onClick={() => setTab(entry)}
                        >
                          {TAB_LABEL[entry]}
                        </s-button>
                      ))}
                    </s-stack>

                    {tab === "attributes" ? (
                      <s-stack direction="block" gap="base">
                        {selected.rows.length === 0 ? (
                          <s-stack direction="block" gap="base">
                            <s-text>{`No attributes assigned to ${selected.name}.`}</s-text>
                            <s-stack direction="inline" gap="small-300">
                              <s-button
                                variant="primary"
                                command="--show"
                                commandFor={PICKER_MODAL_ID}
                                onClick={openPicker}
                              >
                                Add attributes
                              </s-button>
                              {selected.picker.sets.some(
                                (set) => !set.attachedHere,
                              ) ? (
                                <s-button
                                  command="--show"
                                  commandFor={PICKER_MODAL_ID}
                                  onClick={openPicker}
                                >
                                  Choose an attribute set
                                </s-button>
                              ) : null}
                            </s-stack>
                          </s-stack>
                        ) : (
                          <>
                            <s-grid
                              gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr 150px auto"
                              gap="small-300"
                              alignItems="end"
                            >
                              {selected.rows.length > 6 ? (
                                <s-search-field
                                  label="Find an attribute"
                                  labelAccessibilityVisibility="exclusive"
                                  placeholder="Find an attribute"
                                  value={fieldQuery}
                                  onInput={(event) =>
                                    setFieldQuery(event.currentTarget.value)
                                  }
                                />
                              ) : (
                                <s-box />
                              )}
                              <Dropdown
                                name="requirementFilter"
                                label="Show"
                                hideLabel
                                value={requirementFilter}
                                options={[
                                  { value: "all", label: "All" },
                                  { value: "required", label: "Required" },
                                  { value: "optional", label: "Optional" },
                                ]}
                                onChange={setRequirementFilter}
                              />
                              <s-button
                                variant="primary"
                                command="--show"
                                commandFor={PICKER_MODAL_ID}
                                onClick={openPicker}
                              >
                                Add attributes
                              </s-button>
                            </s-grid>

                            {rows.length === 0 ? (
                              <s-text color="subdued">
                                No attribute matches.
                              </s-text>
                            ) : (
                              <s-table variant="auto">
                                <s-table-header-row>
                                  <s-table-header listSlot="primary">
                                    Attribute
                                  </s-table-header>
                                  <s-table-header listSlot="secondary">
                                    Format
                                  </s-table-header>
                                  <s-table-header listSlot="labeled">
                                    Requirement
                                  </s-table-header>
                                  <s-table-header listSlot="kicker">
                                    Source
                                  </s-table-header>
                                  <s-table-header listSlot="inline">
                                    Actions
                                  </s-table-header>
                                </s-table-header-row>
                                <s-table-body>
                                  {rows.map((row) => (
                                    <s-table-row key={row.attributeId}>
                                      <s-table-cell>
                                        <s-link
                                          command="--show"
                                          commandFor={EDIT_ATTRIBUTE_MODAL_ID}
                                          onClick={() =>
                                            setEditingAttributeId(
                                              row.attributeId,
                                            )
                                          }
                                        >
                                          {row.name}
                                        </s-link>
                                      </s-table-cell>
                                      <s-table-cell>{`${row.format} · ${row.scope}`}</s-table-cell>
                                      <s-table-cell>
                                        <s-stack
                                          direction="block"
                                          gap="small-500"
                                        >
                                          <Dropdown
                                            name={`requirement-${row.attributeId}`}
                                            label={`Requirement for ${row.name}`}
                                            hideLabel
                                            value={
                                              row.required
                                                ? "required"
                                                : "optional"
                                            }
                                            options={[
                                              {
                                                value: "required",
                                                label: "Required",
                                              },
                                              {
                                                value: "optional",
                                                label: "Optional",
                                              },
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
                                          {row.overridden ? (
                                            <s-text color="subdued">
                                              Changed for this type
                                            </s-text>
                                          ) : null}
                                        </s-stack>
                                      </s-table-cell>
                                      <s-table-cell>
                                        {row.here
                                          ? "Here"
                                          : `From ${row.sourceName}`}
                                      </s-table-cell>
                                      <s-table-cell>
                                        <s-button
                                          icon="menu-horizontal"
                                          variant="tertiary"
                                          accessibilityLabel={`Actions for ${row.name}`}
                                          command="--show"
                                          commandFor={`row-menu-${row.attributeId}`}
                                        />
                                        <s-menu
                                          id={`row-menu-${row.attributeId}`}
                                          accessibilityLabel={`Actions for ${row.name}`}
                                        >
                                          <s-button
                                            command="--show"
                                            commandFor={EDIT_ATTRIBUTE_MODAL_ID}
                                            onClick={() =>
                                              setEditingAttributeId(
                                                row.attributeId,
                                              )
                                            }
                                          >
                                            Edit attribute
                                          </s-button>
                                          {row.overridden ? (
                                            <s-button
                                              onClick={() =>
                                                submit({
                                                  intent: "set-requirement",
                                                  attributeId: row.attributeId,
                                                  value: "reset",
                                                })
                                              }
                                            >
                                              Reset to attribute default
                                            </s-button>
                                          ) : null}
                                          <s-button
                                            tone="critical"
                                            onClick={() =>
                                              submit({
                                                intent: "remove",
                                                attributeId: row.attributeId,
                                              })
                                            }
                                          >
                                            Remove from this type
                                          </s-button>
                                        </s-menu>
                                      </s-table-cell>
                                    </s-table-row>
                                  ))}
                                </s-table-body>
                              </s-table>
                            )}
                          </>
                        )}

                        {selected.removed.length > 0 ? (
                          <s-stack direction="block" gap="small-300">
                            <s-divider />
                            <s-text type="strong">
                              {`Removed from ${selected.name} (${selected.removed.length})`}
                            </s-text>
                            <s-text color="subdued">
                              Hidden on this type alone; other types and the
                              catalogue are unchanged.
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

                        {selected.setSources.length +
                          selected.attributeSources.length >
                        0 ? (
                          <s-stack direction="block" gap="small-300">
                            <s-divider />
                            <s-stack
                              direction="inline"
                              gap="small-300"
                              alignItems="center"
                            >
                              <s-button
                                variant="tertiary"
                                icon={
                                  sourcesOpen ? "chevron-up" : "chevron-down"
                                }
                                accessibilityLabel={
                                  sourcesOpen ? "Hide sources" : "Show sources"
                                }
                                onClick={() => setSourcesOpen((now) => !now)}
                              >
                                {`Where these come from (${countOf(selected.setSources.length + selected.attributeSources.length, "source")})`}
                              </s-button>
                            </s-stack>
                            {sourcesOpen ? (
                              <s-stack direction="block" gap="small-300">
                                <s-text color="subdued">
                                  A source attached here reaches this type and
                                  every type beneath it; detaching it takes it
                                  from all of them.
                                </s-text>
                                {[
                                  ...selected.setSources.map((s) => ({
                                    ...s,
                                    kind: "set" as const,
                                  })),
                                  ...selected.attributeSources.map((s) => ({
                                    ...s,
                                    kind: "attribute" as const,
                                  })),
                                ].map((source) => (
                                  <s-grid
                                    key={`${source.kind}-${source.assignmentId}`}
                                    gridTemplateColumns="1fr auto"
                                    gap="small-300"
                                    alignItems="center"
                                  >
                                    <s-text>
                                      <s-text type="strong">
                                        {source.name}
                                      </s-text>
                                      {` · ${source.kind === "set" ? "set" : "attribute"} ${source.here ? "attached here" : `attached on ${source.typeName}`}`}
                                    </s-text>
                                    {source.here ? (
                                      <s-button
                                        variant="tertiary"
                                        tone="critical"
                                        command="--show"
                                        commandFor={DETACH_MODAL_ID}
                                        onClick={() =>
                                          setPendingDetach({
                                            kind: source.kind,
                                            assignmentId: source.assignmentId,
                                            name: source.name,
                                          })
                                        }
                                        {...(busy ? { disabled: true } : {})}
                                      >
                                        Detach
                                      </s-button>
                                    ) : (
                                      <s-link
                                        href={PRODUCT_SETUP_ROUTES.type(
                                          source.typeId,
                                        )}
                                      >
                                        {`Go to ${source.typeName}`}
                                      </s-link>
                                    )}
                                  </s-grid>
                                ))}
                              </s-stack>
                            ) : null}
                          </s-stack>
                        ) : null}
                      </s-stack>
                    ) : null}

                    {tab === "details" ? (
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
                          {...(detailsTried && details.name.trim() === ""
                            ? { error: "Enter a name." }
                            : {})}
                        />
                        <Dropdown
                          name="parentId"
                          label="Under"
                          details={
                            details.parentId === selected.details.parentId
                              ? "It inherits every attribute of the type above it."
                              : describeMove(
                                  selected.moveImpacts[details.parentId],
                                )
                          }
                          value={details.parentId}
                          options={selected.parentOptions}
                          onChange={(parentId) =>
                            setDetails({ ...details, parentId })
                          }
                        />
                        <s-choice-list
                          label="Kind"
                          name="kind"
                          values={[details.kind]}
                          onChange={(event) => {
                            const next = event.currentTarget.values[0];
                            if (next === "type" || next === "category")
                              setDetails({ ...details, kind: next });
                          }}
                        >
                          <s-choice value="type">
                            Product type
                            <s-text slot="details" color="subdued">
                              Products can be assigned to it.
                            </s-text>
                          </s-choice>
                          <s-choice value="category">
                            Organising category
                            <s-text slot="details" color="subdued">
                              Only groups the types beneath it; no product is
                              assigned to it directly.
                            </s-text>
                          </s-choice>
                        </s-choice-list>
                        <s-text-field
                          label="Shopify category (optional)"
                          details="The standard product category this matches; a note for now."
                          value={details.shopifyCategory}
                          onInput={(event) =>
                            setDetails({
                              ...details,
                              shopifyCategory: event.currentTarget.value,
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
                        <s-text color="subdued">
                          Changes here are saved with the bar at the top of the
                          page.
                        </s-text>
                      </s-stack>
                    ) : null}

                    {tab === "preview" ? (
                      <s-stack direction="block" gap="base">
                        <s-text color="subdued">
                          {`The fields a product of ${selected.name} would carry, in the order they would be asked for.`}
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
                                Format
                              </s-table-header>
                              <s-table-header listSlot="labeled">
                                Shopify field
                              </s-table-header>
                              <s-table-header listSlot="inline">
                                Requirement
                              </s-table-header>
                            </s-table-header-row>
                            <s-table-body>
                              {selected.preview.map((row) => (
                                <s-table-row key={row.attributeId}>
                                  <s-table-cell>{row.name}</s-table-cell>
                                  <s-table-cell>{row.format}</s-table-cell>
                                  <s-table-cell>
                                    {row.key ? (
                                      <s-text color="subdued">{row.key}</s-text>
                                    ) : (
                                      <s-badge tone="warning">
                                        Not mapped
                                      </s-badge>
                                    )}
                                  </s-table-cell>
                                  <s-table-cell>
                                    {row.required ? "Required" : "Optional"}
                                  </s-table-cell>
                                </s-table-row>
                              ))}
                            </s-table-body>
                          </s-table>
                        )}
                      </s-stack>
                    ) : null}
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
