import { pathOf } from "~/domain/attributes/resolve";
import type { AttributeSchema, Scope } from "~/domain/attributes/types";
import {
  definitionKey,
  type AttributeField,
  type DefinitionTypes,
  type InputKind,
} from "~/domain/products/attribute-values";

import {
  CLEAR_TOKEN,
  canonicalStored,
  displayOf,
  displayStored,
  parseCell,
  unguardCell,
} from "./cells";
import { HINT_PREFIX, ID_COLUMNS, INFO_COLUMNS } from "./export";
import { FieldResolver, typeOfProduct } from "./fields";
import { LIMITS, type ValuesProduct } from "./types";

/**
 * Reading a filled-in spreadsheet into a plan of changes (docs/attributes.md
 * § Bulk values). Writes nothing: it says, for every cell, what applying
 * would do, and keeps what the apply job needs to do exactly that and to
 * notice that someone changed a value since.
 *
 * Pure.
 */

export type Outcome =
  | "set"
  | "change"
  | "clear"
  | "unchanged"
  | "skipped"
  | "error";

export const OUTCOMES: readonly Outcome[] = [
  "set",
  "change",
  "clear",
  "unchanged",
  "skipped",
  "error",
];

export type Counts = Record<Outcome, number>;

export const emptyCounts = (): Counts => ({
  set: 0,
  change: 0,
  clear: 0,
  unchanged: 0,
  skipped: 0,
  error: 0,
});

/** One value to write or remove, with what it was when the file was read. */
export interface PlannedChange {
  /** The file's row (the header is row 1). */
  row: number;
  ownerId: string;
  productId: string;
  scope: Scope;
  attributeId: string;
  name: string;
  namespace: string;
  key: string;
  kind: InputKind;
  /** Shopify's type for a write; the same as the product page would use. */
  shopifyType: string;
  op: "set" | "clear";
  /** The metafield value to write; null to remove. */
  value: string | null;
  /** The stored value now, as the snapshot holds it; null when empty. */
  before: { type: string; value: string } | null;
  /** `canonicalStored` of `before` and of `value`: what the apply job compares. */
  beforeCanon: string;
  afterCanon: string;
  beforeText: string;
  afterText: string;
  /** Whether a metafield definition holds the type (false: untyped until one is made). */
  defined: boolean;
}

export interface Issue {
  row: number;
  column: string;
  message: string;
}

export interface SampleRow {
  row: number;
  product: string;
  variant: string;
  attribute: string;
  outcome: "set" | "change" | "clear";
  before: string;
  after: string;
}

export interface AttributeCounts {
  key: string;
  name: string;
  counts: Counts;
}

export interface ImportPlan {
  /** Why the file as a whole cannot be read; nothing else is then filled in. */
  fileErrors: string[];
  rowsRead: number;
  /** Rows that named a product or variant this shop has. */
  rowsMatched: number;
  counts: Counts;
  perAttribute: AttributeCounts[];
  errors: Issue[];
  /** The total, the list being cut at `LIMITS.errorsShown`. */
  errorTotal: number;
  skipped: Issue[];
  sample: SampleRow[];
  changes: PlannedChange[];
  unknownColumns: string[];
  hintColumns: string[];
  /** Attributes the file writes that have no metafield definition yet. */
  untyped: string[];
  safeToApply: boolean;
}

/* -------------------------------------------------------------------------- */
/* Columns                                                                    */
/* -------------------------------------------------------------------------- */

interface PlanAttribute {
  key: string;
  name: string;
}

/** `Luff [recharge.luff_cm] (cm)`: the bracketed key if there is one, the name before it. */
export function parseHeader(header: string): {
  key: string | null;
  name: string;
} {
  const text = header.trim();
  const bracket = /\[([^\]]+)\]/.exec(text);
  const before = bracket ? text.slice(0, bracket.index) : text;
  const name = before.replace(/\s*\([^()]*\)\s*$/, "").trim();
  return { key: bracket?.[1]?.trim() ?? null, name };
}

