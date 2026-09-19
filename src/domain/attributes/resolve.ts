import { schemaProblems } from "~/domain/attributes/schema";
import {
  KEY_PATTERN,
  isSelect,
  type Attribute,
  type AttributeSchema,
  type Exclusion,
  type ProductType,
  type RequirementOverride,
} from "~/domain/attributes/types";
import { compareCodepoints } from "~/domain/types";

/**
 * What a product type actually requires (docs/attributes.md § Inheritance).
 *
 * A set or an attribute attached to a type flows to every descendant. The
 * nearest source wins when both a set and a direct assignment supply the
 * same attribute. A requirement change or a removal is for the exact type it
 * was made on and passes to nothing.
 */

/** The type itself first, then each ancestor up to the root. */
export function ancestry(schema: AttributeSchema, typeId: string): string[] {
  const byId = new Map(schema.types.map((type) => [type.id, type]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(typeId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current.id);
    current =
      current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return chain;
}

export function typeById(
  schema: AttributeSchema,
  typeId: string,
): ProductType | null {
  return schema.types.find((type) => type.id === typeId) ?? null;
}

export function attributeById(
  schema: AttributeSchema,
  attributeId: string,
): Attribute | null {
  return schema.attributes.find((attr) => attr.id === attributeId) ?? null;
}

/** Direct children, in the order they are shown. */
export function childrenOf(
  schema: AttributeSchema,
  parentId: string | null,
): ProductType[] {
  return schema.types
    .filter((type) => type.parentId === parentId)
    .sort(
      (a, b) => a.sortOrder - b.sortOrder || compareCodepoints(a.name, b.name),
    );
}

/** Root to the type, by name. */
export function pathOf(schema: AttributeSchema, typeId: string): string[] {
  const byId = new Map(schema.types.map((type) => [type.id, type]));
  return ancestry(schema, typeId)
    .reverse()
    .map((id) => byId.get(id)?.name ?? "");
}

/** Whether `candidate` is `typeId` itself or one of its descendants. */
export function isWithin(
  schema: AttributeSchema,
  candidate: string,
  typeId: string,
): boolean {
  return ancestry(schema, candidate).includes(typeId);
}

export interface ResolvedAttribute {
  attribute: Attribute;
  /** The type the attribute reaches this one from; the type itself when added here. */
  sourceTypeId: string;
  /** Reached through a direct assignment rather than a set. */
  individual: boolean;
  required: boolean;
  override: RequirementOverride | null;
  exclusion: Exclusion | null;
}

/** Every attribute that reaches the type, removed ones included. */
export function candidateAttributes(
  schema: AttributeSchema,
  typeId: string,
): ResolvedAttribute[] {
  const chain = ancestry(schema, typeId);
  const setSource = new Map<string, string>();
  const directSource = new Map<string, string>();
  for (const id of chain) {
    for (const row of schema.setAssignments) {
      if (row.typeId === id && !setSource.has(row.setId))
        setSource.set(row.setId, id);
    }
    for (const row of schema.attributeAssignments) {
      if (row.typeId === id && !directSource.has(row.attributeId))
        directSource.set(row.attributeId, id);
    }
  }

  const rows: ResolvedAttribute[] = [];
  for (const attribute of schema.attributes) {
    const viaSet =
      attribute.setId === null ? undefined : setSource.get(attribute.setId);
    const viaDirect = directSource.get(attribute.id);
    if (viaSet === undefined && viaDirect === undefined) continue;
    const source =
      viaDirect !== undefined &&
      (viaSet === undefined || chain.indexOf(viaDirect) < chain.indexOf(viaSet))
        ? viaDirect
        : (viaSet as string);
    const override =
      schema.overrides.find(
        (row) => row.typeId === typeId && row.attributeId === attribute.id,
      ) ?? null;
    const exclusion =
      schema.exclusions.find(
        (row) => row.typeId === typeId && row.attributeId === attribute.id,
      ) ?? null;
    rows.push({
      attribute,
      sourceTypeId: source,
      individual: source === viaDirect,
      required: override ? override.required : attribute.requiredDefault,
      override,
      exclusion,
    });
  }
  return rows.sort(
    (a, b) =>
      Number(b.required) - Number(a.required) ||
      compareCodepoints(a.attribute.name, b.attribute.name),
  );
}

/** The attributes the type actually has: candidates minus removals. */
export function activeAttributes(
  schema: AttributeSchema,
  typeId: string,
): ResolvedAttribute[] {
  return candidateAttributes(schema, typeId).filter(
    (row) => row.exclusion === null,
  );
}

/** Every type on which the attribute is active. */
export function typesUsing(
  schema: AttributeSchema,
  attributeId: string,
): ProductType[] {
  return schema.types.filter((type) =>
    activeAttributes(schema, type.id).some(
      (row) => row.attribute.id === attributeId,
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* Health                                                                     */
/* -------------------------------------------------------------------------- */

export type HealthArea = "types" | "attributes" | "settings";

export interface HealthCheck {
  id: string;
  /** How many things are wrong; zero is healthy. */
  count: number;
  /** What is wrong, worded for the count. */
  message: string;
  area: HealthArea;
}

export interface SchemaMetrics {
  assignableTypes: number;
  categories: number;
  attributes: number;
  sets: number;
}

export function schemaMetrics(schema: AttributeSchema): SchemaMetrics {
  const assignable = schema.types.filter((type) => type.leaf).length;
  return {
    assignableTypes: assignable,
    categories: schema.types.length - assignable,
    attributes: schema.attributes.length,
    sets: schema.sets.length,
  };
}

/**
 * What needs attention in the plan. These describe the document, not a live
 * Shopify connection; nothing is sent anywhere.
 */
export function schemaHealth(schema: AttributeSchema): HealthCheck[] {
  const plural = (n: number, one: string, many: string) =>
    n === 1 ? one : many;

  const empty = schema.types.filter(
    (type) => type.leaf && activeAttributes(schema, type.id).length === 0,
  ).length;
  const unused = schema.attributes.filter(
    (attr) => typesUsing(schema, attr.id).length === 0,
  ).length;
  const unmapped = schema.attributes.filter((attr) => attr.key === "").length;
  const listSizes = new Map(
    schema.valueLists.map((list) => [list.id, list.items.length]),
  );
  const noOptions = schema.attributes.filter(
    (attr) =>
      isSelect(attr.dataType) &&
      (attr.valueListId === null ||
        (listSizes.get(attr.valueListId) ?? 0) === 0),
  ).length;
  const malformed = schema.attributes.filter(
    (attr) =>
      attr.implementation === "custom" &&
      attr.key !== "" &&
      !KEY_PATTERN.test(attr.key),
  ).length;
  const keyCounts = new Map<string, number>();
  for (const attr of schema.attributes) {
    if (attr.key === "") continue;
    const key = `${attr.scope}:${attr.key}`;
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  const duplicates = [...keyCounts.values()].filter((n) => n > 1).length;
  const problems = schemaProblems(schema);

  return [
    {
      id: "empty-types",
      count: empty,
      message: `${empty} ${plural(empty, "product type has", "product types have")} no attributes`,
      area: "types",
    },
    {
      id: "unused-attributes",
      count: unused,
      message: `${unused} ${plural(unused, "attribute is", "attributes are")} not used by any type`,
      area: "attributes",
    },
    {
      id: "unmapped-attributes",
      count: unmapped,
      message: `${unmapped} ${plural(unmapped, "attribute has", "attributes have")} no Shopify field`,
      area: "attributes",
    },
    {
      id: "select-without-options",
      count: noOptions,
      message: `${noOptions} select ${plural(noOptions, "attribute needs", "attributes need")} options`,
      area: "attributes",
    },
    {
      id: "field-keys",
      count: malformed + duplicates,
      message: `${malformed} malformed and ${duplicates} duplicate Shopify field ${plural(malformed + duplicates, "key", "keys")}`,
      area: "attributes",
    },
    {
      id: "integrity",
      count: problems.length,
      message: problems[0] ?? "",
      area: "settings",
    },
  ];
}
