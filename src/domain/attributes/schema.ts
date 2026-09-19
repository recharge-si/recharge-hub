import { z } from "zod";

import {
  DATA_TYPES,
  IMPLEMENTATIONS,
  SCHEMA_VERSION,
  SCOPES,
  emptySchema,
  type AttributeSchema,
  type DataType,
} from "~/domain/attributes/types";

/**
 * Reading and checking a schema document (docs/attributes.md § Document).
 *
 * Two layers, on purpose. `parseAttributeSchema` is the shape: it is what a
 * stored row or an imported file is held to before anything trusts it, and it
 * also understands the standalone builder's own files so a schema planned
 * there loads here. `schemaProblems` is the meaning: every reference resolves,
 * no type is its own ancestor, no rule is stated twice. A write that leaves a
 * problem behind is refused, so a stored document always passes both.
 */

const ID = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,100}$/)
  .refine((id) => !["__proto__", "constructor", "prototype"].includes(id));

const text = (max: number) => z.string().max(max);

const productType = z.object({
  id: ID,
  name: text(200),
  parentId: ID.nullable(),
  leaf: z.boolean(),
  sortOrder: z.number().finite(),
  shopifyCategory: text(2000).default(""),
  archetype: text(2000).default(""),
});

const attributeSet = z.object({
  id: ID,
  name: text(200),
  description: text(2000).default(""),
});

const attribute = z.object({
  id: ID,
  name: text(200),
  setId: ID.nullable(),
  dataType: z.enum(DATA_TYPES),
  unit: text(100).default(""),
  description: text(2000).default(""),
  scope: z.enum(SCOPES),
  key: text(400).default(""),
  implementation: z.enum(IMPLEMENTATIONS).default("custom"),
  requiredDefault: z.boolean().default(false),
  filterable: z.boolean().default(false),
  searchable: z.boolean().default(false),
  comparable: z.boolean().default(false),
  valueListId: ID.nullable().default(null),
});

const setAssignment = z.object({ id: ID, typeId: ID, setId: ID });
const attributeAssignment = z.object({ id: ID, typeId: ID, attributeId: ID });
const override = z.object({
  id: ID,
  typeId: ID,
  attributeId: ID,
  required: z.boolean(),
  reason: text(2000).default(""),
});
const exclusion = z.object({ id: ID, typeId: ID, attributeId: ID });
const valueList = z.object({
  id: ID,
  items: z
    .array(
      z.object({
        code: text(100),
        en: text(200),
        si: text(200).default(""),
      }),
    )
    .max(2000),
});

const bounded = <T extends z.ZodTypeAny>(item: T) => z.array(item).max(10000);

export const attributeSchemaCodec = z.object({
  version: z.literal(SCHEMA_VERSION),
  types: bounded(productType),
  sets: bounded(attributeSet),
  attributes: bounded(attribute),
  setAssignments: bounded(setAssignment),
  attributeAssignments: bounded(attributeAssignment),
  overrides: bounded(override),
  exclusions: bounded(exclusion),
  valueLists: bounded(valueList),
});

export type ParsedSchema =
  { ok: true; schema: AttributeSchema } | { ok: false; message: string };

/**
 * A document of this app's own shape, or one the standalone builder wrote
 * (its `version` 1 to 3, keyed by id rather than listed).
 */
export function parseAttributeSchema(raw: unknown): ParsedSchema {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "Expected a schema object." };
  }
  const version = (raw as { version?: unknown }).version;
  const candidate:
    { ok: true; value: unknown } | { ok: false; message: string } =
    version === SCHEMA_VERSION && "types" in raw
      ? { ok: true, value: raw }
      : fromLegacy(raw);
  if (!candidate.ok) return candidate;

  const parsed = attributeSchemaCodec.safeParse(candidate.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    return {
      ok: false,
      message: `The file is not a valid schema${where}: ${issue?.message ?? "unknown problem"}.`,
    };
  }
  const problems = schemaProblems(parsed.data);
  if (problems.length > 0) {
    return { ok: false, message: problems[0] ?? "The schema is inconsistent." };
  }
  return { ok: true, schema: parsed.data };
}

