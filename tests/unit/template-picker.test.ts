import { describe, expect, it } from "vitest";

import {
  applyPick,
  canAddField,
  fieldRegistry,
  flattenGroups,
  parseTemplate,
  pickerGroups,
  patternParts,
  pickerQueryAt,
  removeFieldAt,
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

describe("reading a pattern back as parts", () => {
  it("names each field and what it resolves to", () => {
    const parts = patternParts("{title}[ {option1}]", registry, sail);

    expect(parts.map((part) => [part.kind, part.label, part.value])).toEqual([
      ["field", "Product title", "Sail"],
      ["field", "First option value", "5.4"],
    ]);
  });

  it("keeps a separator between two fields as a part of its own", () => {
    const parts = patternParts("{title} - {sku}", registry, sail);

    expect(parts.map((part) => part.label)).toEqual([
      "Product title",
      "-",
      "SKU",
    ]);
  });

  it("keeps the merchant's own words as their own part", () => {
    const parts = patternParts('{vendor} "sale" {sku}', registry, sail);

    expect(parts.map((part) => part.kind)).toEqual(["field", "text", "field"]);
    expect(parts[1]?.label).toBe('"sale"');
  });

  it("marks a field that does not exist rather than hiding it", () => {
    const [part] = patternParts("{colour}", registry, sail);

    expect(part).toMatchObject({ known: false, label: "colour" });
  });

  it("says nothing about values when there is no product to read", () => {
    const parts = patternParts("{title}", registry, null);

    expect(parts[0]?.value).toBeNull();
  });
});

/** Parts are addressed by position, so find the one under test by name. */
function partAt(source: string, label: string): number {
  const part = patternParts(source, registry, sail).find(
    (candidate) => candidate.label === label,
  );
  if (!part) throw new Error(`No part labelled ${label} in ${source}`);
  return part.start;
}

describe("removing a field", () => {
  it("takes the separator with it when the group held only that field", () => {
    const source = "{title}[ - {options}]";

    expect(removeFieldAt(source, partAt(source, "All option values"))).toBe(
      "{title}",
    );
  });

  it("keeps a group that still has a field in it", () => {
    const source = "{title}[ ({option1}/{option2})]";

    expect(removeFieldAt(source, partAt(source, "Second option value"))).toBe(
      "{title}[ ({option1}/)]",
    );
  });

  it("trims punctuation left at the ends", () => {
    const source = "{title} - {sku}";

    expect(removeFieldAt(source, partAt(source, "SKU"))).toBe("{title}");
  });

  it("leaves the pattern alone when nothing sits at that position", () => {
    expect(removeFieldAt("{title}", 99)).toBe("{title}");
  });

  it("keeps filters on the fields it does not remove", () => {
    const source = "{title|upper}[ {sku|lower}]";

    expect(removeFieldAt(source, partAt(source, "SKU"))).toBe("{title|upper}");
  });
});
