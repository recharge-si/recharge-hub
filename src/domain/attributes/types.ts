/**
 * The attribute schema (docs/attributes.md): what information every product
 * type needs, decided once and inherited down a tree of types.
 *
 * One document per shop. Everything in it is planning data — nothing here
 * reads or writes Shopify yet; the Shopify field key on an attribute is what
 * a later metafield definition would be created under.
 */

export const DATA_TYPES = [
  "text",
  "integer",
  "decimal",
  "boolean",
  "single_select",
  "multi_select",
  "measurement",
  "reference",
  "date",
] as const;

export type DataType = (typeof DATA_TYPES)[number];

export const SCOPES = ["product", "variant"] as const;
export type Scope = (typeof SCOPES)[number];

export const IMPLEMENTATIONS = ["custom", "native"] as const;
export type Implementation = (typeof IMPLEMENTATIONS)[number];

/** A node in the taxonomy: a category, or a type products can be assigned to. */
export interface ProductType {
  id: string;
  name: string;
  parentId: string | null;
  /** Products can use this type; false is an organising category. */
  leaf: boolean;
  sortOrder: number;
  /** Shopify's standard product category, planning only. */
  shopifyCategory: string;
  archetype: string;
}

/** A reusable bundle of attributes attached to a type as one. */
export interface AttributeSet {
  id: string;
  name: string;
  description: string;
}

/** One field, defined once and used by every type that resolves it. */
export interface Attribute {
  id: string;
  name: string;
  setId: string | null;
  dataType: DataType;
  unit: string;
  description: string;
  scope: Scope;
  /** The Shopify field this would map to, `namespace.key`. Empty is unmapped. */
  key: string;
  implementation: Implementation;
  requiredDefault: boolean;
  filterable: boolean;
  searchable: boolean;
  comparable: boolean;
  /** The options of a select attribute. */
  valueListId: string | null;
}

/** A set attached to a type; its attributes flow to the type's descendants. */
export interface SetAssignment {
  id: string;
  typeId: string;
  setId: string;
}

/** One attribute attached to a type directly, flowing to descendants too. */
export interface AttributeAssignment {
  id: string;
  typeId: string;
  attributeId: string;
}

/** A requirement decided for this exact type. Does not pass to descendants. */
export interface RequirementOverride {
  id: string;
  typeId: string;
  attributeId: string;
  required: boolean;
  reason: string;
}

/** An attribute hidden on this exact type. Does not pass to descendants. */
export interface Exclusion {
  id: string;
  typeId: string;
  attributeId: string;
}

export interface ValueListItem {
  code: string;
  en: string;
  si: string;
}

export interface ValueList {
  id: string;
  items: ValueListItem[];
}

export const SCHEMA_VERSION = 1;

export interface AttributeSchema {
  version: typeof SCHEMA_VERSION;
  types: ProductType[];
  sets: AttributeSet[];
  attributes: Attribute[];
  setAssignments: SetAssignment[];
  attributeAssignments: AttributeAssignment[];
  overrides: RequirementOverride[];
  exclusions: Exclusion[];
  valueLists: ValueList[];
}

/** A source of fresh ids, injected so the domain stays deterministic. */
export type IdSource = (prefix: string) => string;

export function emptySchema(): AttributeSchema {
  return {
    version: SCHEMA_VERSION,
    types: [],
    sets: [],
    attributes: [],
    setAssignments: [],
    attributeAssignments: [],
    overrides: [],
    exclusions: [],
    valueLists: [],
  };
}

export function isSelect(dataType: DataType): boolean {
  return dataType === "single_select" || dataType === "multi_select";
}

/** `Sail size` → `sail_size`; ASCII only, so the key is safe as a metafield key. */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "") || "field"
  );
}

/** The app's own namespace, so a generated key never collides with Shopify's. */
export const KEY_NAMESPACE = "recharge";

export function keyFor(name: string): string {
  return `${KEY_NAMESPACE}.${slugify(name)}`;
}

/** What a metafield definition accepts: `namespace.key`, both of a bounded length. */
export const KEY_PATTERN = /^[a-zA-Z0-9_-]{3,255}\.[a-zA-Z0-9_-]{3,64}$/;
