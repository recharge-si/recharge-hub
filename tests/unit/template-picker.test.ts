import { describe, expect, it } from "vitest";

import {
  applyPick,
  canAddField,
  fieldRegistry,
  flattenGroups,
  parseTemplate,
  pickerGroups,
  pickerQueryAt,
  type VariantFacts,
} from "~/domain/products/template";

/**
 * The picker is the only part of the editor a merchant drives with the
 * keyboard alone, so every awkward caret position is settled here rather than
 * by clicking around the settings screen.
 */

const sail: VariantFacts = {
  productTitle: "Sail",
  variantTitle: "5.4",
  optionValues: ["5.4", "Carbon"],
  optionNames: ["Size", "Material"],
  sku: "S-54",
  barcode: null,
  vendor: "Acme",
  productType: "Sails",
  handle: "sail",
  price: "540.00",
  metafields: { "specs.area": "5.4 m2" },
  variantCount: 6,
};

const registry = fieldRegistry([
  {
    namespace: "specs",
    key: "area",
    name: "Sail area",
    ownerType: "PRODUCTVARIANT",
  },
]);

describe("when the picker is open", () => {
  it("opens on a bare brace at the caret", () => {
    expect(pickerQueryAt("{", 1)).toEqual({ start: 0, query: "" });
  });

  it("collects what has been typed after the brace", () => {
    expect(pickerQueryAt("{title} {opt", 12)).toEqual({
      start: 8,
      query: "opt",
    });
  });

  it("lowercases the query so the list does not depend on the shift key", () => {
    expect(pickerQueryAt("{OPT", 4)?.query).toBe("opt");
  });

  it("is closed once the field is closed", () => {
    expect(pickerQueryAt("{title}", 7)).toBeNull();
  });

  it("is closed when the caret moves back inside a finished field", () => {
    // Stepping left through "{title}" must not reopen the picker: the `}` is
    // not a field character, so the scan stops before reaching the brace.
    expect(pickerQueryAt("{title} x", 9)).toBeNull();
  });

  it("is closed on an escaped brace, which is literal text", () => {
    expect(pickerQueryAt(String.raw`\{tit`, 5)).toBeNull();
  });

  it("is open again when the backslash is itself escaped", () => {
    expect(pickerQueryAt(String.raw`\\{tit`, 6)).toEqual({
      start: 2,
      query: "tit",
    });
  });

  it("is closed when a space separates the brace from the caret", () => {
    expect(pickerQueryAt("{ tit", 5)).toBeNull();
  });

  it("is closed at the start of the field", () => {
    expect(pickerQueryAt("{title}", 0)).toBeNull();
  });
});

describe("choosing a field", () => {
  it("replaces the half-typed query, leaving nothing behind", () => {
    expect(applyPick("{title} {opt", 12, "option1")).toEqual({
      source: "{title} {option1}",
      caret: 17,
    });
  });

  it("keeps the text after the caret", () => {
    expect(applyPick("{ti - {sku}", 3, "title")).toEqual({
      source: "{title} - {sku}",
      caret: 7,
    });
  });

  it("inserts at the caret when the picker was not opened by a brace", () => {
    expect(applyPick("Acme ", 5, "title")).toEqual({
      source: "Acme {title}",
      caret: 12,
    });
  });

  it("produces something the parser reads back as one field", () => {
    const { source } = applyPick("{ti", 3, "title");
    const { nodes, errors } = parseTemplate(source);

    expect(errors).toEqual([]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: "token", field: "title" });
  });
});

describe("what the rows say", () => {
  it("shows the value each field resolves to for a real variant", () => {
    const rows = flattenGroups(pickerGroups(registry, "", sail));
    const byId = new Map(rows.map((row) => [row.field.id, row.value]));

    expect(byId.get("title")).toBe("Sail");
    expect(byId.get("option1")).toBe("5.4");
    expect(byId.get("metafield.specs.area")).toBe("5.4 m2");
  });

  it("says nothing rather than inventing a value when there is no variant", () => {
    const rows = flattenGroups(pickerGroups(registry, "", null));

    expect(rows.every((row) => row.value === null)).toBe(true);
  });

  it("reports an empty field as empty, not as missing", () => {
    const noBarcode = flattenGroups(pickerGroups(registry, "barcode", sail));

    expect(noBarcode[0]?.value).toBe("");
  });

  it("groups options apart from the rest of the variant", () => {
    const groups = pickerGroups(registry, "", sail);
    const ids = groups.map((group) => group.id);

    expect(ids).toEqual(["product", "variant", "options", "metafield"]);
    expect(
      groups.find((g) => g.id === "options")?.rows.map((r) => r.field.id),
    ).toContain("option1");
    expect(
      groups.find((g) => g.id === "variant")?.rows.map((r) => r.field.id),
    ).toContain("sku");
  });

  it("drops a group with nothing in it", () => {
    const groups = pickerGroups(fieldRegistry([]), "", sail);

    expect(groups.map((group) => group.id)).not.toContain("metafield");
  });

  it("matches on the label as well as the field name", () => {
    const rows = flattenGroups(pickerGroups(registry, "colour", sail));

    // "Colour" is not in any field id, only in the option-name labels.
    expect(rows.length).toBe(0);

    const byLabel = flattenGroups(pickerGroups(registry, "vendor", sail));
    expect(byLabel.map((row) => row.field.id)).toEqual(["vendor"]);
  });

  it("returns nothing when the query matches nothing", () => {
    expect(flattenGroups(pickerGroups(registry, "zzz", sail))).toEqual([]);
  });
});

describe("the field cap", () => {
  it("allows another field below the parser's limit", () => {
    expect(canAddField(parseTemplate("{title}").nodes)).toBe(true);
  });

  it("refuses once the template is full", () => {
    const full = "{title}".repeat(24);

    expect(canAddField(parseTemplate(full).nodes)).toBe(false);
  });
});
