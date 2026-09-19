import {
  activeAttributes,
  candidateAttributes,
  childrenOf,
  isWithin,
  typeById,
} from "~/domain/attributes/resolve";
import {
  isSelect,
  keyFor,
  slugify,
  type Attribute,
  type AttributeSchema,
  type DataType,
  type Implementation,
  type Scope,
  type ValueListItem,
} from "~/domain/attributes/types";
import type { IdSource } from "~/domain/attributes/types";

/**
 * Every change a person can make to the schema, as a pure function from the
 * document to the next one (docs/attributes.md § Changes).
 *
 * A change either produces a new document and a sentence for the toast, or
 * refuses with a sentence for the banner. Nothing here mutates its input,
 * reads a clock or picks an id: ids come from the injected source.
 */

export type MutationResult =
  | { ok: true; schema: AttributeSchema; message: string }
  | { ok: false; message: string };

const refuse = (message: string): MutationResult => ({ ok: false, message });
const done = (schema: AttributeSchema, message: string): MutationResult => ({
  ok: true,
  schema,
  message,
});

const same = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

function nextOrder(schema: AttributeSchema, parentId: string | null): number {
  return (
    Math.max(0, ...childrenOf(schema, parentId).map((type) => type.sortOrder)) +
    1000
  );
}

/* -------------------------------------------------------------------------- */
/* Product types                                                              */
/* -------------------------------------------------------------------------- */

export interface NewType {
  name: string;
  parentId: string | null;
  leaf: boolean;
  shopifyCategory: string;
}

export function addType(
  schema: AttributeSchema,
  input: NewType,
  ids: IdSource,
): MutationResult & { typeId?: string } {
  const name = input.name.trim();
  if (name === "") return refuse("Enter a name for the product type.");
  if (input.parentId !== null && typeById(schema, input.parentId) === null)
    return refuse("The parent product type no longer exists.");
  if (childrenOf(schema, input.parentId).some((t) => same(t.name, name)))
    return refuse(
      "A product type with that name already exists under the same parent.",
    );

  const id = ids("type");
  const result = done(
    {
      ...schema,
      types: [
        ...schema.types,
        {
          id,
          name,
          parentId: input.parentId,
          leaf: input.leaf,
          sortOrder: nextOrder(schema, input.parentId),
          shopifyCategory: input.shopifyCategory.trim(),
          archetype: "",
        },
      ],
    },
    "Product type added.",
  );
  return { ...result, typeId: id };
}

export interface TypePatch {
  name: string;
  parentId: string | null;
  leaf: boolean;
  shopifyCategory: string;
  archetype: string;
}

export function updateType(
  schema: AttributeSchema,
  typeId: string,
  patch: TypePatch,
): MutationResult {
  const type = typeById(schema, typeId);
  if (!type) return refuse("That product type no longer exists.");
  const name = patch.name.trim();
  if (name === "") return refuse("Enter a name for the product type.");
  if (patch.parentId !== null) {
    if (typeById(schema, patch.parentId) === null)
      return refuse("The parent product type no longer exists.");
    if (isWithin(schema, patch.parentId, typeId))
      return refuse(
        "A product type cannot be moved under itself or one of its descendants.",
      );
  }
  if (
    childrenOf(schema, patch.parentId).some(
      (t) => t.id !== typeId && same(t.name, name),
    )
  )
    return refuse(
      "A product type with that name already exists under the same parent.",
    );

  const moved = patch.parentId !== type.parentId;
  return done(
    {
      ...schema,
      types: schema.types.map((t) =>
        t.id === typeId
          ? {
              ...t,
              name,
              parentId: patch.parentId,
              leaf: patch.leaf,
              shopifyCategory: patch.shopifyCategory.trim(),
              archetype: patch.archetype.trim(),
              sortOrder: moved
                ? nextOrder(schema, patch.parentId)
                : t.sortOrder,
            }
          : t,
      ),
    },
    "Product type updated.",
  );
}

/** Children move up one level; every rule on the type goes with it. */
export function deleteType(
  schema: AttributeSchema,
  typeId: string,
): MutationResult {
  const type = typeById(schema, typeId);
  if (!type) return refuse("That product type no longer exists.");
  const children = childrenOf(schema, typeId);
  const base = nextOrder(schema, type.parentId);
  const notOn = <T extends { typeId: string }>(rows: T[]) =>
    rows.filter((row) => row.typeId !== typeId);

  return done(
    {
      ...schema,
      types: schema.types
        .filter((t) => t.id !== typeId)
        .map((t) => {
          const index = children.findIndex((child) => child.id === t.id);
          return index === -1
            ? t
            : { ...t, parentId: type.parentId, sortOrder: base + index };
        }),
      setAssignments: notOn(schema.setAssignments),
      attributeAssignments: notOn(schema.attributeAssignments),
      overrides: notOn(schema.overrides),
      exclusions: notOn(schema.exclusions),
    },
    `“${type.name}” deleted.`,
  );
}

