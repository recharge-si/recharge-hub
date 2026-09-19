import type {
  DataType,
  Implementation,
  Scope,
} from "~/domain/attributes/types";

/**
 * Product setup in the merchant's words (docs/ui-conventions.md). Pure and
 * client-safe: every screen under /app/product-setup reads from here so one
 * concept has one name.
 */

export const PRODUCT_SETUP_ROUTES = {
  home: "/app/product-setup",
  types: "/app/product-setup/types",
  type: (id: string) => `/app/product-setup/types/${id}`,
  attributes: "/app/product-setup/attributes",
  attribute: (id: string) => `/app/product-setup/attributes/${id}`,
  sets: "/app/product-setup/sets",
  settings: "/app/product-setup/settings",
  export: "/app/product-setup/schema.json",
} as const;

/** The workspace's own navigation, in order. */
export const PRODUCT_SETUP_SECTIONS = [
  { key: "types", label: "Product types", href: PRODUCT_SETUP_ROUTES.types },
  {
    key: "attributes",
    label: "Attributes",
    href: PRODUCT_SETUP_ROUTES.attributes,
  },
  { key: "sets", label: "Attribute sets", href: PRODUCT_SETUP_ROUTES.sets },
  { key: "settings", label: "Settings", href: PRODUCT_SETUP_ROUTES.settings },
] as const;

export type ProductSetupSection =
  (typeof PRODUCT_SETUP_SECTIONS)[number]["key"];

/** Where the last chosen product type is remembered, per browser. */
export const LAST_TYPE_KEY = "product-setup:last-type";

export const DATA_TYPE_LABEL: Record<DataType, string> = {
  text: "Text",
  integer: "Whole number",
  decimal: "Decimal number",
  boolean: "Yes or no",
  single_select: "Single choice",
  multi_select: "Multiple choices",
  measurement: "Measurement",
  reference: "Reference",
  date: "Date",
};

/** One line under the format picker, so a choice explains itself. */
export const DATA_TYPE_HELP: Record<DataType, string> = {
  text: "Free text, such as a model name.",
  integer: "A whole number, such as a year or a count.",
  decimal: "A number with decimals, such as a weight.",
  boolean: "Yes or no.",
  single_select: "One option from a list you define.",
  multi_select: "Any number of options from a list you define.",
  measurement: "A number with a unit, such as 4.7 m² or 430 cm.",
  reference: "A link to another product or page.",
  date: "A calendar date.",
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

/** Whether the format carries a unit worth asking for. */
export function takesUnit(dataType: DataType): boolean {
  return (
    dataType === "measurement" ||
    dataType === "integer" ||
    dataType === "decimal"
  );
}

/** "Measurement (cm)" — the format with its unit when it has one. */
export function formatLabel(attribute: {
  dataType: DataType;
  unit: string;
}): string {
  const label = DATA_TYPE_LABEL[attribute.dataType];
  return attribute.unit && takesUnit(attribute.dataType)
    ? `${label} (${attribute.unit})`
    : label;
}

/** "Measurement (cm) · Variant" — one line under an attribute's name. */
export function describeAttribute(attribute: {
  dataType: DataType;
  unit: string;
  scope: Scope;
}): string {
  return `${formatLabel(attribute)} · ${SCOPE_LABEL[attribute.scope]}`;
}

export function countOf(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
}
