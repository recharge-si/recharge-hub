import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseCsvRows } from "~/domain/attributes/csv";
import { buildExport, countExportRows } from "~/domain/values/export";
import { idsInRows, planImport } from "~/domain/values/import";
import { LIMITS } from "~/domain/values/types";

import { valuesCatalogue, valuesPlan } from "../support/values-fixtures";

/**
 * docs/attributes.md § Bulk values: the export's shape, hints and
 * guards, and the import's outcomes against the catalogue snapshot.
 */

const plan = valuesPlan();
const definitions = new Map<string, string>();
const products = valuesCatalogue();
const mastsId = "masts";

const exported = (typeIds: string[], preset: "rig" | "all" = "rig") =>
  buildExport({ schema: plan, definitions, typeIds, preset, products });

const parse = (text: string) => parseCsvRows(text, { keepEmptyRows: true });

function column(rows: string[][], start: string): number {
  const at = (rows[0] ?? []).findIndex((header) => header.startsWith(start));
  if (at < 0) throw new Error(`no column ${start}`);
  return at;
}

function fill(
  rows: string[][],
  edits: Array<{ variant: string; column: string; value: string }>,
): string[][] {
  const copy = rows.map((row) => [...row]);
  const variantCol = column(copy, "variant_id");
  for (const edit of edits) {
    const row = copy.find((r) => r[variantCol]?.endsWith(`/${edit.variant}`));
    if (!row) throw new Error(`no variant ${edit.variant}`);
    row[column(copy, edit.column)] = edit.value;
  }
  return copy;
}