export function moveType(
  schema: AttributeSchema,
  typeId: string,
  direction: "up" | "down",
): MutationResult {
  const type = typeById(schema, typeId);
  if (!type) return refuse("That product type no longer exists.");
  const siblings = childrenOf(schema, type.parentId);
  const from = siblings.findIndex((t) => t.id === typeId);
  const to = from + (direction === "up" ? -1 : 1);
  if (to < 0 || to >= siblings.length)
    return refuse(
      direction === "up"
        ? "It is already first among its siblings."
        : "It is already last among its siblings.",
    );
  const reordered = [...siblings];
  [reordered[from], reordered[to]] = [
    reordered[to] as (typeof siblings)[number],
    reordered[from] as (typeof siblings)[number],
  ];
  const order = new Map(
    reordered.map((t, index) => [t.id, (index + 1) * 1000]),
  );
  return done(
    {
      ...schema,
      types: schema.types.map((t) =>
        order.has(t.id) ? { ...t, sortOrder: order.get(t.id) as number } : t,
      ),
    },
    "Order changed.",
  );
}

/* -------------------------------------------------------------------------- */
/* Attributes                                                                 */
/* -------------------------------------------------------------------------- */

export interface NewAttribute {
  name: string;
  dataType: DataType;
  unit: string;
  description: string;
  scope: Scope;
  /** Empty means generate one from the name. */
  key: string;
  implementation: Implementation;
  setId: string | null;
  requiredDefault: boolean;
  /** The options, for a select type; ignored for any other. */
  options: ValueListItem[];
  /** Also attach it directly to this type, and so to its descendants. */
  attachToTypeId: string | null;
}

/** Trims and codes a list of options, or says what is wrong with them. */
function normaliseOptions(
  options: ValueListItem[],
): { ok: true; items: ValueListItem[] } | { ok: false; message: string } {
  const items = options.map((option) => ({
    code: option.code.trim() || slugify(option.en),
    en: option.en.trim(),
    si: option.si.trim(),
  }));
  if (items.some((item) => item.en === ""))
    return { ok: false, message: "Every option needs an English label." };
  if (new Set(items.map((item) => item.code)).size !== items.length)
    return { ok: false, message: "Every option needs a unique code." };
  return { ok: true, items };
}

function keyTaken(
  schema: AttributeSchema,
  key: string,
  scope: Scope,
  except: string | null,
): boolean {
  return schema.attributes.some(
    (attr) => attr.id !== except && attr.key === key && attr.scope === scope,
  );
}

export function addAttribute(
  schema: AttributeSchema,
  input: NewAttribute,
  ids: IdSource,
): MutationResult & { attributeId?: string } {
  const name = input.name.trim();
  if (name === "") return refuse("Enter a name for the attribute.");
  if (input.setId !== null && !schema.sets.some((s) => s.id === input.setId))
    return refuse("That attribute set no longer exists.");
  if (
    input.attachToTypeId !== null &&
    typeById(schema, input.attachToTypeId) === null
  )
    return refuse("That product type no longer exists.");

  const id = ids("attr");
  let key = input.key.trim() || keyFor(name);
  if (keyTaken(schema, key, input.scope, null)) key = `${key}_${id.slice(-4)}`;

  let valueLists = schema.valueLists;
  let valueListId: string | null = null;
  if (isSelect(input.dataType)) {
    const options = normaliseOptions(input.options);
    if (!options.ok) return refuse(options.message);
    valueListId = ids("options");
    valueLists = [...valueLists, { id: valueListId, items: options.items }];
  }

  const attribute: Attribute = {
    id,
    name,
    setId: input.setId,
    dataType: input.dataType,
    unit: input.unit.trim(),
    description: input.description.trim(),
    scope: input.scope,
    key,
    implementation: input.implementation,
    requiredDefault: input.requiredDefault,
    filterable: false,
    searchable: false,
    comparable: false,
    valueListId,
  };
  const result = done(
    {
      ...schema,
      attributes: [...schema.attributes, attribute],
      valueLists,
      attributeAssignments:
        input.attachToTypeId === null
          ? schema.attributeAssignments
          : [
              ...schema.attributeAssignments,
              { id: ids("aa"), typeId: input.attachToTypeId, attributeId: id },
            ],
    },
    "Attribute added.",
  );
  return { ...result, attributeId: id };
}

