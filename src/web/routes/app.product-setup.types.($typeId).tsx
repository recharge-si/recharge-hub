import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
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
  AttributeCreatePanel,
  AttributeEditPanel,
  editableAttribute,
  useAttributeCreate,
  useAttributeEdit,
  type EditableAttribute,
} from "~/web/components/attribute-form";
import { Dropdown } from "~/web/components/dropdown";
import { ProductSetupNav } from "~/web/components/product-setup-nav";
import {
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
import { useResetWhenSaved } from "~/web/lib/use-save-bar";

/**
 * Product types (docs/attributes.md § Screens): the tree beside the
 * selected type. Choose a type, decide what information it needs.
 *
 * The tree is the page; a type opens as a dialog over it, with everything
 * about that type inside — its attributes, its details, a preview, adding
 * attributes, editing one, moving and deleting — as steps of one dialog,
 * since a dialog cannot open another. The address names the open type, so
 * a refresh, a link and the back button land on it.
 */
const ADD_MODAL_ID = "add-product-type";
const TYPE_MODAL_ID = "product-type";
const MENU_ID = "product-type-actions";
const DROP_MODAL_ID = "confirm-drop";

/** One level of the tree, in pixels; the same step every level down. */
const INDENT_PX = 28;

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
  return y < 0.3 ? "before" : y > 0.7 ? "after" : "inside";
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
      const result = await commit("attribute_schema.type.deleted", (schema) =>
        deleteType(schema, typeId),
      );
      if (result.ok) throw redirectWithin(request, PRODUCT_SETUP_ROUTES.types);
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

/**
 * What the type dialog shows. The first three are the tabs; the rest are
 * steps a tab leads to and comes back from, so no second dialog is ever
 * needed on top of this one.
 */
type View =
  | "attributes"
  | "details"
  | "preview"
  | "add"
  | "new"
  | "child"
  | "move"
  | "delete"
  | `attribute:${string}`;

const BLANK_TYPE = {
  name: "",
  parentId: "",
  kind: "type" as "type" | "category",
  shopifyCategory: "",
};

/** A drag ghost that follows the cursor: the row's name on a small card. */
function attachDragGhost(event: React.DragEvent<HTMLElement>, name: string) {
  const ghost = document.createElement("div");
  ghost.textContent = name;
  ghost.style.cssText =
    "position:fixed;top:-1000px;left:-1000px;padding:6px 12px;background:#fff;color:#303030;border:1px solid #e3e3e3;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.15);font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:nowrap;";
  document.body.appendChild(ghost);
  event.dataTransfer.setDragImage(ghost, 12, 18);
  setTimeout(() => ghost.remove(), 0);
}

export default function ProductTypes() {
  const { revision, stage, summary, tree, selected, typeOptions, sets } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const navigate = useNavigate();

  const [treeQuery, setTreeQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Which row is being dragged: a ref for the drop targets, which read it
  // in `dragover` before React has re-rendered, and state for what shows.
  const draggingRef = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const startDrag = (id: string | null) => {
    draggingRef.current = id;
    setDragging(id);
  };
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
  const [newType, setNewType] = useState<typeof BLANK_TYPE>(BLANK_TYPE);
  const [newTypeTried, setNewTypeTried] = useState(false);

  // The type dialog. Opened by the address: choosing a row navigates to the
  // type, and the dialog shows once the loader has it; closing it goes back
  // to the bare tree. A refresh or a link with a type in it opens it too.
  const typeOverlay = useRef<Overlay | null>(null);
  const openedFor = useRef<string | null>(null);
  const requestedView = useRef<View>("attributes");
  const [view, setView] = useState<View>("attributes");
  const [fieldQuery, setFieldQuery] = useState("");
  const [requirementFilter, setRequirementFilter] = useState("all");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [pendingDetach, setPendingDetach] = useState<{
    kind: "set" | "attribute";
    assignmentId: string;
    name: string;
  } | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickedAttributes, setPickedAttributes] = useState<string[]>([]);
  const [pickedSets, setPickedSets] = useState<string[]>([]);
  const [pickerTried, setPickerTried] = useState(false);
  const [moveTarget, setMoveTarget] = useState("");
  const [child, setChild] = useState<typeof BLANK_TYPE>(BLANK_TYPE);
  const [childTried, setChildTried] = useState(false);

  const savedDetails = selected?.details ?? null;
  const [details, setDetails] = useState<Details | null>(savedDetails);
  const [detailsTried, setDetailsTried] = useState(false);
  const savedKey = savedDetails ? normalise(savedDetails) : "";
  const resetDetails = useCallback(() => {
    setDetails(savedDetails);
    setDetailsTried(false);
  }, [savedDetails]);
  useResetWhenSaved(`${selected?.id ?? ""}:${savedKey}`, resetDetails);

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  // While a row is being dragged, the page accepts every dragover as a
  // move, so the cursor never turns into a "not allowed" sign over a gap or
  // an invalid target; dropping somewhere that means nothing does nothing.
  useEffect(() => {
    if (dragging === null) return;
    const allow = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    };
    const swallow = (event: DragEvent) => event.preventDefault();
    document.addEventListener("dragover", allow);
    document.addEventListener("drop", swallow);
    return () => {
      document.removeEventListener("dragover", allow);
      document.removeEventListener("drop", swallow);
    };
  }, [dragging]);

  useEffect(() => {
    if (!selected) {
      openedFor.current = null;
      return;
    }
    if (openedFor.current === selected.id) return;
    openedFor.current = selected.id;
    setView(requestedView.current);
    requestedView.current = "attributes";
    setFieldQuery("");
    setRequirementFilter("all");
    setSourcesOpen(false);
    setPendingDetach(null);
    typeOverlay.current?.showOverlay?.();
  }, [selected]);

  // Adding several attributes returns the dialog to the list once they are in.
  const lastAttach = useRef<typeof result>(undefined);
  useEffect(() => {
    if (!result?.ok || result === lastAttach.current) return;
    lastAttach.current = result;
    if (view === "add" || view === "delete" || view === "move")
      setView("attributes");
  }, [result, view]);

  const submit = (fields: Record<string, string>) =>
    fetcher.submit(
      { ...fields, revision: String(revision) },
      { method: "post" },
    );

  const open = (typeId: string, at: View = "attributes") => {
    requestedView.current = at;
    if (selected?.id === typeId) {
      setView(at);
      typeOverlay.current?.showOverlay?.();
      return;
    }
    void navigate(PRODUCT_SETUP_ROUTES.type(typeId));
  };

  const closeType = () => {
    openedFor.current = null;
    setView("attributes");
    resetDetails();
    if (selected) void navigate(PRODUCT_SETUP_ROUTES.types, { replace: true });
  };

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
    startDrag(null);
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
    setView("add");
  };

  const editingAttribute =
    view.startsWith("attribute:") && selected
      ? (selected.rows.find((row) => row.attributeId === view.slice(10))
          ?.editable ?? null)
      : null;

  const tabs: Array<{ key: View; label: string }> = [
    { key: "attributes", label: "Attributes" },
    { key: "details", label: "Details" },
    { key: "preview", label: "Preview" },
  ];

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
          setNewType(BLANK_TYPE);
          setNewTypeTried(false);
        }}
      >
        Add product type
      </s-button>

      {/* --- Add a product type (from the page) ---------------------------- */}
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

      {/* --- A drop that changes the parent ------------------------------- */}
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

      {/* --- The type dialog ----------------------------------------------- */}
      <s-modal
        id={TYPE_MODAL_ID}
        heading={selected?.name ?? "Product type"}
        size="large"
        ref={(element) => {
          typeOverlay.current = (element as Overlay) ?? null;
        }}
        onAfterHide={(event) => {
          if (event.target !== event.currentTarget) return;
          closeType();
        }}
      >
        {selected && details ? (
          <>
            <s-box paddingBlockEnd="base">
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
                    <s-text color="subdued">
                      {selected.rows.length === 0
                        ? selected.leaf
                          ? "Product type · no attributes yet"
                          : "Organising category · no attributes yet"
                        : `${selected.leaf ? "Product type" : "Organising category"} · ${countOf(selected.rows.length, "attribute")} · ${selected.required} required · ${selected.rows.length - selected.required} optional`}
                    </s-text>
                  </s-stack>
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
                      onClick={() => {
                        setChild(BLANK_TYPE);
                        setChildTried(false);
                        setView("child");
                      }}
                    >
                      Add child type
                    </s-button>
                    <s-button
                      onClick={() => {
                        setMoveTarget(selected.details.parentId);
                        setView("move");
                      }}
                    >
                      Move to…
                    </s-button>
                    <s-button
                      onClick={() => submit({ intent: "move-up" })}
                      {...(selected.isFirst || busy ? { disabled: true } : {})}
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
                      onClick={() => setView("delete")}
                      {...(busy ? { disabled: true } : {})}
                    >
                      Delete
                    </s-button>
                  </s-menu>
                </s-grid>

                {view === "attributes" ||
                view === "details" ||
                view === "preview" ? (
                  <s-stack
                    direction="inline"
                    gap="small-300"
                    accessibilityRole="navigation"
                    accessibilityLabel="Sections of this product type"
                  >
                    {tabs.map((entry) => (
                      <s-button
                        key={entry.key}
                        variant={view === entry.key ? "secondary" : "tertiary"}
                        accessibilityLabel={`${entry.label}${view === entry.key ? ", current" : ""}`}
                        onClick={() => setView(entry.key)}
                      >
                        {entry.label}
                      </s-button>
                    ))}
                  </s-stack>
                ) : null}
              </s-stack>
            </s-box>

            {result && !result.ok ? (
              <s-box paddingBlockEnd="base">
                <s-banner tone="critical" heading="That did not work">
                  <s-paragraph>{result.message}</s-paragraph>
                </s-banner>
              </s-box>
            ) : null}

            {/* ---- Attributes ---- */}
            {view === "attributes" ? (
              <>
                <s-stack direction="block" gap="base">
                  {selected.rows.length === 0 ? (
                    <s-text>{`No attributes assigned to ${selected.name}.`}</s-text>
                  ) : (
                    <>
                      {selected.rows.length > 6 ? (
                        <s-grid
                          gridTemplateColumns="1fr 150px"
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
                              { value: "all", label: "All" },
                              { value: "required", label: "Required" },
                              { value: "optional", label: "Optional" },
                            ]}
                            onChange={setRequirementFilter}
                          />
                        </s-grid>
                      ) : null}
                      {rows.length === 0 ? (
                        <s-text color="subdued">No attribute matches.</s-text>
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
                                    onClick={() =>
                                      setView(`attribute:${row.attributeId}`)
                                    }
                                  >
                                    {row.name}
                                  </s-link>
                                </s-table-cell>
                                <s-table-cell>{`${row.format} · ${row.scope}`}</s-table-cell>
                                <s-table-cell>
                                  <s-stack direction="block" gap="small-500">
                                    <Dropdown
                                      name={`requirement-${row.attributeId}`}
                                      label={`Requirement for ${row.name}`}
                                      hideLabel
                                      value={
                                        row.required ? "required" : "optional"
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
                                  {row.here ? "Here" : `From ${row.sourceName}`}
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
                                      onClick={() =>
                                        setView(`attribute:${row.attributeId}`)
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
                        Hidden on this type alone; other types and the catalogue
                        are unchanged.
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
                          icon={sourcesOpen ? "chevron-up" : "chevron-down"}
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
                            A source attached here reaches this type and every
                            type beneath it; detaching it takes it from all of
                            them.
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
                                <s-text type="strong">{source.name}</s-text>
                                {` · ${source.kind === "set" ? "set" : "attribute"} ${source.here ? "attached here" : `attached on ${source.typeName}`}`}
                              </s-text>
                              {pendingDetach?.assignmentId ===
                              source.assignmentId ? (
                                <s-stack direction="inline" gap="small-400">
                                  <s-button
                                    tone="critical"
                                    variant="primary"
                                    onClick={() => {
                                      submit({
                                        intent:
                                          source.kind === "set"
                                            ? "detach-set"
                                            : "detach-attribute",
                                        assignmentId: source.assignmentId,
                                      });
                                      setPendingDetach(null);
                                    }}
                                    {...(busy ? { disabled: true } : {})}
                                  >
                                    Detach
                                  </s-button>
                                  <s-button
                                    onClick={() => setPendingDetach(null)}
                                  >
                                    Keep
                                  </s-button>
                                </s-stack>
                              ) : source.here ? (
                                <s-button
                                  variant="tertiary"
                                  tone="critical"
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
                                <s-button
                                  variant="tertiary"
                                  onClick={() => open(source.typeId)}
                                >
                                  {`Go to ${source.typeName}`}
                                </s-button>
                              )}
                            </s-grid>
                          ))}
                          {pendingDetach ? (
                            <s-text color="subdued">
                              {`${selected.name} and every type beneath it lose ${pendingDetach.kind === "set" ? "the set's attributes" : "it"}, unless another source supplies ${pendingDetach.kind === "set" ? "them" : "it"}. To hide an attribute on this type alone, remove it from the list instead.`}
                            </s-text>
                          ) : null}
                        </s-stack>
                      ) : null}
                    </s-stack>
                  ) : null}
                </s-stack>
                <s-button
                  slot="primary-action"
                  variant="primary"
                  onClick={openPicker}
                >
                  Add attributes
                </s-button>
                <s-button
                  slot="secondary-actions"
                  command="--hide"
                  commandFor={TYPE_MODAL_ID}
                >
                  Close
                </s-button>
              </>
            ) : null}

            {/* ---- Details ---- */}
            {view === "details" ? (
              <>
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
                        : describeMove(selected.moveImpacts[details.parentId])
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
                        Only groups the types beneath it; no product is assigned
                        to it directly.
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
                </s-stack>
                <s-button
                  slot="primary-action"
                  variant="primary"
                  onClick={saveDetails}
                  {...(busy || normalise(details) === savedKey
                    ? { disabled: true }
                    : {})}
                >
                  Save
                </s-button>
                <s-button
                  slot="secondary-actions"
                  onClick={() => {
                    resetDetails();
                    setView("attributes");
                  }}
                >
                  Cancel
                </s-button>
              </>
            ) : null}

            {/* ---- Preview ---- */}
            {view === "preview" ? (
              <>
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
                                <s-badge tone="warning">Not mapped</s-badge>
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
                <s-button
                  slot="primary-action"
                  variant="primary"
                  command="--hide"
                  commandFor={TYPE_MODAL_ID}
                >
                  Close
                </s-button>
              </>
            ) : null}

            {/* ---- Add attributes ---- */}
            {view === "add" ? (
              <>
                <s-stack direction="block" gap="base">
                  <s-text color="subdued">
                    {`Whatever is added here reaches ${selected.name} and every type beneath it.`}
                  </s-text>
                  {selected.picker.attributes.length +
                    selected.picker.sets.length >
                  6 ? (
                    <s-search-field
                      label="Search attributes and sets"
                      labelAccessibilityVisibility="exclusive"
                      placeholder="Search"
                      value={pickerQuery}
                      onInput={(event) =>
                        setPickerQuery(event.currentTarget.value)
                      }
                    />
                  ) : null}
                  <s-grid
                    gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr 1fr"
                    gap="large"
                    alignItems="start"
                  >
                    {selected.picker.attributes.length === 0 ? (
                      <s-text color="subdued">
                        No attributes are defined yet. Create the first one with
                        the button below.
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
                  </s-grid>
                  {pickerTried && pickedCount === 0 ? (
                    <s-text tone="critical">
                      Choose at least one attribute or set.
                    </s-text>
                  ) : null}
                </s-stack>
                <s-button
                  slot="primary-action"
                  variant="primary"
                  onClick={() => {
                    setPickerTried(true);
                    if (pickedCount === 0) return;
                    submit({
                      intent: "attach-many",
                      attributeIds: JSON.stringify(pickedAttributes),
                      setIds: JSON.stringify(pickedSets),
                    });
                  }}
                  {...(busy ? { disabled: true, loading: true } : {})}
                >
                  {pickedCount === 0
                    ? "Add selected"
                    : `Add ${pickedCount} selected`}
                </s-button>
                <s-button
                  slot="secondary-actions"
                  onClick={() => setView("new")}
                >
                  New attribute
                </s-button>
                <s-button
                  slot="secondary-actions"
                  onClick={() => setView("attributes")}
                >
                  Back
                </s-button>
              </>
            ) : null}

            {/* ---- A new attribute, added here ---- */}
            {view === "new" ? (
              <NewAttributeView
                revision={revision}
                sets={sets}
                types={typeOptions}
                typeId={selected.id}
                onDone={() => setView("attributes")}
                onBack={() => setView("add")}
              />
            ) : null}

            {/* ---- One attribute's definition ---- */}
            {editingAttribute ? (
              <EditAttributeView
                key={editingAttribute.id}
                revision={revision}
                sets={sets}
                attribute={editingAttribute}
                onDone={() => setView("attributes")}
                onBack={() => setView("attributes")}
              />
            ) : null}

            {/* ---- A child type ---- */}
            {view === "child" ? (
              <>
                <s-stack direction="block" gap="base">
                  <s-text color="subdued">
                    {`Under ${selected.name}; it inherits every attribute ${selected.name} has.`}
                  </s-text>
                  <s-text-field
                    label="Name"
                    placeholder="Freeride sails"
                    value={child.name}
                    onInput={(event) =>
                      setChild({ ...child, name: event.currentTarget.value })
                    }
                    {...(childTried && child.name.trim() === ""
                      ? { error: "Enter a name." }
                      : {})}
                  />
                  <s-choice-list
                    label="Kind"
                    name="childKind"
                    values={[child.kind]}
                    onChange={(event) => {
                      const next = event.currentTarget.values[0];
                      if (next === "type" || next === "category")
                        setChild({ ...child, kind: next });
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
                </s-stack>
                <s-button
                  slot="primary-action"
                  variant="primary"
                  onClick={() => {
                    setChildTried(true);
                    if (child.name.trim() === "") return;
                    submit({
                      intent: "add-type",
                      name: child.name,
                      parentId: selected.id,
                      kind: child.kind,
                      shopifyCategory: "",
                    });
                  }}
                  {...(busy ? { disabled: true, loading: true } : {})}
                >
                  Add child type
                </s-button>
                <s-button
                  slot="secondary-actions"
                  onClick={() => setView("attributes")}
                >
                  Back
                </s-button>
              </>
            ) : null}

            {/* ---- Move ---- */}
            {view === "move" ? (
              <>
                <s-stack direction="block" gap="base">
                  <Dropdown
                    name="moveTarget"
                    label="Under"
                    value={moveTarget}
                    options={selected.parentOptions}
                    onChange={setMoveTarget}
                  />
                  <s-text color="subdued">
                    {moveTarget === selected.details.parentId
                      ? "That is where it is now."
                      : describeMove(selected.moveImpacts[moveTarget])}
                  </s-text>
                </s-stack>
                <s-button
                  slot="primary-action"
                  variant="primary"
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
                  onClick={() => setView("attributes")}
                >
                  Back
                </s-button>
              </>
            ) : null}

            {/* ---- Delete ---- */}
            {view === "delete" ? (
              <>
                <s-paragraph>
                  {describeDelete(
                    selected.name,
                    selected.parentName,
                    selected.deleteImpact,
                  )}
                </s-paragraph>
                <s-button
                  slot="primary-action"
                  variant="primary"
                  tone="critical"
                  command="--hide"
                  commandFor={TYPE_MODAL_ID}
                  onClick={() => submit({ intent: "delete-type" })}
                  {...(busy ? { disabled: true } : {})}
                >
                  Delete
                </s-button>
                <s-button
                  slot="secondary-actions"
                  onClick={() => setView("attributes")}
                >
                  Keep it
                </s-button>
              </>
            ) : null}
          </>
        ) : null}
      </s-modal>

      <s-stack direction="block" gap="base">
        <ProductSetupNav current="types" />

        {result && !result.ok && !selected ? (
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
          <s-section heading="Product types">
            {/*
             * The one piece of styling of our own in the app: a drag handle
             * needs a grab cursor and a hover, and Polaris has no drag
             * handle. Scoped to the class, nothing else is touched.
             */}
            <style>{`
              .ps-row { display: flex; align-items: stretch; border-radius: 8px; }
              .ps-row.is-target { outline: 2px solid #005bd3; outline-offset: -2px; background: #f1f6fd; }
              .ps-row.is-dragging { opacity: .45; }
              .ps-guide { flex: 0 0 ${INDENT_PX - 12}px; margin-left: 12px; border-left: 1px solid #e3e3e3; }
              .ps-row-body { flex: 1; min-width: 0; }
              .ps-drag-handle { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 32px; margin-inline-end: 2px; border-radius: 6px; cursor: grab; user-select: none; -webkit-user-drag: element; touch-action: none; }
              .ps-drag-handle:hover { background: #ebebeb; }
              .ps-drag-handle:active { cursor: grabbing; }
              .ps-twisty { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 28px; margin-inline-end: 2px; padding: 0; border: 0; background: transparent; border-radius: 6px; cursor: pointer; }
              button.ps-twisty:hover { background: #ebebeb; }
              button.ps-twisty:disabled { cursor: default; opacity: .5; }
              .ps-drop-line { height: 0; border-top: 2px solid #005bd3; border-radius: 2px; position: relative; }
              .ps-drop-line::before { content: ""; position: absolute; left: -4px; top: -5px; width: 8px; height: 8px; border-radius: 50%; background: #005bd3; }
            `}</style>
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
                 * A plain element carries the drag, because the Polaris row
                 * owns its own DOM. Dropping on a row's middle nests beneath
                 * it; its top or bottom quarter places beside it.
                 */
                <div
                  key={row.id}
                  onDragOver={(event) => {
                    const source = draggingRef.current;
                    if (source === null || source === row.id) return;
                    if (isWithinRow(row.id, source)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const position = positionFrom(event);
                    if (
                      dropTarget?.id !== row.id ||
                      dropTarget.position !== position
                    )
                      setDropTarget({ id: row.id, position });
                  }}
                  onDragLeave={() => {
                    if (dropTarget?.id === row.id) setDropTarget(null);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const sourceId =
                      draggingRef.current ??
                      event.dataTransfer.getData("text/plain");
                    if (sourceId) drop(sourceId, row.id, positionFrom(event));
                  }}
                >
                  {dropTarget?.id === row.id &&
                  dropTarget.position === "before" ? (
                    <div
                      className="ps-drop-line"
                      style={{ marginInlineStart: row.depth * INDENT_PX + 12 }}
                    />
                  ) : null}
                  <div
                    className={`ps-row${
                      dropTarget?.id === row.id &&
                      dropTarget.position === "inside"
                        ? " is-target"
                        : ""
                    }${dragging === row.id ? " is-dragging" : ""}`}
                  >
                    {Array.from({ length: row.depth }, (_, level) => (
                      <span
                        key={level}
                        className="ps-guide"
                        aria-hidden="true"
                      />
                    ))}
                    <div className="ps-row-body">
                      <s-grid
                        gridTemplateColumns="auto auto 1fr auto"
                        gap="none"
                        alignItems="center"
                      >
                        {/*
                         * The handle is the draggable thing, so a click on the
                         * row still opens it and a drag from the dots is
                         * unmistakably a drag. Its cursor and hover come from
                         * the small stylesheet above the tree.
                         */}
                        <span
                          className="ps-drag-handle"
                          draggable
                          title={`Drag to move ${row.name}`}
                          aria-label={`Drag to move ${row.name}`}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", row.id);
                            attachDragGhost(event, row.name);
                            startDrag(row.id);
                          }}
                          onDragEnd={() => {
                            startDrag(null);
                            setDropTarget(null);
                          }}
                        >
                          <s-icon type="drag-handle" color="subdued" />
                        </span>
                        {row.hasChildren ? (
                          <button
                            type="button"
                            className="ps-twisty"
                            aria-label={`${collapsed[row.id] ? "Expand" : "Collapse"} ${row.name}`}
                            aria-expanded={!(collapsed[row.id] && !needle)}
                            disabled={Boolean(needle)}
                            onClick={() =>
                              setCollapsed({
                                ...collapsed,
                                [row.id]: !collapsed[row.id],
                              })
                            }
                          >
                            <s-icon
                              type={
                                collapsed[row.id] && !needle
                                  ? "chevron-right"
                                  : "chevron-down"
                              }
                              color="subdued"
                            />
                          </button>
                        ) : (
                          <span className="ps-twisty" aria-hidden="true" />
                        )}
                        <s-clickable
                          onClick={() => open(row.id)}
                          borderRadius="base"
                          paddingInline="small-400"
                          paddingBlock="small-400"
                          inlineSize="100%"
                          background="transparent"
                          accessibilityLabel={`Open ${row.name}, ${row.leaf ? "product type" : "category"}, ${countOf(row.count, "attribute")}`}
                        >
                          <s-grid
                            gridTemplateColumns="1fr auto"
                            gap="small-300"
                            alignItems="center"
                          >
                            <s-text
                              {...(row.leaf ? {} : { type: "strong" as const })}
                            >
                              {row.name}
                            </s-text>
                            <s-text color="subdued">
                              {row.leaf
                                ? countOf(row.count, "attribute")
                                : `category · ${countOf(row.count, "attribute")}`}
                            </s-text>
                          </s-grid>
                        </s-clickable>
                        <s-button
                          variant="tertiary"
                          icon="edit"
                          accessibilityLabel={`Edit ${row.name}`}
                          onClick={() => open(row.id, "details")}
                        />
                      </s-grid>
                    </div>
                  </div>
                  {dropTarget?.id === row.id &&
                  dropTarget.position === "after" ? (
                    <div
                      className="ps-drop-line"
                      style={{ marginInlineStart: row.depth * INDENT_PX + 12 }}
                    />
                  ) : null}
                </div>
              ))}
              {dragging !== null &&
              (parentOf.get(dragging) ?? null) !== null ? (
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
                    const source = draggingRef.current;
                    if (source) drop(source, null, "inside");
                  }}
                >
                  <s-box
                    padding="small-300"
                    borderRadius="base"
                    borderWidth="base"
                    borderStyle="dashed"
                    borderColor={dropTarget?.id === "" ? "strong" : "subdued"}
                    background={
                      dropTarget?.id === "" ? "strong" : "transparent"
                    }
                  >
                    <s-text color="subdued">
                      Drop here to make it a top-level type
                    </s-text>
                  </s-box>
                </div>
              ) : null}
              <s-text color="subdued">
                Open a type to decide what it needs. Drag a row onto another to
                put it beneath, or to the edge of a row to place it beside.
              </s-text>
            </s-stack>
          </s-section>
        )}
      </s-stack>
    </s-page>
  );
}

