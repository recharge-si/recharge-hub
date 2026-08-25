/**
 * What a template can read from a variant.
 *
 * Product and variant fields are fixed; metafields are not. Which metafields a
 * shop has is the merchant's business, so they are resolved from the shop's own
 * definitions and passed in — never hardcoded here. That is also why the
 * registry is a function of those definitions rather than a constant.
 *
 * Pure (section 5): the adapter fetches the definitions, this decides what they
 * mean.
 */
import type { VariantFacts } from "./types";

export type FieldGroup = "product" | "variant" | "metafield";

export interface FieldDef {
  /** What goes inside the braces. */
  id: string;
  label: string;
  group: FieldGroup;
  /** Present for metafields, so the editor can show where a value comes from. */
  namespace?: string;
  key?: string;
}

/** A metafield definition as the shop reports it. */
export interface MetafieldDefinition {
  namespace: string;
  key: string;
  name: string;
  /** "PRODUCT" or "PRODUCTVARIANT" — decides which group it lists under. */
  ownerType: string;
}

export const PRODUCT_FIELDS: FieldDef[] = [
  { id: "title", label: "Product title", group: "product" },
  { id: "vendor", label: "Vendor", group: "product" },
  { id: "type", label: "Product type", group: "product" },
  { id: "handle", label: "Handle", group: "product" },
];

export const VARIANT_FIELDS: FieldDef[] = [
  { id: "options", label: "All option values", group: "variant" },
  { id: "option1", label: "First option value", group: "variant" },
  { id: "option2", label: "Second option value", group: "variant" },
  { id: "option3", label: "Third option value", group: "variant" },
  { id: "option1name", label: "First option name", group: "variant" },
  { id: "option2name", label: "Second option name", group: "variant" },
  { id: "option3name", label: "Third option name", group: "variant" },
  { id: "variant", label: "Variant title", group: "variant" },
  { id: "sku", label: "SKU", group: "variant" },
  { id: "barcode", label: "Barcode", group: "variant" },
  { id: "price", label: "Price", group: "variant" },
];

/**
 * Which fields vary between the variants of one product. Used by the lint rule
 * that catches a multi-variant product whose template names every variant the
 * same.
 */
export const VARIANT_LEVEL_IDS = new Set(
  VARIANT_FIELDS.map((field) => field.id),
);

export const METAFIELD_PREFIX = "metafield.";

export function metafieldFieldId(namespace: string, key: string): string {
  return `${METAFIELD_PREFIX}${namespace}.${key}`;
}

/** The full list a template may reference, given what the shop defines. */
export function fieldRegistry(
  definitions: MetafieldDefinition[] = [],
): FieldDef[] {
  return [
    ...PRODUCT_FIELDS,
    ...VARIANT_FIELDS,
    ...definitions.map((definition) => ({
      id: metafieldFieldId(definition.namespace, definition.key),
      label: definition.name,
      group: "metafield" as const,
      namespace: definition.namespace,
      key: definition.key,
    })),
  ];
}

/** Shopify's placeholder on a product that has no real options. */
const PLACEHOLDER_VARIANT = "Default Title";

function optionAt(values: string[], index: number): string {
  return values[index] ?? "";
}

/**
 * Resolves one field against one variant. An unknown field returns null rather
 * than an empty string, so the caller can tell "this field does not exist" from
 * "this field is empty" — they lint differently.
 */
export function resolveField(
  field: string,
  facts: VariantFacts,
): string | null {
  if (field.startsWith(METAFIELD_PREFIX)) {
    const path = field.slice(METAFIELD_PREFIX.length);
    return facts.metafields?.[path] ?? "";
  }

  const values = facts.optionValues;

  switch (field) {
    case "title":
      return facts.productTitle;
    case "options":
      return values.join(" ");
    case "option1":
      return optionAt(values, 0);
    case "option2":
      return optionAt(values, 1);
    case "option3":
      return optionAt(values, 2);
    case "option1name":
      return optionAt(facts.optionNames, 0);
    case "option2name":
      return optionAt(facts.optionNames, 1);
    case "option3name":
      return optionAt(facts.optionNames, 2);
    case "variant":
      return facts.variantTitle === PLACEHOLDER_VARIANT
        ? ""
        : (facts.variantTitle ?? "");
    case "sku":
      return facts.sku;
    case "barcode":
      return facts.barcode ?? "";
    case "vendor":
      return facts.vendor ?? "";
    case "type":
      return facts.productType ?? "";
    case "handle":
      return facts.handle ?? "";
    case "price":
      return facts.price ?? "";
    default:
      return null;
  }
}