export interface AttributePatch {
  name: string;
  dataType: DataType;
  unit: string;
  description: string;
  setId: string | null;
  requiredDefault: boolean;
  filterable: boolean;
  searchable: boolean;
  comparable: boolean;
  key: string;
  scope: Scope;
  implementation: Implementation;
  /** The options, for a select type. Ignored for any other type. */
  options: ValueListItem[];
}

export function updateAttribute(
  schema: AttributeSchema,
  attributeId: string,
  patch: AttributePatch,
  ids: IdSource,
): MutationResult {
  const attribute = schema.attributes.find((a) => a.id === attributeId);
  if (!attribute) return refuse("That attribute no longer exists.");
  const name = patch.name.trim();
  if (name === "") return refuse("Enter a name for the attribute.");
  if (patch.setId !== null && !schema.sets.some((s) => s.id === patch.setId))
    return refuse("That attribute set no longer exists.");
  const key = patch.key.trim();
  if (key !== "" && keyTaken(schema, key, patch.scope, attributeId))
    return refuse(
      "Another attribute already uses that Shopify field in the same scope. Choose a unique key.",
    );

  let valueLists = schema.valueLists;
  let valueListId = attribute.valueListId;
  if (isSelect(patch.dataType)) {
    const options = normaliseOptions(patch.options);
    if (!options.ok) return refuse(options.message);
    const items = options.items;

    const shared = schema.attributes.some(
      (a) => a.id !== attributeId && a.valueListId === valueListId,
    );
    if (valueListId === null || shared) valueListId = ids("options");
    const listId = valueListId;
    valueLists = valueLists.some((list) => list.id === listId)
      ? valueLists.map((list) =>
          list.id === listId ? { id: listId, items } : list,
        )
      : [...valueLists, { id: listId, items }];
  }

  return done(
    {
      ...schema,
      attributes: schema.attributes.map((a) =>
        a.id === attributeId
          ? {
              ...a,
              name,
              dataType: patch.dataType,
              unit: patch.unit.trim(),
              description: patch.description.trim(),
              setId: patch.setId,
              requiredDefault: patch.requiredDefault,
              filterable: patch.filterable,
              searchable: patch.searchable,
              comparable: patch.comparable,
              key,
              scope: patch.scope,
              implementation: patch.implementation,
              valueListId,
            }
          : a,
      ),
      valueLists,
    },
    "Attribute saved.",
  );
}

/** Gone from the catalogue and from every type, with every rule about it. */
export function deleteAttribute(
  schema: AttributeSchema,
  attributeId: string,
): MutationResult {
  const attribute = schema.attributes.find((a) => a.id === attributeId);
  if (!attribute) return refuse("That attribute no longer exists.");
  const remaining = schema.attributes.filter((a) => a.id !== attributeId);
  const listStillUsed = remaining.some(
    (a) => a.valueListId === attribute.valueListId,
  );
  const notAbout = <T extends { attributeId: string }>(rows: T[]) =>
    rows.filter((row) => row.attributeId !== attributeId);

  return done(
    {
      ...schema,
      attributes: remaining,
      attributeAssignments: notAbout(schema.attributeAssignments),
      overrides: notAbout(schema.overrides),
      exclusions: notAbout(schema.exclusions),
      valueLists: listStillUsed
        ? schema.valueLists
        : schema.valueLists.filter((list) => list.id !== attribute.valueListId),
    },
    `“${attribute.name}” deleted everywhere.`,
  );
}

/* -------------------------------------------------------------------------- */
/* Attribute sets                                                             */
/* -------------------------------------------------------------------------- */

export function addSet(
  schema: AttributeSchema,
  input: { name: string; description: string },
  ids: IdSource,
): MutationResult {
  const name = input.name.trim();
  if (name === "") return refuse("Enter a name for the set.");
  if (schema.sets.some((s) => same(s.name, name)))
    return refuse("An attribute set with that name already exists.");
  return done(
    {
      ...schema,
      sets: [
        ...schema.sets,
        { id: ids("set"), name, description: input.description.trim() },
      ],
    },
    "Attribute set created.",
  );
}

export function updateSet(
  schema: AttributeSchema,
  setId: string,
  input: { name: string; description: string },
): MutationResult {
  if (!schema.sets.some((s) => s.id === setId))
    return refuse("That attribute set no longer exists.");
  const name = input.name.trim();
  if (name === "") return refuse("Enter a name for the set.");
  if (schema.sets.some((s) => s.id !== setId && same(s.name, name)))
    return refuse("An attribute set with that name already exists.");
  return done(
    {
      ...schema,
      sets: schema.sets.map((s) =>
        s.id === setId
          ? { ...s, name, description: input.description.trim() }
          : s,
      ),
    },
    "Attribute set updated.",
  );
}

