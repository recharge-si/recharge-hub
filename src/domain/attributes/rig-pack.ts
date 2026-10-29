import {
  KEY_NAMESPACE,
  SCHEMA_VERSION,
  emptySchema,
  slugify,
  type Attribute,
  type AttributeSchema,
  type DataType,
  type ProductType,
  type Scope,
} from "~/domain/attributes/types";

/**
 * The rig attribute pack (docs/attributes.md § Rig-ready attributes): the
 * product types and machine-readable attributes the AI rig builder's engine
 * reads to say what fits with what. A draft until a Recharge windsurf expert
 * signs it off (PRD 2 open question 2); loaded only on request, like the
 * starter, never on its own.
 *
 * Every attribute lives in the `recharge` namespace and its key is exactly
 * the one named here: the rig engine reads those keys. Sizes that change
 * with a sail's size (area, luff, mast and boom ranges) are variant
 * attributes; what a model has once (category, mast RDM) is a product one.
 */

export type RigTypeId =
  "boards" | "sails" | "masts" | "booms" | "bases" | "fins" | "harnesses";

/** The assignable types and the names they carry in the plan. */
export const RIG_TYPES: ReadonlyArray<{ id: RigTypeId; name: string }> = [
  { id: "boards", name: "Boards" },
  { id: "sails", name: "Sails" },
  { id: "masts", name: "Masts" },
  { id: "booms", name: "Booms" },
  { id: "bases", name: "Bases and extensions" },
  { id: "fins", name: "Fins" },
  { id: "harnesses", name: "Harnesses" },
];

/** The types coverage is stated for: a harness is optional, so it is not counted. */
export const RIG_COVERAGE_TYPES: readonly RigTypeId[] = [
  "boards",
  "sails",
  "masts",
  "booms",
  "bases",
  "fins",
];

const ROOT_NAME = "All products";
const DISCIPLINE_NAME = "Windsurf";

interface Option {
  code: string;
  en: string;
}

const SKILL: Option[] = [
  { code: "beginner", en: "Beginner" },
  { code: "intermediate", en: "Intermediate" },
  { code: "advanced", en: "Advanced" },
];
const FIN_BOX: Option[] = [
  { code: "tuttle", en: "Tuttle" },
  { code: "deep_tuttle", en: "Deep Tuttle" },
  { code: "powerbox", en: "Powerbox" },
  { code: "us_box", en: "US box" },
  { code: "slot_box", en: "Slot box" },
  { code: "foil", en: "Foil" },
];
const RDM: Option[] = [
  { code: "25", en: "RDM 25" },
  { code: "30", en: "RDM 30" },
  { code: "35", en: "RDM 35" },
];
const BASE: Option[] = [
  { code: "pin", en: "Pin" },
  { code: "tendon", en: "Tendon" },
];
const SAIL_CATEGORY: Option[] = [
  { code: "wave", en: "Wave" },
  { code: "freeride", en: "Freeride" },
  { code: "freerace", en: "Freerace" },
  { code: "slalom", en: "Slalom" },
  { code: "freestyle", en: "Freestyle" },
  { code: "race", en: "Race" },
];

interface PackAttribute {
  /** The key after `recharge.`; the rig engine reads it. */
  key: string;
  name: string;
  dataType: DataType;
  unit?: string;
  scope: Scope;
  required?: boolean;
  options?: Option[];
  /** The set it belongs to, by the type it describes. */
  set: "sails" | "masts" | "boards" | "booms" | "bases" | "fins" | "rider";
}

const A = (attribute: PackAttribute): PackAttribute => attribute;