/* -------------------------------------------------------------------------- */
/* The standalone builder's files                                             */
/* -------------------------------------------------------------------------- */

const LEGACY_TYPES: Record<string, DataType> = {
  Text: "text",
  Integer: "integer",
  Decimal: "decimal",
  Number: "decimal",
  Boolean: "boolean",
  "Yes / No": "boolean",
  "Single-select": "single_select",
  Dropdown: "single_select",
  "Multi-select": "multi_select",
  Measurement: "measurement",
  Reference: "reference",
  Date: "date",
};

const legacyRecord = z.record(z.string(), z.record(z.string(), z.unknown()));

const legacyCodec = z.object({
  version: z.number().int().min(1).max(3).optional(),
  taxonomy: legacyRecord,
  groups: legacyRecord.default({}),
  attributes: legacyRecord,
  assignments: legacyRecord.default({}),
  directAssignments: legacyRecord.default({}),
  overrides: legacyRecord.default({}),
  exclusions: legacyRecord.default({}),
  valuelists: legacyRecord.default({}),
});

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function bool(value: unknown): boolean {
  return value === true;
}

function fromLegacy(
  raw: object,
): { ok: true; value: unknown } | { ok: false; message: string } {
  const parsed = legacyCodec.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message:
        "The file is not a schema this app can read. Export it from the attributes settings page or from the standalone builder.",
    };
  }
  const legacy = parsed.data;
  const entries = (
    record: Record<string, Record<string, unknown>>,
  ): Array<Record<string, unknown> & { id: string }> =>
    Object.entries(record).map(([id, item]) => ({ ...item, id }));

  const value: AttributeSchema = {
    ...emptySchema(),
    types: entries(legacy.taxonomy).map((node) => ({
      id: node.id,
      name: str(node.name),
      parentId: str(node.parentId) || null,
      leaf: bool(node.leaf),
      sortOrder: typeof node.sortOrder === "number" ? node.sortOrder : 0,
      shopifyCategory: str(node.shopifyCategory),
      archetype: str(node.archetype),
    })),
    sets: entries(legacy.groups).map((group) => ({
      id: group.id,
      name: str(group.name),
      description: str(group.description),
    })),
    attributes: entries(legacy.attributes).map((attr) => ({
      id: attr.id,
      name: str(attr.name),
      setId: str(attr.groupId) || null,
      dataType: LEGACY_TYPES[str(attr.dataType)] ?? "text",
      unit: str(attr.unit),
      description: str(attr.description),
      scope: attr.scope === "Variant" ? "variant" : "product",
      key: str(attr.namespaceKey),
      implementation: attr.native === "Native" ? "native" : "custom",
      requiredDefault: bool(attr.requiredDefault),
      filterable: bool(attr.filterable),
      searchable: bool(attr.searchable),
      comparable: bool(attr.comparable),
      valueListId: str(attr.valueListId) || null,
    })),
    setAssignments: entries(legacy.assignments).map((row) => ({
      id: row.id,
      typeId: str(row.nodeId),
      setId: str(row.groupId),
    })),
    attributeAssignments: entries(legacy.directAssignments).map((row) => ({
      id: row.id,
      typeId: str(row.nodeId),
      attributeId: str(row.attributeId),
    })),
    overrides: entries(legacy.overrides).map((row) => ({
      id: row.id,
      typeId: str(row.nodeId),
      attributeId: str(row.attributeId),
      required: bool(row.required),
      reason: str(row.reason),
    })),
    exclusions: entries(legacy.exclusions).map((row) => ({
      id: row.id,
      typeId: str(row.nodeId),
      attributeId: str(row.attributeId),
    })),
    valueLists: entries(legacy.valuelists).map((list) => ({
      id: list.id,
      items: Array.isArray(list.items)
        ? list.items.map((item: unknown) => {
            const record =
              item !== null && typeof item === "object"
                ? (item as Record<string, unknown>)
                : {};
            return {
              code: str(record.code),
              en: str(record.en),
              si: str(record.si),
            };
          })
        : [],
    })),
  };
  return { ok: true, value };
}