const fold = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

class ColumnIndex {
  private readonly byKey = new Map<string, PlanAttribute>();
  private readonly byTail = new Map<string, PlanAttribute | null>();
  private readonly byName = new Map<string, PlanAttribute | null>();

  constructor(schema: AttributeSchema) {
    for (const attribute of schema.attributes) {
      const key = attribute.key.trim();
      if (key === "") continue;
      const entry = { key, name: attribute.name };
      this.byKey.set(key.toLowerCase(), entry);
      const tail = key.slice(key.indexOf(".") + 1).toLowerCase();
      this.byTail.set(tail, this.byTail.has(tail) ? null : entry);
      const name = fold(attribute.name);
      this.byName.set(name, this.byName.has(name) ? null : entry);
    }
  }

  match(header: string): PlanAttribute | null {
    const { key, name } = parseHeader(header);
    if (key) {
      const hit = this.byKey.get(key.toLowerCase());
      if (hit) return hit;
    }
    return (
      this.byName.get(fold(name)) ??
      this.byKey.get(fold(name)) ??
      this.byTail.get(fold(name)) ??
      null
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Planning                                                                   */
/* -------------------------------------------------------------------------- */

export interface PlanInput {
  /** The file's rows as `parseCsvRows(text, { keepEmptyRows: true })` reads them. */
  rows: readonly string[][];
  schema: AttributeSchema;
  definitions: DefinitionTypes;
  /** The products the file names, with their variants, from the snapshot. */
  products: readonly ValuesProduct[];
}

/** The ids a file names, to read just those products. */
export function idsInRows(rows: readonly string[][]): {
  productIds: string[];
  variantIds: string[];
} {
  const header = (rows[0] ?? []).map((cell) => fold(cell));
  const product = header.indexOf("product_id");
  const variant = header.indexOf("variant_id");
  const take = (column: number) => [
    ...new Set(
      rows
        .slice(1)
        .map((row) => (column >= 0 ? (row[column] ?? "").trim() : ""))
        .filter((id) => id !== ""),
    ),
  ];
  return { productIds: take(product), variantIds: take(variant) };
}

function emptyPlan(fileErrors: string[]): ImportPlan {
  return {
    fileErrors,
    rowsRead: 0,
    rowsMatched: 0,
    counts: emptyCounts(),
    perAttribute: [],
    errors: [],
    errorTotal: 0,
    skipped: [],
    sample: [],
    changes: [],
    unknownColumns: [],
    hintColumns: [],
    untyped: [],
    safeToApply: false,
  };
}

interface AttributeColumn {
  index: number;
  header: string;
  key: string;
  name: string;
}

export function planImport(input: PlanInput): ImportPlan {
  const { schema, rows } = input;
  const header = rows[0];
  if (!header || header.every((cell) => cell.trim() === ""))
    return emptyPlan(["The file is empty. Export a file from this page and fill it in."]);
  if (rows.length - 1 > LIMITS.importRows)
    return emptyPlan([
      `The file has more than ${LIMITS.importRows.toLocaleString("en")} rows. Split it and import the parts one after another.`,
    ]);

  const names = header.map((cell) => fold(cell.replace(/^﻿/, "")));
  const productCol = names.indexOf("product_id");
  const variantCol = names.indexOf("variant_id");
  if (productCol < 0 && variantCol < 0)
    return emptyPlan([
      "The file has no product_id or variant_id column, so no row can be matched. Export a file from this page and fill that in.",
    ]);

  const index = new ColumnIndex(schema);
  const attributes: AttributeColumn[] = [];
  const unknownColumns: string[] = [];
  const hintColumns: string[] = [];
  const fileErrors: string[] = [];
  const taken = new Map<string, string>();
  header.forEach((raw, i) => {
    const text = raw.replace(/^﻿/, "").trim();
    const name = names[i] ?? "";
    if (text === "") return;
    if (
      (ID_COLUMNS as readonly string[]).includes(name) ||
      INFO_COLUMNS.has(name)
    )
      return;
    if (name.startsWith(HINT_PREFIX)) {
      hintColumns.push(text);
      return;
    }
    const hit = index.match(text);
    if (!hit) {
      unknownColumns.push(text);
      return;
    }
    const earlier = taken.get(hit.key);
    if (earlier !== undefined) {
      fileErrors.push(
        `The columns "${earlier}" and "${text}" are the same attribute. Keep one.`,
      );
      return;
    }
    taken.set(hit.key, text);
    attributes.push({ index: i, header: text, key: hit.key, name: hit.name });
  });
  if (fileErrors.length > 0) return { ...emptyPlan(fileErrors), unknownColumns, hintColumns };
  if (attributes.length === 0)
    return {
      ...emptyPlan([
        "No column in the file is an attribute of the plan. Export a file from this page and fill that in.",
      ]),
      unknownColumns,
      hintColumns,
    };

  const products = new Map(input.products.map((p) => [p.productId, p]));
  const variants = new Map(
    input.products.flatMap((p) =>
      p.variants.map((v) => [v.variantId, { product: p, variant: v }] as const),
    ),
  );
  const resolver = new FieldResolver(schema, input.definitions);

  const counts = emptyCounts();
  const perAttribute = new Map<string, AttributeCounts>(
    attributes.map((a) => [
      a.key,
      { key: a.key, name: a.name, counts: emptyCounts() },
    ]),
  );
  const errors: Issue[] = [];
  let errorTotal = 0;
  const skipped: Issue[] = [];
  const changes: PlannedChange[] = [];
  const sample: SampleRow[] = [];
  const seen = new Map<string, { row: number; canon: string }>();
  const untyped = new Set<string>();
  let rowsRead = 0;
  let rowsMatched = 0;

  const tally = (column: AttributeColumn, outcome: Outcome) => {
    counts[outcome] += 1;
    const entry = perAttribute.get(column.key);
    if (entry) entry.counts[outcome] += 1;
  };
  const fail = (row: number, column: string, message: string) => {
    errorTotal += 1;
    if (errors.length < LIMITS.errorsShown) errors.push({ row, column, message });
  };
  const skip = (row: number, column: string, message: string) => {
    if (skipped.length < LIMITS.errorsShown) skipped.push({ row, column, message });
  };

  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r] ?? [];
    if (cells.every((cell) => cell.trim() === "")) continue;
    const row = r + 1;
    rowsRead += 1;

    const productId = (cells[productCol] ?? "").trim();
    const variantId = (cells[variantCol] ?? "").trim();
    const found = variantId ? variants.get(variantId) : undefined;
    if (variantId && !found) {
      fail(row, "variant_id", `Unknown variant ${variantId}. It is not in this shop's catalogue.`);
      continue;
    }
    const product = found?.product ?? (productId ? products.get(productId) : undefined);
    if (!product) {
      fail(
        row,
        "product_id",
        productId
          ? `Unknown product ${productId}. It is not in this shop's catalogue.`
          : "The row names no product or variant.",
      );
      continue;
    }
    if (found && productId && productId !== product.productId) {
      fail(row, "product_id", `Variant ${variantId} belongs to another product than ${productId}.`);
      continue;
    }
    rowsMatched += 1;

    const filled = attributes.filter(
      (column) => (cells[column.index] ?? "").trim() !== "",
    );
    if (filled.length === 0) continue;

    const typeId = typeOfProduct(schema, product);
    const fields = typeId ? resolver.forProduct(product, typeId) : [];
    const byKey = new Map<string, AttributeField>(
      fields.map((field) => [`${field.namespace}.${field.key}`, field]),
    );
    const typeName = typeId ? (pathOf(schema, typeId).at(-1) ?? "") : "";

    for (const column of filled) {
      const text = unguardCell((cells[column.index] ?? "").trim());
      const field = byKey.get(column.key);
      if (!typeId) {
        tally(column, "skipped");
        skip(row, column.header, "The product has no product type in the plan, so it has no attributes.");
        continue;
      }
      if (!field) {
        tally(column, "skipped");
        skip(row, column.header, `Not an attribute of ${typeName}.`);
        continue;
      }
      if (field.edit.kind === "blocked") {
        tally(column, "skipped");
        skip(row, column.header, field.edit.reason);
        continue;
      }
      const edit = field.edit;
      let owner: { id: string; stored: { type: string; value: string } | undefined; label: string };
      if (field.scope === "variant") {
        if (!found) {
          tally(column, "error");
          fail(row, column.header, "This attribute is per variant, so the row needs a variant_id.");
          continue;
        }
        owner = {
          id: found.variant.variantId,
          stored: found.variant.metafields[column.key],
          label: found.variant.title,
        };
      } else
        owner = {
          id: product.productId,
          stored: product.metafields[column.key],
          label: "",
        };

      const clearing = fold(text) === CLEAR_TOKEN;
      const parsed = clearing ? null : parseCell(edit, text);
      if (parsed && !parsed.ok) {
        tally(column, "error");
        fail(row, column.header, parsed.error);
        continue;
      }
      const value = parsed && parsed.ok ? parsed.value : null;
      const beforeCanon = canonicalStored(edit.kind, owner.stored);
      const afterCanon = canonicalStored(edit.kind, value);

      const slot = `${owner.id}|${column.key}`;
      const earlier = seen.get(slot);
      if (earlier) {
        if (earlier.canon !== afterCanon) {
          tally(column, "error");
          fail(
            row,
            column.header,
            `Row ${earlier.row} gives this ${field.scope === "product" ? "product" : "variant"} another value.`,
          );
        }
        continue;
      }
      seen.set(slot, { row, canon: afterCanon });

      if (afterCanon === beforeCanon) {
        tally(column, "unchanged");
        continue;
      }
      const outcome: "set" | "change" | "clear" = clearing
        ? "clear"
        : beforeCanon === ""
          ? "set"
          : "change";
      const defined = input.definitions.has(definitionKey(field.scope, column.key));
      if (!defined) untyped.add(column.name);
      tally(column, outcome);
      if (changes.length >= LIMITS.changes) {
        fail(row, column.header, `The file changes more than ${LIMITS.changes.toLocaleString("en")} values. Split it.`);
        continue;
      }
      const change: PlannedChange = {
        row,
        ownerId: owner.id,
        productId: product.productId,
        scope: field.scope,
        attributeId: field.attributeId,
        name: field.name,
        namespace: field.namespace,
        key: field.key,
        kind: edit.kind,
        shopifyType: edit.shopifyType,
        op: clearing ? "clear" : "set",
        value,
        before: owner.stored ?? null,
        beforeCanon,
        afterCanon,
        beforeText: displayStored(edit, owner.stored),
        afterText:
          parsed && parsed.ok ? displayOf(edit, parsed.input) : "",
        defined,
      };
      changes.push(change);
      if (sample.length < LIMITS.sampleShown)
        sample.push({
          row,
          product: product.title,
          variant: owner.label,
          attribute: field.name,
          outcome,
          before: change.beforeText,
          after: change.afterText,
        });
    }
  }

  const plan: ImportPlan = {
    fileErrors: [],
    rowsRead,
    rowsMatched,
    counts,
    perAttribute: [...perAttribute.values()].filter((entry) =>
      OUTCOMES.some((outcome) => entry.counts[outcome] > 0),
    ),
    errors,
    errorTotal,
    skipped,
    sample,
    changes,
    unknownColumns,
    hintColumns,
    untyped: [...untyped].sort(),
    safeToApply: false,
  };
  plan.safeToApply = errorTotal === 0 && changes.length > 0;
  return plan;
}