export const RIG_ATTRIBUTES: readonly PackAttribute[] = [
  // Sails
  A({
    key: "sail_area_m2",
    name: "Sail area",
    dataType: "decimal",
    unit: "m²",
    scope: "variant",
    required: true,
    set: "sails",
  }),
  A({
    key: "sail_luff_cm",
    name: "Sail luff",
    dataType: "integer",
    unit: "cm",
    scope: "variant",
    set: "sails",
  }),
  A({
    key: "sail_mast_rdm",
    name: "Sail mast RDM",
    dataType: "single_select",
    scope: "variant",
    required: true,
    options: RDM,
    set: "sails",
  }),
  A({
    key: "sail_mast_length_min_cm",
    name: "Sail mast length (min)",
    dataType: "integer",
    unit: "cm",
    scope: "variant",
    required: true,
    set: "sails",
  }),
  A({
    key: "sail_mast_length_max_cm",
    name: "Sail mast length (max)",
    dataType: "integer",
    unit: "cm",
    scope: "variant",
    required: true,
    set: "sails",
  }),
  A({
    key: "sail_boom_min_cm",
    name: "Sail boom length (min)",
    dataType: "integer",
    unit: "cm",
    scope: "variant",
    required: true,
    set: "sails",
  }),
  A({
    key: "sail_boom_max_cm",
    name: "Sail boom length (max)",
    dataType: "integer",
    unit: "cm",
    scope: "variant",
    required: true,
    set: "sails",
  }),
  A({
    key: "sail_wind_min_kn",
    name: "Sail wind (min)",
    dataType: "integer",
    unit: "kn",
    scope: "variant",
    set: "sails",
  }),
  A({
    key: "sail_wind_max_kn",
    name: "Sail wind (max)",
    dataType: "integer",
    unit: "kn",
    scope: "variant",
    set: "sails",
  }),
  A({
    key: "sail_category",
    name: "Sail category",
    dataType: "single_select",
    scope: "product",
    required: true,
    options: SAIL_CATEGORY,
    set: "sails",
  }),
  // Masts
  A({
    key: "mast_length_cm",
    name: "Mast length",
    dataType: "integer",
    unit: "cm",
    scope: "variant",
    required: true,
    set: "masts",
  }),
  A({
    key: "mast_rdm",
    name: "Mast RDM",
    dataType: "single_select",
    scope: "product",
    required: true,
    options: RDM,
    set: "masts",
  }),
  A({
    key: "mast_imcs",
    name: "Mast IMCS",
    dataType: "integer",
    scope: "product",
    required: true,
    set: "masts",
  }),
  A({
    key: "mast_carbon_percent",
    name: "Mast carbon content",
    dataType: "integer",
    unit: "%",
    scope: "product",
    set: "masts",
  }),
  A({
    key: "mast_base_type",
    name: "Mast base type",
    dataType: "single_select",
    scope: "product",
    required: true,
    options: BASE,
    set: "masts",
  }),
  // Boards
  A({
    key: "board_volume_l",
    name: "Board volume",
    dataType: "decimal",
    unit: "L",
    scope: "variant",
    required: true,
    set: "boards",
  }),
  A({
    key: "board_width_cm",
    name: "Board width",
    dataType: "decimal",
    unit: "cm",
    scope: "variant",
    required: true,
    set: "boards",
  }),
  A({
    key: "board_length_cm",
    name: "Board length",
    dataType: "integer",
    unit: "cm",
    scope: "variant",
    required: true,
    set: "boards",
  }),
  A({
    key: "board_fin_box",
    name: "Board fin box",
    dataType: "single_select",
    scope: "product",
    required: true,
    options: FIN_BOX,
    set: "boards",
  }),
  A({
    key: "board_min_sail_m2",
    name: "Board smallest sail",
    dataType: "decimal",
    unit: "m²",
    scope: "variant",
    required: true,
    set: "boards",
  }),
  A({
    key: "board_max_sail_m2",
    name: "Board largest sail",
    dataType: "decimal",
    unit: "m²",
    scope: "variant",
    required: true,
    set: "boards",
  }),
  // Booms
  A({
    key: "boom_min_cm",
    name: "Boom length (min)",
    dataType: "integer",
    unit: "cm",
    scope: "variant",
    required: true,
    set: "booms",
  }),
  A({
    key: "boom_max_cm",
    name: "Boom length (max)",
    dataType: "integer",
    unit: "cm",
    scope: "variant",
    required: true,
    set: "booms",
  }),
  // Bases and extensions
  A({
    key: "base_type",
    name: "Base type",
    dataType: "single_select",
    scope: "product",
    required: true,
    options: BASE,
    set: "bases",
  }),
  A({
    key: "extension_length_cm",
    name: "Extension length",
    dataType: "integer",
    unit: "cm",
    scope: "variant",
    set: "bases",
  }),
  // Fins
  A({
    key: "fin_box",
    name: "Fin box",
    dataType: "single_select",
    scope: "product",
    required: true,
    options: FIN_BOX,
    set: "fins",
  }),
  A({
    key: "fin_length_cm",
    name: "Fin length",
    dataType: "integer",
    unit: "cm",
    scope: "variant",
    required: true,
    set: "fins",
  }),
  // The rider the gear is meant for
  A({
    key: "rider_weight_min_kg",
    name: "Rider weight (min)",
    dataType: "integer",
    unit: "kg",
    scope: "product",
    set: "rider",
  }),
  A({
    key: "rider_weight_max_kg",
    name: "Rider weight (max)",
    dataType: "integer",
    unit: "kg",
    scope: "product",
    set: "rider",
  }),
  A({
    key: "skill_level",
    name: "Skill level",
    dataType: "single_select",
    scope: "product",
    options: SKILL,
    set: "rider",
  }),
];

/** The keys the rig engine reads, for code that must not retype them. */
export const RIG_KEYS = Object.fromEntries(
  RIG_ATTRIBUTES.map((attribute) => [
    attribute.key,
    `${KEY_NAMESPACE}.${attribute.key}`,
  ]),
) as Readonly<Record<string, string>>;