/* -------------------------------------------------------------------------- */
/* Meaning                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Everything wrong with a well-shaped document, in the order a person would
 * fix it. Empty means consistent.
 */
export function schemaProblems(schema: AttributeSchema): string[] {
  const problems: string[] = [];
  const typeIds = new Set<string>();
  const setIds = new Set<string>();
  const attributeIds = new Set<string>();
  const listIds = new Set<string>();

  const unique = (ids: Set<string>, id: string, what: string) => {
    if (ids.has(id)) problems.push(`Two ${what} share the id "${id}".`);
    ids.add(id);
  };

  for (const type of schema.types) unique(typeIds, type.id, "product types");
  for (const set of schema.sets) unique(setIds, set.id, "attribute sets");
  for (const attr of schema.attributes)
    unique(attributeIds, attr.id, "attributes");
  for (const list of schema.valueLists)
    unique(listIds, list.id, "option lists");

  const byId = new Map(schema.types.map((type) => [type.id, type]));
  for (const type of schema.types) {
    if (type.name.trim() === "")
      problems.push("Every product type needs a name.");
    if (type.parentId !== null && !byId.has(type.parentId)) {
      problems.push(`"${type.name}" has a parent that does not exist.`);
      continue;
    }
    const seen = new Set([type.id]);
    let parent = type.parentId;
    while (parent !== null) {
      if (seen.has(parent)) {
        problems.push(`"${type.name}" is its own ancestor.`);
        break;
      }
      seen.add(parent);
      parent = byId.get(parent)?.parentId ?? null;
    }
  }

  for (const set of schema.sets) {
    if (set.name.trim() === "")
      problems.push("Every attribute set needs a name.");
  }

  for (const attr of schema.attributes) {
    if (attr.name.trim() === "") problems.push("Every attribute needs a name.");
    if (attr.setId !== null && !setIds.has(attr.setId))
      problems.push(`"${attr.name}" belongs to a set that does not exist.`);
    if (attr.valueListId !== null && !listIds.has(attr.valueListId))
      problems.push(`"${attr.name}" points at options that do not exist.`);
  }

  const seenRules = new Map<string, Set<string>>();
  const rule = (
    kind: string,
    typeId: string,
    targetId: string,
    targetIds: Set<string>,
  ) => {
    if (!typeIds.has(typeId))
      problems.push(`A ${kind} names a product type that does not exist.`);
    if (!targetIds.has(targetId))
      problems.push(`A ${kind} names something that does not exist.`);
    const seen = seenRules.get(kind) ?? new Set<string>();
    const key = `${typeId}|${targetId}`;
    if (seen.has(key)) problems.push(`A ${kind} is stated twice.`);
    seen.add(key);
    seenRules.set(kind, seen);
  };
  for (const row of schema.setAssignments)
    rule("set assignment", row.typeId, row.setId, setIds);
  for (const row of schema.attributeAssignments)
    rule("direct assignment", row.typeId, row.attributeId, attributeIds);
  for (const row of schema.overrides)
    rule("requirement change", row.typeId, row.attributeId, attributeIds);
  for (const row of schema.exclusions)
    rule("removal", row.typeId, row.attributeId, attributeIds);

  for (const list of schema.valueLists) {
    const codes = new Set<string>();
    for (const item of list.items) {
      if (item.en.trim() === "" || item.code.trim() === "")
        problems.push("Every option needs a code and an English label.");
      if (codes.has(item.code))
        problems.push(`The option code "${item.code}" is used twice.`);
      codes.add(item.code);
    }
  }

  return problems;
}
