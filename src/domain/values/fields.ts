import { pathOf } from "~/domain/attributes/resolve";
import type { AttributeSchema } from "~/domain/attributes/types";
import {
  attributeFields,
  type AttributeField,
  type DefinitionTypes,
} from "~/domain/products/attribute-values";
import { typeForProduct } from "~/domain/products/workspace";
import {
  DISCIPLINE_TYPE_NAME,
  RIG_ROLES,
  ROLE_TYPE_NAMES,
  type RigRole,
} from "~/domain/rig/keys";

import type { ValuesProduct } from "./types";

/**
 * Which type a product has and which fields that makes (docs/attributes.md
 * § Bulk values). The same resolution the product page and the rig engine
 * use, so a column means for a product what the product page's field
 * means.
 */

/** The type of a product, or null when it has none or is claimed by two. */
export function typeOfProduct(
  schema: AttributeSchema,
  product: Pick<
    ValuesProduct,
    "productType" | "categoryName" | "chosenTypeId"
  >,
): string | null {
  const match = typeForProduct(schema, {
    categoryName: product.categoryName,
    categoryFullName: null,
    productType: product.productType,
    chosenTypeId: product.chosenTypeId,
  });
  return match.kind === "matched" ? match.typeId : null;
}

/** The rig role a type makes its products, from its path (the engine's rule). */
export function roleOfType(
  schema: AttributeSchema,
  typeId: string,
): RigRole | null {
  const names = pathOf(schema, typeId).map((name) => name.trim().toLowerCase());
  if (!names.includes(DISCIPLINE_TYPE_NAME.toLowerCase())) return null;
  for (const role of RIG_ROLES) {
    const wanted = ROLE_TYPE_NAMES[role].map((name) => name.toLowerCase());
    if (names.some((name) => wanted.includes(name))) return role;
  }
  return null;
}

/**
 * The fields of a product, per type, with the Shopify type each is
 * written as. A product whose stored values are typed differently from the
 * format (and has no definition to say otherwise) gets its own reading, as
 * on the product page; every other product shares its type's.
 */
export class FieldResolver {
  private readonly base = new Map<string, AttributeField[]>();
  private readonly keys = new Map<string, Set<string>>();
  private readonly special = new Map<string, AttributeField[]>();

  constructor(
    private readonly schema: AttributeSchema,
    private readonly definitions: DefinitionTypes,
  ) {}

  /** The type's fields as the format alone would write them. */
  forType(typeId: string): AttributeField[] {
    let fields = this.base.get(typeId);
    if (!fields) {
      fields = attributeFields(this.schema, typeId, {
        definitions: this.definitions,
        product: {},
        variants: [],
      });
      this.base.set(typeId, fields);
      this.keys.set(
        typeId,
        new Set(fields.map((field) => `${field.namespace}.${field.key}`)),
      );
    }
    return fields;
  }

  forProduct(product: ValuesProduct, typeId: string): AttributeField[] {
    const base = this.forType(typeId);
    const keys = this.keys.get(typeId) ?? new Set<string>();
    const seen: string[] = [];
    const note = (
      map: Record<string, { type: string; value: string } | undefined>,
    ) => {
      for (const key of keys) {
        const entry = map[key];
        // A measurement's unit is read off the stored value too.
        const unit = /"unit"\s*:\s*"(\w+)"/.exec(entry?.value ?? "")?.[1];
        if (entry) seen.push(`${key}:${entry.type}${unit ? `:${unit}` : ""}`);
      }
    };
    note(product.metafields);
    for (const variant of product.variants) note(variant.metafields);
    if (seen.length === 0) return base;
    const signature = `${typeId}|${[...new Set(seen)].sort().join(",")}`;
    let fields = this.special.get(signature);
    if (!fields) {
      fields = attributeFields(this.schema, typeId, {
        definitions: this.definitions,
        product: product.metafields,
        variants: product.variants.map((variant) => variant.metafields),
      });
      this.special.set(signature, fields);
    }
    return fields;
  }
}
