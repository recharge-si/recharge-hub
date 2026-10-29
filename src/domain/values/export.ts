import { activeAttributes, pathOf } from "~/domain/attributes/resolve";
import type { AttributeSchema, Scope } from "~/domain/attributes/types";
import type { DefinitionTypes } from "~/domain/products/attribute-values";
import {
  carbonPercentFromTitle,
  finLengthFromText,
  mastDiameterFromTitle,
  mastLengthFromText,
  sailAreaFromText,
} from "~/domain/rig/derive";
import { RIG_NAMESPACE, ROLE_FIELDS, type RigRole } from "~/domain/rig/keys";

import { cellFromStored, csvCell } from "./cells";
import { FieldResolver, roleOfType, typeOfProduct } from "./fields";
import { LIMITS, type ValuesProduct } from "./types";

/**
 * The export (docs/attributes.md § Bulk values): the products of some types
 * as one table, a row per variant, a column per attribute, what each holds
 * now, and the hints a rule can derive where a value is empty.
 *
 * Pure: the route reads the catalogue and hands it over.
 */

export const ID_COLUMNS = [
  "product_id",
  "variant_id",
  "sku",
  "type",
  "vendor",
  "product",
  "variant",
  "option",
] as const;

/** Columns that say which row this is and are never read back as values. */
export const INFO_COLUMNS: ReadonlySet<string> = new Set([
  "sku",
  "type",
  "vendor",
  "product",
  "variant",
  "option",
]);

export const HINT_PREFIX = "hint_";

export type Preset = "rig" | "all";

export interface ValueColumn {
  /** `namespace.key`. */
  key: string;
  name: string;
  unit: string;
  scope: Scope;
  header: string;
}

/** `Luff [recharge.luff_cm] (cm)`: the name, the key and the unit. */
export function columnHeader(
  name: string,
  key: string,
  unit: string,
): string {
  const cleanName = name.replace(/[[\]]/g, "").trim();
  return `${cleanName} [${key}]${unit.trim() ? ` (${unit.trim()})` : ""}`;
}

/* -------------------------------------------------------------------------- */
/* Which columns                                                              */
/* -------------------------------------------------------------------------- */

/** The keys the rig engine reads for a role, in the engine's order. */
export function rigKeys(role: RigRole): string[] {
  return [
    ...new Set(
      ROLE_FIELDS[role].map((spec) => `${RIG_NAMESPACE}.${spec.key}`),
    ),
  ];
}

/**
 * The columns for these types: each type's attributes (all the active ones,
 * or the rig engine's keys for the type's role), a key once however many
 * types have it, and never a field the product page cannot write.
 */
export function exportColumns(
  schema: AttributeSchema,
  typeIds: readonly string[],
  preset: Preset,
  resolver: FieldResolver,
): ValueColumn[] {
  const columns = new Map<string, ValueColumn>();
  for (const typeId of typeIds) {
    const role = roleOfType(schema, typeId);
    const wanted = preset === "rig" ? new Set(role ? rigKeys(role) : []) : null;
    const writable = new Set(
      resolver
        .forType(typeId)
        .filter((field) => field.edit.kind !== "blocked")
        .map((field) => field.attributeId),
    );
    for (const { attribute } of activeAttributes(schema, typeId)) {
      const key = attribute.key.trim();
      if (key === "" || columns.has(key)) continue;
      if (!writable.has(attribute.id)) continue;
      if (wanted && !wanted.has(key)) continue;
      columns.set(key, {
        key,
        name: attribute.name,
        unit: attribute.unit,
        scope: attribute.scope,
        header: columnHeader(attribute.name, key, attribute.unit),
      });
    }
  }
  return [...columns.values()];
}

/* -------------------------------------------------------------------------- */
/* Hints                                                                      */
/* -------------------------------------------------------------------------- */

interface HintInput {
  texts: string[];
  title: string;
}

type Hint = (input: HintInput) => number | string | null;

/**
 * What a rule can derive, per role and key (docs/rig-builder.md § Derived
 * facts). Never a compatibility fact: a boom range, a mast requirement, a
 * fin box or a rider mass has no rule here.
 */
const HINTS: Partial<Record<RigRole, Record<string, Hint>>> = {
  sail: { canopy_area: ({ texts }) => sailAreaFromText(texts) },
  mast: {
    length_cm: ({ texts }) => mastLengthFromText(texts),
    mast_diameter: ({ title }) => mastDiameterFromTitle(title),
    carbon_percent: ({ title }) => carbonPercentFromTitle(title),
  },
  fin: { length_cm: ({ texts }) => finLengthFromText(texts) },
};