/** The set each kind of attribute is bundled in, and the types it is attached to. */
const SETS: Record<
  PackAttribute["set"],
  { name: string; description: string; types: RigTypeId[] }
> = {
  sails: {
    name: "Rig: sails",
    description: "What a rig needs to know about a sail",
    types: ["sails"],
  },
  masts: {
    name: "Rig: masts",
    description: "What a rig needs to know about a mast",
    types: ["masts"],
  },
  boards: {
    name: "Rig: boards",
    description: "What a rig needs to know about a board",
    types: ["boards"],
  },
  booms: {
    name: "Rig: booms",
    description: "What a rig needs to know about a boom",
    types: ["booms"],
  },
  bases: {
    name: "Rig: bases",
    description: "Mast bases and extensions",
    types: ["bases"],
  },
  fins: {
    name: "Rig: fins",
    description: "What a rig needs to know about a fin",
    types: ["fins"],
  },
  rider: {
    name: "Rig: rider",
    description: "Who the gear is meant for",
    types: ["boards", "sails", "harnesses"],
  },
};

/* -------------------------------------------------------------------------- */
/* Min / max pairs                                                            */
/* -------------------------------------------------------------------------- */

/** `sail_boom_min_cm` → `sail_boom_max_cm`; null when the key is not a minimum. */
export function maxKeyFor(minKey: string): string | null {
  if (/_min_/.test(minKey)) return minKey.replace("_min_", "_max_");
  if (/_min$/.test(minKey)) return minKey.replace(/_min$/, "_max");
  return null;
}

/** The plan's minimum and maximum attributes, by the key after the namespace. */
export function rangePairs(
  schema: AttributeSchema,
): Array<{ min: string; max: string }> {
  const keys = new Set(
    schema.attributes
      .map((attribute) => attribute.key.trim())
      .filter((key) => key.startsWith(`${KEY_NAMESPACE}.`))
      .map((key) => key.slice(KEY_NAMESPACE.length + 1)),
  );
  const pairs: Array<{ min: string; max: string }> = [];
  for (const key of [...keys].sort()) {
    const max = maxKeyFor(key);
    if (max !== null && keys.has(max)) pairs.push({ min: key, max });
  }
  return pairs;
}

/**
 * The plan-level check `rangeOrdering`: given the values a product holds
 * (by key after the namespace), every minimum is at most its maximum. Each
 * violation is a sentence naming both keys and both values.
 */
export function rangeOrdering(
  schema: AttributeSchema,
  values: Readonly<Record<string, number>>,
): string[] {
  const problems: string[] = [];
  for (const { min, max } of rangePairs(schema)) {
    const low = values[min];
    const high = values[max];
    if (low !== undefined && high !== undefined && low > high)
      problems.push(`${min} (${low}) is greater than ${max} (${high}).`);
  }
  return problems;
}

/* -------------------------------------------------------------------------- */
/* Building and merging                                                       */
/* -------------------------------------------------------------------------- */

export interface RigPackResult {
  schema: AttributeSchema;
  added: { types: number; sets: number; attributes: number };
  /** Pack attributes the plan already had (by name or by field), left as they are. */
  skipped: Array<{ name: string; reason: string }>;
  /** Existing select attributes that gained options the engine needs. */
  extended: Array<{ name: string; codes: string[] }>;
  /** False when merging changed nothing: the pack is already in the plan. */
  changed: boolean;
}

const norm = (text: string) => text.trim().toLowerCase();

function unusedId(taken: Set<string>, wanted: string): string {
  let id = wanted;
  for (let n = 2; taken.has(id); n += 1) id = `${wanted}_${n}`;
  taken.add(id);
  return id;
}

/**
 * The pack merged into a plan. Nothing already there is changed or
 * duplicated: types, sets and attributes are matched by name (an attribute
 * also by its Shopify field) and reused; what is missing is added. An
 * existing select attribute on one of the pack's fields gains the options
 * the engine needs and lacks. Merging twice changes nothing the second time.
 */