describe("the export", () => {
  it("has the identification columns, then one column per attribute with its key and unit", () => {
    const { text, rows, columns } = exported([mastsId]);
    const header = parse(text)[0] ?? [];
    expect(header.slice(0, 8)).toEqual([
      "product_id",
      "variant_id",
      "sku",
      "type",
      "vendor",
      "product",
      "variant",
      "option",
    ]);
    expect(header).toContain("Length [recharge.length_cm] (cm)");
    expect(header).toContain("Mast diameter [recharge.mast_diameter]");
    expect(rows).toBe(3);
    expect(columns.map((c) => c.key).sort()).toEqual([
      "recharge.carbon_percent",
      "recharge.length_cm",
      "recharge.mast_diameter",
      "recharge.mast_imcs",
    ]);
  });

  it("shows current values in plain form, and the product-scoped value on every variant row", () => {
    const rows = parse(exported([mastsId]).text);
    const length = column(rows, "Length");
    const diameter = column(rows, "Mast diameter");
    const carbon = column(rows, "Carbon percent");
    const body = rows.slice(1);
    expect(body.map((r) => r[length])).toEqual(["", "430", ""]);
    expect(body.map((r) => r[diameter])).toEqual(["rdm", "", ""]);
    expect(body.map((r) => r[carbon])).toEqual(["100", "100", "100"]);
  });

  it("puts a derivation in the hint column only where the value is empty", () => {
    const rows = parse(exported([mastsId]).text);
    const hint = column(rows, "hint_length_cm");
    // Variants 370 and 460 are empty and carry their option as a hint; 430 has a value.
    expect(rows.slice(1).map((r) => r[hint])).toEqual(["370", "", "460"]);
    const diam = column(rows, "hint_mast_diameter");
    expect(rows.slice(1).map((r) => r[diam])).toEqual(["", "rdm", "rdm"]);
  });

  it("never derives a compatibility fact", () => {
    const header = parse(exported(["freeride-sails", "booms"]).text)[0] ?? [];
    expect(header.filter((h) => h.startsWith("hint_"))).toEqual([
      "hint_canopy_area",
    ]);
  });

  it("chooses the rig essentials or every active attribute", () => {
    const rig = exported(["freeride-sails"], "rig").columns.map((c) => c.key);
    expect(rig).not.toContain("recharge.note");
    expect(rig).toContain("recharge.boom_max_cm");
    const all = exported(["freeride-sails"], "all").columns.map((c) => c.key);
    expect(all).toContain("recharge.note");
  });

  it("merges several types into one file", () => {
    const { rows, columns } = exported(["freeride-sails", "booms"]);
    expect(rows).toBe(5);
    expect(columns.map((c) => c.key)).toContain("recharge.canopy_area");
  });

  it("guards a cell that starts like a formula", () => {
    const risky = valuesCatalogue();
    risky[0]!.title = "=HYPERLINK(\"http://x\")";
    const { text } = buildExport({
      schema: plan,
      definitions,
      typeIds: [mastsId],
      preset: "rig",
      products: risky,
    });
    expect(text).toContain("'=HYPERLINK");
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it("counts rows before reading, and stops at the cap", () => {
    const light = products.map((p) => ({ ...p, variantCount: p.variants.length }));
    expect(countExportRows(plan, ["freeride-sails"], light)).toBe(3);
    const many = valuesCatalogue();
    many[0]!.variants = Array.from({ length: LIMITS.exportRows + 5 }, (_, i) => ({
      variantId: `gid://shopify/ProductVariant/${9000 + i}`,
      sku: null,
      title: String(i),
      options: [String(i)],
      metafields: {},
    }));
    const result = buildExport({
      schema: plan,
      definitions,
      typeIds: [mastsId],
      preset: "rig",
      products: many,
    });
    expect(result.rows).toBe(LIMITS.exportRows);
    expect(result.truncated).toBe(true);
  });
});

describe("the import preview", () => {
  const rows = parse(exported(["masts", "freeride-sails", "booms"]).text);
  const run = (edited: string[][], defs = definitions) =>
    planImport({ rows: edited, schema: plan, definitions: defs, products });

  it("reports an unedited export as nothing to do: every cell equals its current value", () => {
    const result = run(rows);
    expect(result.changes).toEqual([]);
    expect(result.counts.error).toBe(0);
    expect(result.counts.unchanged).toBeGreaterThan(0);
    expect(result.safeToApply).toBe(false);
  });

  it("counts set, change, clear and unchanged", () => {
    const edited = fill(rows, [
      { variant: "1001", column: "Length", value: "370" },
      { variant: "1002", column: "Length", value: "435,5" },
      { variant: "1002", column: "Mast diameter", value: "[clear]" },
      { variant: "1001", column: "Mast diameter", value: "RDM" },
    ]);
    const result = run(edited);
    expect(result.counts).toMatchObject({
      set: 1,
      change: 1,
      clear: 0,
      error: 0,
    });
    const set = result.changes.find((c) => c.ownerId.endsWith("/1001"));
    expect(set).toMatchObject({
      op: "set",
      kind: "measurement",
      value: '{"value":370,"unit":"CENTIMETERS"}',
      before: null,
    });
    const change = result.changes.find((c) => c.ownerId.endsWith("/1002"));
    expect(change).toMatchObject({
      beforeText: "430 cm",
      afterText: "435.5 cm",
      before: { type: "dimension" },
    });
    expect(result.safeToApply).toBe(true);
  });

  it("clears a value with [clear], and leaves a clear on an empty cell as unchanged", () => {
    const edited = fill(rows, [
      { variant: "1002", column: "Length", value: "[clear]" },
      { variant: "1003", column: "Length", value: "[clear]" },
    ]);
    const result = run(edited);
    const base = run(rows).counts.unchanged;
    expect(result.counts).toMatchObject({ clear: 1, unchanged: base });
    expect(result.changes[0]).toMatchObject({ op: "clear", value: null });
  });

  it("keeps the current value for a blank cell", () => {
    const result = run(rows);
    expect(result.counts.set + result.counts.change + result.counts.clear).toBe(0);
  });

  it("reads a select by label, a multi-select, and a number with a comma", () => {
    const edited = fill(rows, [
      { variant: "1003", column: "Mast diameter", value: "SDM" },
      { variant: "2003", column: "Compatible mast diameters", value: "RDM, SDM" },
      { variant: "2003", column: "Boom min", value: "170,5" },
    ]);
    const result = run(edited);
    expect(result.counts.error).toBe(0);
    const byKey = Object.fromEntries(
      result.changes.map((c) => [`${c.key}@${c.ownerId.slice(-4)}`, c.value]),
    );
    expect(byKey["mast_diameter@1003"]).toBe("sdm");
    expect(byKey["compatible_mast_diameters@2003"]).toBe('["rdm","sdm"]');
    expect(byKey["boom_min_cm@2003"]).toBe('{"value":170.5,"unit":"CENTIMETERS"}');
  });

  it("lists errors with the row, the column and the reason, and is not safe to apply", () => {
    const edited = fill(rows, [
      { variant: "1001", column: "Length", value: "430-460" },
      { variant: "1003", column: "Mast diameter", value: "xdm" },
    ]);
    const result = run(edited);
    expect(result.counts.error).toBe(2);
    expect(result.errorTotal).toBe(2);
    const rowOf = (variant: string) =>
      rows.findIndex((r) => r[1]?.endsWith(`/${variant}`)) + 1;
    expect(result.errors[0]).toMatchObject({
      row: rowOf("1001"),
      column: "Length [recharge.length_cm] (cm)",
    });
    expect(result.errors[0]?.message).toContain("not one number");
    expect(result.safeToApply).toBe(false);
  });

  it("counts every error but lists the first fifty", () => {
    const body = rows.slice(1).filter((r) => r[3]?.includes("Masts"));
    const many = [rows[0] ?? []];
    for (let i = 0; i < 60; i++) many.push([...(body[0] ?? [])]);
    const lengthCol = column(rows, "Length");
    many.slice(1).forEach((row, i) => (row[lengthCol] = `bad${i}`));
    const result = run(many);
    expect(result.errorTotal).toBeGreaterThan(50);
    expect(result.errors).toHaveLength(LIMITS.errorsShown);
  });

  it("makes an unknown id a row error", () => {
    const edited = rows.map((row) => [...row]);
    edited.push(["gid://shopify/Product/1", "gid://shopify/ProductVariant/9", "", "", "", "", "", "", "430"]);
    const result = run(edited);
    expect(result.errors.at(-1)).toMatchObject({ column: "variant_id" });
    expect(result.errors.at(-1)?.message).toContain("Unknown variant");
  });

  it("rejects a variant that belongs to another product", () => {
    const edited = fill(rows, [{ variant: "1001", column: "Length", value: "370" }]);
    const productCol = column(edited, "product_id");
    const variantCol = column(edited, "variant_id");
    const row = edited.find((r) => r[variantCol]?.endsWith("/1001"))!;
    row[productCol] = "gid://shopify/Product/200";
    expect(run(edited).errors[0]?.message).toContain("belongs to another product");
  });

  it("applies a product-scoped value once, and refuses two values for one product", () => {
    const same = fill(rows, [
      { variant: "1001", column: "Carbon percent", value: "90" },
      { variant: "1002", column: "Carbon percent", value: "90" },
      { variant: "1003", column: "Carbon percent", value: "90" },
    ]);
    const ok = run(same);
    expect(ok.changes.filter((c) => c.key === "carbon_percent")).toHaveLength(1);
    expect(ok.changes[0]).toMatchObject({ ownerId: "gid://shopify/Product/100", scope: "product" });

    const clash = fill(rows, [
      { variant: "1001", column: "Carbon percent", value: "90" },
      { variant: "1002", column: "Carbon percent", value: "80" },
    ]);
    const first = rows.findIndex((r) => r[1]?.endsWith("/1001")) + 1;
    expect(run(clash).errors[0]?.message).toContain(
      `Row ${first} gives this product another value`,
    );
  });

  it("skips a cell for an attribute the product's type does not have", () => {
    const edited = fill(rows, [
      { variant: "3001", column: "Length", value: "5" },
    ]);
    const result = run(edited);
    expect(result.counts.skipped).toBe(1);
    expect(result.skipped[0]?.message).toContain("Not an attribute of Booms");
    expect(result.safeToApply).toBe(false);
  });

  it("lists unknown columns, ignores hint columns and info columns", () => {
    const edited = rows.map((row, i) => [
      ...row,
      i === 0 ? "Colour" : "red",
    ]);
    const result = run(
      fill(edited, [{ variant: "1001", column: "hint_length_cm", value: "999" }]),
    );
    expect(result.unknownColumns).toEqual(["Colour"]);
    expect(result.hintColumns).toContain("hint_length_cm");
    expect(result.changes).toEqual([]);
  });

  it("imports a hint only when it is copied into the real column", () => {
    const edited = fill(rows, [{ variant: "1001", column: "Length", value: "370" }]);
    expect(run(edited).changes).toHaveLength(1);
  });

  it("matches columns by key first, then by name, then by bare key", () => {
    const sails = parse(exported(["freeride-sails"]).text);
    const byName = sails.map((row) => [...row]);
    const col = column(byName, "Boom min");
    byName[0]![col] = "Boom min";
    byName[2]![col] = "180";
    const byKey = sails.map((row) => [...row]);
    byKey[0]![col] = "boom_min_cm";
    byKey[3]![col] = "180";
    expect(run(byName).changes[0]).toMatchObject({ key: "boom_min_cm" });
    expect(run(byKey).changes[0]).toMatchObject({ key: "boom_min_cm" });
    const wrongKey = sails.map((row) => [...row]);
    wrongKey[0]![col] = "Boom min [recharge.not_a_key]";
    wrongKey[2]![col] = "180";
    expect(run(wrongKey).changes[0]).toMatchObject({ key: "boom_min_cm" });
  });

  it("reads a guarded text cell back as it was", () => {
    const all = parse(exported(["freeride-sails"], "all").text);
    const edited = fill(all, [
      { variant: "2003", column: "Note", value: "'=sum" },
    ]);
    expect(run(edited).changes[0]).toMatchObject({ value: "=sum" });
  });

  it("notes the attributes with no metafield definition as untyped", () => {
    const edited = fill(rows, [{ variant: "1001", column: "Length", value: "370" }]);
    expect(run(edited).untyped).toEqual(["Length"]);
    const defined = new Map([["PRODUCTVARIANT|recharge.length_cm", "dimension"]]);
    const typed = run(edited, defined);
    expect(typed.untyped).toEqual([]);
    expect(typed.changes[0]).toMatchObject({ defined: true, shopifyType: "dimension" });
  });

  it("refuses a file with no id column, no attribute columns, or too many rows", () => {
    expect(run([["Length [recharge.length_cm]"], ["1"]]).fileErrors[0]).toContain("product_id or variant_id");
    expect(run([["product_id", "colour"], ["x", "red"]]).fileErrors[0]).toContain("No column");
    const big = [rows[0] ?? []];
    for (let i = 0; i < LIMITS.importRows + 1; i++) big.push([]);
    expect(run(big).fileErrors[0]).toContain("more than 5,000 rows");
    expect(run([]).fileErrors[0]).toContain("empty");
  });

  it("keeps row numbers across blank lines", () => {
    const text = "product_id,variant_id,Length [recharge.length_cm]\n\n,gid://shopify/ProductVariant/1001,abc\n";
    const result = planImport({
      rows: parseCsvRows(text, { keepEmptyRows: true }),
      schema: plan,
      definitions,
      products,
    });
    expect(result.errors[0]?.row).toBe(3);
  });

  it("reads the ids a file names", () => {
    expect(idsInRows(rows).variantIds).toHaveLength(8);
    expect(idsInRows(rows).productIds).toHaveLength(3);
  });
});

describe("the fixture spreadsheet for masts and sails", () => {
  it("previews with the outcomes it documents", () => {
    const file = readFileSync(
      join(process.cwd(), "tests", "fixtures", "values", "masts-and-sails.csv"),
      "utf8",
    );
    const result = planImport({
      rows: parseCsvRows(file, { keepEmptyRows: true }),
      schema: plan,
      definitions,
      products,
    });
    expect(result.fileErrors).toEqual([]);
    expect(result.counts).toMatchObject({
      set: 7,
      change: 1,
      clear: 1,
      unchanged: 1,
      error: 1,
    });
    expect(result.errors[0]).toMatchObject({ row: 8, message: expect.stringContaining("not one number") });
    expect(result.unknownColumns).toEqual(["Colour"]);
  });
});