/** `hint_luff_cm` for `recharge.luff_cm`. */
export function hintHeader(key: string): string {
  const dot = key.indexOf(".");
  return `${HINT_PREFIX}${dot >= 0 ? key.slice(dot + 1) : key}`;
}

function hintableKeys(): Set<string> {
  const keys = new Set<string>();
  for (const hints of Object.values(HINTS))
    for (const key of Object.keys(hints ?? {}))
      keys.add(`${RIG_NAMESPACE}.${key}`);
  return keys;
}

/* -------------------------------------------------------------------------- */
/* The file                                                                   */
/* -------------------------------------------------------------------------- */

export interface ExportInput {
  schema: AttributeSchema;
  definitions: DefinitionTypes;
  typeIds: readonly string[];
  preset: Preset;
  products: readonly ValuesProduct[];
}

export interface ExportResult {
  /** CSV text without the byte order mark. */
  text: string;
  rows: number;
  columns: ValueColumn[];
  truncated: boolean;
}

/** The variants a selection of types would export, to refuse a download that is too big. */
export function countExportRows(
  schema: AttributeSchema,
  typeIds: readonly string[],
  products: ReadonlyArray<
    Pick<ValuesProduct, "productType" | "categoryName" | "chosenTypeId"> & {
      variantCount: number;
    }
  >,
): number {
  const wanted = new Set(typeIds);
  let rows = 0;
  for (const product of products) {
    const typeId = typeOfProduct(schema, product);
    if (typeId && wanted.has(typeId)) rows += product.variantCount;
  }
  return rows;
}

export function buildExport(input: ExportInput): ExportResult {
  const { schema, typeIds, preset } = input;
  const resolver = new FieldResolver(schema, input.definitions);
  const columns = exportColumns(schema, typeIds, preset, resolver);
  const hintKeys = hintableKeys();
  const hintColumns = columns.filter((column) => hintKeys.has(column.key));

  const header = [
    ...ID_COLUMNS,
    ...columns.map((column) => column.header),
    ...hintColumns.map((column) => hintHeader(column.key)),
  ];
  const lines = [header.map(csvCell).join(",")];

  const wanted = new Set(typeIds);
  const typed = input.products.flatMap((product) => {
    const typeId = typeOfProduct(schema, product);
    return typeId && wanted.has(typeId) ? [{ product, typeId }] : [];
  });
  const name = (typeId: string) => pathOf(schema, typeId).join(" > ");
  typed.sort(
    (a, b) =>
      name(a.typeId).localeCompare(name(b.typeId)) ||
      a.product.title.localeCompare(b.product.title) ||
      a.product.productId.localeCompare(b.product.productId),
  );

  let rows = 0;
  let truncated = false;
  outer: for (const { product, typeId } of typed) {
    const fields = resolver.forProduct(product, typeId);
    const byKey = new Map(
      fields.map((field) => [`${field.namespace}.${field.key}`, field]),
    );
    const role = roleOfType(schema, typeId);
    for (const variant of product.variants) {
      if (rows >= LIMITS.exportRows) {
        truncated = true;
        break outer;
      }
      const stored = (column: ValueColumn) =>
        column.scope === "variant"
          ? variant.metafields[column.key]
          : product.metafields[column.key];
      const cells: string[] = [
        product.productId,
        variant.variantId,
        variant.sku ?? "",
        name(typeId),
        product.vendor,
        product.title,
        variant.title,
        variant.options.join(" / "),
      ];
      for (const column of columns) {
        const field = byKey.get(column.key);
        cells.push(field ? cellFromStored(field.edit, stored(column)) : "");
      }
      const texts = [...variant.options, variant.title].filter(
        (text) => text.trim() !== "" && text !== "Default Title",
      );
      for (const column of hintColumns) {
        const field = byKey.get(column.key);
        const rule = role
          ? HINTS[role]?.[column.key.slice(RIG_NAMESPACE.length + 1)]
          : undefined;
        const empty = !stored(column);
        const value =
          field && rule && empty ? rule({ texts, title: product.title }) : null;
        cells.push(value === null ? "" : String(value));
      }
      lines.push(cells.map(csvCell).join(","));
      rows += 1;
    }
  }
  return { text: lines.join("\r\n") + "\r\n", rows, columns, truncated };
}
