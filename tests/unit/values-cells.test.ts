import { describe, expect, it } from "vitest";

import type { FieldEdit } from "~/domain/products/attribute-values";
import {
  canonicalStored,
  cellFromStored,
  csvCell,
  guardCell,
  parseCell,
  unguardCell,
} from "~/domain/values/cells";

/**
 * docs/attributes.md § Bulk values: a cell is read with the product page's
 * validator, from the shapes the production data brief lists.
 */

const options = [
  { code: "rdm", label: "RDM" },
  { code: "sdm", label: "SDM" },
  { code: "power_box", label: "Power Box" },
];

const base = { shopifyType: "x", unit: "", measurementUnit: null, options };
const edit = (kind: Extract<FieldEdit, { kind: string }>["kind"], extra = {}) =>
  ({ ...base, kind, ...extra }) as FieldEdit;

const measurement = edit("measurement", {
  shopifyType: "dimension",
  unit: "cm",
  measurementUnit: "CENTIMETERS",
});
const decimal = edit("decimal", { shopifyType: "number_decimal" });
const choice = edit("choice");
const choices = edit("choices", { shopifyType: "list.single_line_text_field" });
const flag = edit("boolean", { shopifyType: "boolean" });

describe("reading a cell", () => {
  it("turns a measurement into the stored dimension JSON", () => {
    expect(parseCell(measurement, "37")).toMatchObject({
      ok: true,
      value: '{"value":37,"unit":"CENTIMETERS"}',
    });
  });

  it("reads a decimal comma but never a range or a unit", () => {
    expect(parseCell(decimal, "4,2")).toMatchObject({ ok: true, value: "4.2" });
    expect(parseCell(measurement, "37,5")).toMatchObject({
      ok: true,
      value: '{"value":37.5,"unit":"CENTIMETERS"}',
    });
    for (const bad of ["4-5", "4,2-4,8", "4 to 5", "37 cm", "1,234.5", "4..5", "abc"])
      expect(parseCell(decimal, bad).ok, bad).toBe(false);
  });

  it("reads an integer, tolerating a spreadsheet's .0", () => {
    const integer = edit("integer", { shopifyType: "number_integer" });
    expect(parseCell(integer, "3")).toMatchObject({ ok: true, value: "3" });
    expect(parseCell(integer, "3.0")).toMatchObject({ ok: true, value: "3" });
    expect(parseCell(integer, "3.5").ok).toBe(false);
  });

  it("reads a select by code, by label, and case-insensitively", () => {
    expect(parseCell(choice, "rdm")).toMatchObject({ ok: true, value: "rdm" });
    expect(parseCell(choice, "RDM")).toMatchObject({ ok: true, value: "rdm" });
    expect(parseCell(choice, "Power Box")).toMatchObject({
      ok: true,
      value: "power_box",
    });
    expect(parseCell(choice, "power box")).toMatchObject({
      ok: true,
      value: "power_box",
    });
  });

  it("names a select value that is none of the options", () => {
    const outcome = parseCell(choice, "xdm");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('"xdm"');
  });

  it("reads a multi-select separated by commas, semicolons or bars", () => {
    for (const text of ["rdm, sdm", "rdm;sdm", "RDM|SDM"])
      expect(parseCell(choices, text), text).toMatchObject({
        ok: true,
        value: '["rdm","sdm"]',
      });
    expect(parseCell(choices, "rdm, nope").ok).toBe(false);
    expect(parseCell(choices, "rdm, rdm")).toMatchObject({ value: '["rdm"]' });
  });

  it("reads booleans as yes, no, true or false", () => {
    for (const [text, value] of [
      ["yes", "true"],
      ["No", "false"],
      ["TRUE", "true"],
      ["false", "false"],
    ] as const)
      expect(parseCell(flag, text), text).toMatchObject({ ok: true, value });
    expect(parseCell(flag, "maybe").ok).toBe(false);
  });

  it("refuses a field the product page cannot write", () => {
    const outcome = parseCell(
      { kind: "blocked", reason: "A link to another record is chosen in Shopify." },
      "x",
    );
    expect(outcome).toEqual({
      ok: false,
      error: "A link to another record is chosen in Shopify.",
    });
  });
});

describe("a stored value as a cell", () => {
  it("strips the unit from a dimension", () => {
    expect(
      cellFromStored(measurement, {
        type: "dimension",
        value: '{"value":37.0,"unit":"CENTIMETERS"}',
      }),
    ).toBe("37");
  });

  it("shows a decimal plainly and a list comma separated", () => {
    expect(cellFromStored(decimal, { type: "number_decimal", value: "5.0" })).toBe("5");
    expect(
      cellFromStored(choices, {
        type: "list.single_line_text_field",
        value: '["rdm","sdm"]',
      }),
    ).toBe("rdm, sdm");
    expect(cellFromStored(flag, { type: "boolean", value: "true" })).toBe("yes");
  });

  it("compares two spellings of one value as equal", () => {
    expect(canonicalStored("decimal", "5.0")).toBe(canonicalStored("decimal", "5"));
    expect(canonicalStored("measurement", '{"value":37.0,"unit":"CENTIMETERS"}')).toBe("37");
    expect(canonicalStored("choices", '["sdm","rdm"]')).toBe(
      canonicalStored("choices", '["rdm","sdm"]'),
    );
    expect(canonicalStored("text", undefined)).toBe("");
  });
});

describe("formula injection", () => {
  it("guards a cell that starts like a formula and reads it back", () => {
    for (const cell of ["=1+1", "+5", "-5", "@SUM(A1)", "\tx", "=HYPERLINK(\"x\")"]) {
      const guarded = guardCell(cell);
      expect(guarded.startsWith("'")).toBe(true);
      expect(unguardCell(guarded)).toBe(cell);
    }
  });

  it("leaves other cells, and a real leading apostrophe, alone", () => {
    expect(guardCell("rdm")).toBe("rdm");
    expect(unguardCell("'tis")).toBe("'tis");
    expect(unguardCell("rdm")).toBe("rdm");
  });

  it("quotes what a CSV needs quoted", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "x"')).toBe('"say ""x"""');
    expect(csvCell("=cmd")).toBe("'=cmd");
  });
});
