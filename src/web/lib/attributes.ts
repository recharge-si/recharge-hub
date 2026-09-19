import type {
  DataType,
  Implementation,
  Scope,
} from "~/domain/attributes/types";

/**
 * The attribute schema in the merchant's words (docs/ui-conventions.md).
 * Pure and client-safe: the catalogue, the editor, the product types page
 * and the settings page all read from here so one concept has one name.
 */

export const ATTRIBUTE_ROUTES = {
  index: "/app/attributes",
  types: "/app/attributes/types",
  settings: "/app/attributes/settings",
  export: "/app/attributes/schema.json",
  attribute: (id: string) => `/app/attributes/${id}`,
  type: (id: string) => `/app/attributes/types/${id}`,
} as const;

export const DATA_TYPE_LABEL: Record<DataType, string> = {
  text: "Text",
  integer: "Whole number",
  decimal: "Decimal number",
  boolean: "Yes or no",
  single_select: "Single choice",
  multi_select: "Multiple choice",
  measurement: "Measurement",
  reference: "Reference",
  date: "Date",
};

export const DATA_TYPE_OPTIONS = (
  Object.entries(DATA_TYPE_LABEL) as Array<[DataType, string]>
).map(([value, label]) => ({ value, label }));

export const SCOPE_LABEL: Record<Scope, string> = {
  product: "Product",
  variant: "Variant",
};

export const SCOPE_OPTIONS = (
  Object.entries(SCOPE_LABEL) as Array<[Scope, string]>
).map(([value, label]) => ({ value, label }));

export const IMPLEMENTATION_LABEL: Record<Implementation, string> = {
  custom: "Custom field",
  native: "Native Shopify field",
};

export const IMPLEMENTATION_OPTIONS = (
  Object.entries(IMPLEMENTATION_LABEL) as Array<[Implementation, string]>
).map(([value, label]) => ({ value, label }));

/** "Measurement · cm · Variant" — one line under an attribute's name. */
export function describeAttribute(attribute: {
  dataType: DataType;
  unit: string;
  scope: Scope;
}): string {
  return [
    DATA_TYPE_LABEL[attribute.dataType],
    attribute.unit || null,
    SCOPE_LABEL[attribute.scope],
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

export function countOf(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
}