/** The New attribute step inside the type dialog: the form and its footer. */
function NewAttributeView({
  revision,
  sets,
  types,
  typeId,
  onDone,
  onBack,
}: {
  revision: number;
  sets: Array<{ value: string; label: string }>;
  types: Array<{ value: string; label: string }>;
  typeId: string;
  onDone: () => void;
  onBack: () => void;
}) {
  const state = useAttributeCreate({
    revision,
    preselectedTypeId: typeId,
    onDone,
  });
  return (
    <>
      <AttributeCreatePanel state={state} sets={sets} types={types} />
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={state.submit}
        {...(state.busy ? { loading: true, disabled: true } : {})}
      >
        Add attribute
      </s-button>
      <s-button slot="secondary-actions" onClick={onBack}>
        Back
      </s-button>
    </>
  );
}

/** One attribute's definition inside the type dialog. */
function EditAttributeView({
  revision,
  sets,
  attribute,
  onDone,
  onBack,
}: {
  revision: number;
  sets: Array<{ value: string; label: string }>;
  attribute: EditableAttribute;
  onDone: () => void;
  onBack: () => void;
}) {
  const state = useAttributeEdit({ attribute, revision, onDone });
  return (
    <>
      <AttributeEditPanel state={state} attribute={attribute} sets={sets} />
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={state.save}
        {...(state.busy ? { loading: true, disabled: true } : {})}
      >
        Save
      </s-button>
      <s-button slot="secondary-actions" onClick={onBack}>
        Back
      </s-button>
    </>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
