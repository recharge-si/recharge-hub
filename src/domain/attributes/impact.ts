import { deleteType, updateType } from "~/domain/attributes/mutations";
import {
  activeAttributes,
  ancestry,
  schemaHealth,
  typeById,
} from "~/domain/attributes/resolve";
import type { AttributeSchema } from "~/domain/attributes/types";

/**
 * What a structural change would actually do (docs/attributes.md
 * § Changes), so a confirmation can say it in numbers rather than in
 * warnings. Each one runs the change on a copy and diffs the fields every
 * affected type would carry before and after.
 */

export interface StructuralImpact {
  /** Types beneath the one changed, at any depth. */
  descendants: number;
  /** Direct children, which a delete moves up a level. */
  children: number;
  /** Sets and attributes attached on the type itself. */
  sourcesHere: number;
  /** Requirement changes and removals made on the type itself. */
  rulesHere: number;
  /** Fields that would disappear from some type, counted per type. */
  fieldsLost: number;
  /** Fields that would appear on some type, counted per type. */
  fieldsGained: number;
  /** How many types lose or gain at least one field. */
  typesAffected: number;
}

function descendantsOf(schema: AttributeSchema, typeId: string): string[] {
  return schema.types
    .filter(
      (type) =>
        type.id !== typeId && ancestry(schema, type.id).includes(typeId),
    )
    .map((type) => type.id);
}

function diffFields(
  before: AttributeSchema,
  after: AttributeSchema,
  typeIds: string[],
): Pick<StructuralImpact, "fieldsLost" | "fieldsGained" | "typesAffected"> {
  let fieldsLost = 0;
  let fieldsGained = 0;
  let typesAffected = 0;
  for (const typeId of typeIds) {
    if (typeById(after, typeId) === null) continue;
    const was = new Set(
      activeAttributes(before, typeId).map((r) => r.attribute.id),
    );
    const is = new Set(
      activeAttributes(after, typeId).map((r) => r.attribute.id),
    );
    const lost = [...was].filter((id) => !is.has(id)).length;
    const gained = [...is].filter((id) => !was.has(id)).length;
    fieldsLost += lost;
    fieldsGained += gained;
    if (lost + gained > 0) typesAffected += 1;
  }
  return { fieldsLost, fieldsGained, typesAffected };
}

export function impactOfDeletingType(
  schema: AttributeSchema,
  typeId: string,
): StructuralImpact | null {
  const type = typeById(schema, typeId);
  if (!type) return null;
  const descendants = descendantsOf(schema, typeId);
  const result = deleteType(schema, typeId);
  const after = result.ok ? result.schema : schema;
  return {
    descendants: descendants.length,
    children: schema.types.filter((t) => t.parentId === typeId).length,
    sourcesHere:
      schema.setAssignments.filter((r) => r.typeId === typeId).length +
      schema.attributeAssignments.filter((r) => r.typeId === typeId).length,
    rulesHere:
      schema.overrides.filter((r) => r.typeId === typeId).length +
      schema.exclusions.filter((r) => r.typeId === typeId).length,
    ...diffFields(schema, after, descendants),
  };
}

export function impactOfMovingType(
  schema: AttributeSchema,
  typeId: string,
  parentId: string | null,
): StructuralImpact | null {
  const type = typeById(schema, typeId);
  if (!type) return null;
  const result = updateType(schema, typeId, {
    name: type.name,
    parentId,
    leaf: type.leaf,
    shopifyCategory: type.shopifyCategory,
    archetype: type.archetype,
  });
  const after = result.ok ? result.schema : schema;
  const affected = [typeId, ...descendantsOf(schema, typeId)];
  return {
    descendants: affected.length - 1,
    children: schema.types.filter((t) => t.parentId === typeId).length,
    sourcesHere: 0,
    rulesHere: 0,
    ...diffFields(schema, after, affected),
  };
}

/* -------------------------------------------------------------------------- */
/* Where the workspace stands                                                 */
/* -------------------------------------------------------------------------- */

export type WorkspaceStage = "empty" | "partial" | "issues" | "ok";

export interface WorkspaceState {
  stage: WorkspaceStage;
  /** One sentence saying where things stand; empty when `ok`. */
  summary: string;
  /** The checks that found something, worded for their counts. */
  problems: Array<{
    id: string;
    message: string;
    area: "types" | "attributes" | "settings";
  }>;
}

/**
 * Four honest states rather than one green line. Nothing configured is not
 * "everything passes"; a tree of categories with nothing assignable is not
 * either. Only a schema with something to check, that checks out, is `ok`.
 */
export function workspaceState(schema: AttributeSchema): WorkspaceState {
  const assignable = schema.types.filter((type) => type.leaf).length;
  const categories = schema.types.length - assignable;
  const problems = schemaHealth(schema)
    .filter((check) => check.count > 0)
    .map(({ id, message, area }) => ({ id, message, area }));

  if (schema.types.length === 0 && schema.attributes.length === 0) {
    return { stage: "empty", summary: "Nothing configured yet.", problems: [] };
  }
  if (assignable === 0) {
    return {
      stage: "partial",
      summary:
        categories > 0
          ? `${categories} ${categories === 1 ? "category organises" : "categories organise"} the tree, but no product type can take products yet. Add one, or mark a category as a product type in its details.`
          : "No product types yet. Add one to start assigning attributes.",
      problems,
    };
  }
  if (schema.attributes.length === 0) {
    return {
      stage: "partial",
      summary: "Product types exist, but no attributes are defined yet.",
      problems,
    };
  }
  if (problems.length > 0) {
    return {
      stage: "issues",
      summary: `${problems.length} ${problems.length === 1 ? "check needs" : "checks need"} attention.`,
      problems,
    };
  }
  return { stage: "ok", summary: "", problems: [] };
}