/**
 * The set goes; what it gave every type stays. Each place the set was
 * attached gets a direct assignment per attribute, so no type loses a field.
 */
export function deleteSet(
  schema: AttributeSchema,
  setId: string,
  ids: IdSource,
): MutationResult {
  const set = schema.sets.find((s) => s.id === setId);
  if (!set) return refuse("That attribute set no longer exists.");
  const members = schema.attributes.filter((a) => a.setId === setId);
  const sources = schema.setAssignments.filter((row) => row.setId === setId);
  const direct = [...schema.attributeAssignments];
  for (const source of sources) {
    for (const member of members) {
      const present = direct.some(
        (row) => row.typeId === source.typeId && row.attributeId === member.id,
      );
      if (!present)
        direct.push({
          id: ids("aa"),
          typeId: source.typeId,
          attributeId: member.id,
        });
    }
  }
  return done(
    {
      ...schema,
      sets: schema.sets.filter((s) => s.id !== setId),
      attributes: schema.attributes.map((a) =>
        a.setId === setId ? { ...a, setId: null } : a,
      ),
      setAssignments: schema.setAssignments.filter(
        (row) => row.setId !== setId,
      ),
      attributeAssignments: direct,
    },
    `“${set.name}” deleted; its attributes stay on every type that had them.`,
  );
}

/* -------------------------------------------------------------------------- */
/* Attaching and detaching                                                    */
/* -------------------------------------------------------------------------- */

/** The set flows to the type and its descendants; removals of its members here are lifted. */
export function attachSet(
  schema: AttributeSchema,
  typeId: string,
  setId: string,
  ids: IdSource,
): MutationResult {
  if (typeById(schema, typeId) === null)
    return refuse("That product type no longer exists.");
  const set = schema.sets.find((s) => s.id === setId);
  if (!set) return refuse("That attribute set no longer exists.");
  if (
    schema.setAssignments.some(
      (row) => row.typeId === typeId && row.setId === setId,
    )
  )
    return refuse("That set is already attached here.");
  const members = new Set(
    schema.attributes.filter((a) => a.setId === setId).map((a) => a.id),
  );
  return done(
    {
      ...schema,
      setAssignments: [
        ...schema.setAssignments,
        { id: ids("sa"), typeId, setId },
      ],
      exclusions: schema.exclusions.filter(
        (row) => !(row.typeId === typeId && members.has(row.attributeId)),
      ),
    },
    `“${set.name}” attached.`,
  );
}

export function detachSet(
  schema: AttributeSchema,
  assignmentId: string,
): MutationResult {
  if (!schema.setAssignments.some((row) => row.id === assignmentId))
    return refuse("That set is no longer attached.");
  return done(
    {
      ...schema,
      setAssignments: schema.setAssignments.filter(
        (row) => row.id !== assignmentId,
      ),
    },
    "Set detached.",
  );
}

/** Adds the attribute here and below; restores it instead when it was removed here. */
export function attachAttribute(
  schema: AttributeSchema,
  typeId: string,
  attributeId: string,
  ids: IdSource,
): MutationResult {
  if (typeById(schema, typeId) === null)
    return refuse("That product type no longer exists.");
  const attribute = schema.attributes.find((a) => a.id === attributeId);
  if (!attribute) return refuse("That attribute no longer exists.");
  if (
    schema.exclusions.some(
      (row) => row.typeId === typeId && row.attributeId === attributeId,
    )
  )
    return restoreAttribute(schema, typeId, attributeId, ids);
  if (
    activeAttributes(schema, typeId).some(
      (row) => row.attribute.id === attributeId,
    )
  )
    return refuse(`“${attribute.name}” is already on this type.`);
  return done(
    {
      ...schema,
      attributeAssignments: [
        ...schema.attributeAssignments,
        { id: ids("aa"), typeId, attributeId },
      ],
    },
    `“${attribute.name}” added.`,
  );
}

/**
 * Several attributes at once, as the picker adds them: each one attached
 * directly, or restored where it was removed on this type; ones already
 * active are left alone rather than refused.
 */
