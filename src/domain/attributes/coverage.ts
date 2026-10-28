import { activeAttributes, isWithin } from "~/domain/attributes/resolve";
import {
  RIG_COVERAGE_TYPES,
  RIG_TYPES,
  type RigTypeId,
} from "~/domain/attributes/rig-pack";
import { KEY_NAMESPACE, type AttributeSchema } from "~/domain/attributes/types";

/**
 * Rig readiness (docs/attributes.md § Rig readiness): per rig type, how many
 * products have every required attribute and which attribute is missing on
 * how many. Pure; the caller says what each product holds.
 */

export interface CoverageProduct {
  productId: string;
  /** The product's plan type, or null when it has none. */
  typeId: string | null;
  /**
   * Full keys (`recharge.sail_area_m2`) the product holds a value for. A
   * variant attribute counts only when every variant has it.
   */
  filled: readonly string[];
}

export interface RigCoverage {
  type: RigTypeId;
  /** The type's name in the plan. */
  name: string;
  typeId: string;
  /** Products of this type or a type beneath it. */
  products: number;
  withAllRequired: number;
  /** Missing attribute (key after the namespace) → products lacking it. */
  missing: Record<string, number>;
  /** The products lacking at least one, in catalogue order. */
  incomplete: string[];
  /** The attributes the type requires, by key after the namespace. */
  required: string[];
}

const shortKey = (key: string) =>
  key.startsWith(`${KEY_NAMESPACE}.`)
    ? key.slice(KEY_NAMESPACE.length + 1)
    : key;

/** One entry per rig type that is in the plan, in the order of `RIG_COVERAGE_TYPES`. */
export function coverage(
  schema: AttributeSchema,
  catalogue: readonly CoverageProduct[],
): RigCoverage[] {
  const out: RigCoverage[] = [];
  for (const id of RIG_COVERAGE_TYPES) {
    const name = RIG_TYPES.find((type) => type.id === id)?.name ?? id;
    const type = schema.types.find(
      (candidate) => candidate.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (!type) continue;
    const required = activeAttributes(schema, type.id)
      .filter((row) => row.required && row.attribute.key.trim() !== "")
      .map((row) => row.attribute.key.trim());
    const result: RigCoverage = {
      type: id,
      name: type.name,
      typeId: type.id,
      products: 0,
      withAllRequired: 0,
      missing: {},
      incomplete: [],
      required: required.map(shortKey),
    };
    for (const product of catalogue) {
      if (product.typeId === null || !isWithin(schema, product.typeId, type.id))
        continue;
      result.products += 1;
      const have = new Set(product.filled);
      const lacking = required.filter((key) => !have.has(key));
      if (lacking.length === 0) result.withAllRequired += 1;
      else {
        result.incomplete.push(product.productId);
        for (const key of lacking)
          result.missing[shortKey(key)] =
            (result.missing[shortKey(key)] ?? 0) + 1;
      }
    }
    out.push(result);
  }
  return out;
}