export function mergeRigPack(base: AttributeSchema): RigPackResult {
  const schema: AttributeSchema = structuredClone(base);
  const added = { types: 0, sets: 0, attributes: 0 };
  const skipped: RigPackResult["skipped"] = [];
  const extended: RigPackResult["extended"] = [];
  let changed = false;

  const ids = new Set<string>([
    ...schema.types.map((t) => t.id),
    ...schema.sets.map((s) => s.id),
    ...schema.attributes.map((a) => a.id),
    ...schema.valueLists.map((l) => l.id),
  ]);

  /* Types ------------------------------------------------------------- */
  const findType = (name: string) =>
    schema.types.find((type) => norm(type.name) === norm(name));
  const addType = (name: string, parentId: string | null, leaf: boolean) => {
    const siblings = schema.types.filter((t) => t.parentId === parentId);
    const type: ProductType = {
      id: unusedId(ids, `rig_${slugify(name)}`),
      name,
      parentId,
      leaf,
      sortOrder:
        (siblings.reduce((max, t) => Math.max(max, t.sortOrder), 0) || 0) +
        1000,
      shopifyCategory: "",
      archetype: "",
    };
    schema.types.push(type);
    added.types += 1;
    changed = true;
    return type;
  };

  let discipline = findType(DISCIPLINE_NAME);
  if (!discipline) {
    const root =
      findType(ROOT_NAME) ??
      schema.types.find((type) => type.parentId === null) ??
      addType(ROOT_NAME, null, false);
    discipline = addType(DISCIPLINE_NAME, root.id, false);
  }
  const typeIds = new Map<RigTypeId, string>();
  for (const rig of RIG_TYPES) {
    const type = findType(rig.name) ?? addType(rig.name, discipline.id, true);
    typeIds.set(rig.id, type.id);
  }

  /* Option lists, sets, attributes ------------------------------------ */
  const listFor = (attribute: PackAttribute): string | null => {
    if (!attribute.options) return null;
    // One list per attribute: a list shared between two forks on first edit.
    const id = unusedId(ids, `rig_list_${attribute.key}`);
    schema.valueLists.push({
      id,
      items: attribute.options.map((o) => ({ code: o.code, en: o.en, si: "" })),
    });
    return id;
  };
  const setIds = new Map<PackAttribute["set"], string>();
  const setFor = (kind: PackAttribute["set"]): string => {
    let id = setIds.get(kind);
    if (id) return id;
    const wanted = SETS[kind];
    const existing = schema.sets.find(
      (set) => norm(set.name) === norm(wanted.name),
    );
    if (existing) id = existing.id;
    else {
      id = unusedId(ids, `rig_set_${kind}`);
      schema.sets.push({
        id,
        name: wanted.name,
        description: wanted.description,
      });
      added.sets += 1;
      changed = true;
    }
    setIds.set(kind, id);
    return id;
  };

  const usedKinds = new Set<PackAttribute["set"]>();
  for (const spec of RIG_ATTRIBUTES) {
    const fullKey = `${KEY_NAMESPACE}.${spec.key}`;
    const existing = schema.attributes.find(
      (attribute) =>
        norm(attribute.name) === norm(spec.name) ||
        (attribute.scope === spec.scope &&
          norm(attribute.key) === norm(fullKey)),
    );
    if (existing) {
      skipped.push({
        name: spec.name,
        reason:
          norm(existing.name) === norm(spec.name)
            ? "An attribute with this name is already in the plan."
            : `The field ${fullKey} is already used by “${existing.name}”.`,
      });
      // A select the engine reads keeps its options and gains the missing ones.
      if (
        spec.options &&
        existing.valueListId &&
        norm(existing.key) === norm(fullKey)
      ) {
        const list = schema.valueLists.find(
          (l) => l.id === existing.valueListId,
        );
        const missing = spec.options.filter(
          (option) => !list?.items.some((item) => item.code === option.code),
        );
        if (list && missing.length > 0) {
          list.items.push(
            ...missing.map((o) => ({ code: o.code, en: o.en, si: "" })),
          );
          extended.push({
            name: existing.name,
            codes: missing.map((o) => o.code),
          });
          changed = true;
        }
      }
      continue;
    }
    usedKinds.add(spec.set);
    const attribute: Attribute = {
      id: unusedId(ids, `rig_${spec.key}`),
      name: spec.name,
      setId: setFor(spec.set),
      dataType: spec.dataType,
      unit: spec.unit ?? "",
      description: "",
      scope: spec.scope,
      key: fullKey,
      implementation: "custom",
      requiredDefault: spec.required ?? false,
      filterable: false,
      searchable: false,
      comparable: false,
      valueListId: listFor(spec),
    };
    schema.attributes.push(attribute);
    added.attributes += 1;
    changed = true;
  }

  /* Set assignments for the sets the pack added attributes to --------- */
  for (const kind of usedKinds) {
    const setId = setFor(kind);
    for (const rigType of SETS[kind].types) {
      const typeId = typeIds.get(rigType);
      if (!typeId) continue;
      const attached = schema.setAssignments.some(
        (row) => row.typeId === typeId && row.setId === setId,
      );
      if (attached) continue;
      schema.setAssignments.push({
        id: unusedId(ids, `rig_sa_${kind}_${rigType}`),
        typeId,
        setId,
      });
      changed = true;
    }
  }

  return { schema, added, skipped, extended, changed };
}

/** The pack on its own: an empty plan with the pack merged in. */
export function rigPack(): AttributeSchema {
  return mergeRigPack({ ...emptySchema(), version: SCHEMA_VERSION }).schema;
}