export function attachAttributes(
  schema: AttributeSchema,
  typeId: string,
  attributeIds: string[],
  ids: IdSource,
): MutationResult {
  if (typeById(schema, typeId) === null)
    return refuse("That product type no longer exists.");
  let next = schema;
  let added = 0;
  for (const attributeId of attributeIds) {
    const attribute = next.attributes.find((a) => a.id === attributeId);
    if (!attribute) return refuse("One of those attributes no longer exists.");
    if (
      activeAttributes(next, typeId).some(
        (row) => row.attribute.id === attributeId,
      )
    )
      continue;
    const result = attachAttribute(next, typeId, attributeId, ids);
    if (!result.ok) return result;
    next = result.schema;
    added += 1;
  }
  if (added === 0) return refuse("Those attributes are already on this type.");
  return done(
    next,
    added === 1 ? "1 attribute added." : `${added} attributes added.`,
  );
}

export function detachAttribute(
  schema: AttributeSchema,
  assignmentId: string,
): MutationResult {
  if (!schema.attributeAssignments.some((row) => row.id === assignmentId))
    return refuse("That attribute is no longer attached.");
  return done(
    {
      ...schema,
      attributeAssignments: schema.attributeAssignments.filter(
        (row) => row.id !== assignmentId,
      ),
    },
    "Attribute detached.",
  );
}

/* -------------------------------------------------------------------------- */
/* Exact-type rules                                                           */
/* -------------------------------------------------------------------------- */

export type Requirement = "required" | "optional" | "reset";

/** A requirement for this exact type; `reset` returns to the attribute's default. */
export function setRequirement(
  schema: AttributeSchema,
  typeId: string,
  attributeId: string,
  value: Requirement,
  ids: IdSource,
): MutationResult {
  if (typeById(schema, typeId) === null)
    return refuse("That product type no longer exists.");
  const attribute = schema.attributes.find((a) => a.id === attributeId);
  if (!attribute) return refuse("That attribute no longer exists.");
  const others = schema.overrides.filter(
    (row) => !(row.typeId === typeId && row.attributeId === attributeId),
  );
  const wanted = value === "required";
  const differs = value !== "reset" && wanted !== attribute.requiredDefault;
  return done(
    {
      ...schema,
      overrides: differs
        ? [
            ...others,
            {
              id: ids("ov"),
              typeId,
              attributeId,
              required: wanted,
              reason: "Changed for this product type",
            },
          ]
        : others,
    },
    value === "reset"
      ? "Requirement reset to the attribute's default."
      : `“${attribute.name}” is ${value} here.`,
  );
}

/** Hidden on this exact type only; still in the catalogue and on every other type. */
export function excludeAttribute(
  schema: AttributeSchema,
  typeId: string,
  attributeId: string,
  ids: IdSource,
): MutationResult {
  if (typeById(schema, typeId) === null)
    return refuse("That product type no longer exists.");
  const attribute = schema.attributes.find((a) => a.id === attributeId);
  if (!attribute) return refuse("That attribute no longer exists.");
  if (
    schema.exclusions.some(
      (row) => row.typeId === typeId && row.attributeId === attributeId,
    )
  )
    return refuse(`“${attribute.name}” is already removed here.`);
  return done(
    {
      ...schema,
      exclusions: [
        ...schema.exclusions,
        { id: ids("ex"), typeId, attributeId },
      ],
    },
    `“${attribute.name}” removed from this type.`,
  );
}

/**
 * Lifts a removal. When nothing supplies the attribute any more — its source
 * was detached in the meantime — it is attached here directly instead.
 */
export function restoreAttribute(
  schema: AttributeSchema,
  typeId: string,
  attributeId: string,
  ids: IdSource,
): MutationResult {
  if (typeById(schema, typeId) === null)
    return refuse("That product type no longer exists.");
  const attribute = schema.attributes.find((a) => a.id === attributeId);
  if (!attribute) return refuse("That attribute no longer exists.");
  const reachable = candidateAttributes(schema, typeId).some(
    (row) => row.attribute.id === attributeId,
  );
  return done(
    {
      ...schema,
      attributeAssignments: reachable
        ? schema.attributeAssignments
        : [
            ...schema.attributeAssignments,
            { id: ids("aa"), typeId, attributeId },
          ],
      exclusions: schema.exclusions.filter(
        (row) => !(row.typeId === typeId && row.attributeId === attributeId),
      ),
    },
    `“${attribute.name}” restored.`,
  );
}

export function clearRule(
  schema: AttributeSchema,
  kind: "override" | "exclusion",
  ruleId: string,
): MutationResult {
  const rows = kind === "override" ? schema.overrides : schema.exclusions;
  if (!rows.some((row) => row.id === ruleId))
    return refuse("That rule no longer exists.");
  return done(
    kind === "override"
      ? {
          ...schema,
          overrides: schema.overrides.filter((r) => r.id !== ruleId),
        }
      : {
          ...schema,
          exclusions: schema.exclusions.filter((r) => r.id !== ruleId),
        },
    "Rule reset.",
  );
}
