import { describe, expect, it } from "vitest";

import {
  activeAttributes,
  candidateAttributes,
  childrenOf,
  pathOf,
  schemaHealth,
  schemaMetrics,
  typesUsing,
} from "~/domain/attributes/resolve";
import {
  parseAttributeSchema,
  schemaProblems,
} from "~/domain/attributes/schema";
import { starterSchema } from "~/domain/attributes/starter";
import { emptySchema, keyFor, slugify } from "~/domain/attributes/types";

/**
 * docs/attributes.md § Document and § Inheritance.
 *
 * The document is checked whole before anything trusts it, and what a type
 * carries is a pure function of the tree: sets and attributes flow down,
 * requirement changes and removals stay where they were made.
 */

describe("the schema document", () => {
  it("accepts the starter schema and round-trips it", () => {
    const parsed = parseAttributeSchema(
      JSON.parse(JSON.stringify(starterSchema())),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.schema).toEqual(starterSchema());
  });

  it("accepts an empty schema", () => {
    expect(schemaProblems(emptySchema())).toEqual([]);
    expect(parseAttributeSchema(emptySchema()).ok).toBe(true);
  });

  it("refuses what is not an object", () => {
    expect(parseAttributeSchema(null).ok).toBe(false);
    expect(parseAttributeSchema([]).ok).toBe(false);
    expect(parseAttributeSchema("{}").ok).toBe(false);
  });

  it("names a missing parent, a cycle and a duplicate rule", () => {
    const schema = starterSchema();
    schema.types.push({
      id: "orphan",
      name: "Orphan",
      parentId: "nowhere",
      leaf: true,
      sortOrder: 1,
      shopifyCategory: "",
      archetype: "",
    });
    expect(schemaProblems(schema)).toContain(
      '"Orphan" has a parent that does not exist.',
    );

    const loop = starterSchema();
    const all = loop.types.find((t) => t.id === "all");
    if (all) all.parentId = "sails";
    expect(schemaProblems(loop).some((p) => p.includes("own ancestor"))).toBe(
      true,
    );

    const twice = starterSchema();
    twice.setAssignments.push({ id: "sa9", typeId: "all", setId: "core" });
    expect(schemaProblems(twice)).toContain(
      "A set assignment is stated twice.",
    );
  });

  it("refuses an option list with a repeated code", () => {
    const schema = starterSchema();
    schema.valueLists[0]?.items.push({ code: "beginner", en: "Again", si: "" });
    expect(
      schemaProblems(schema).some((p) =>
        p.includes('"beginner" is used twice'),
      ),
    ).toBe(true);
  });

  it("reads the standalone builder's own file and translates its names", () => {
    const legacy = {
      version: 3,
      taxonomy: {
        all: {
          id: "all",
          name: "All",
          parentId: null,
          leaf: false,
          sortOrder: 1,
        },
        wave: {
          id: "wave",
          name: "Wave",
          parentId: "all",
          leaf: true,
          sortOrder: 1,
          shopifyCategory: "Sports",
        },
      },
      groups: { core: { id: "core", name: "Core", description: "Shared" } },
      attributes: {
        size: {
          id: "size",
          name: "Size",
          groupId: "core",
          dataType: "Dropdown",
          scope: "Variant",
          namespaceKey: "recharge.size",
          requiredDefault: true,
          filterable: true,
          valueListId: "sizes",
          native: "Custom",
        },
        year: {
          id: "year",
          name: "Year",
          groupId: "core",
          dataType: "Number",
          scope: "Product",
          namespaceKey: "recharge.year",
        },
        ok: {
          id: "ok",
          name: "Approved",
          groupId: null,
          dataType: "Yes / No",
          scope: "Product",
          namespaceKey: "",
        },
      },
      assignments: { a1: { id: "a1", nodeId: "all", groupId: "core" } },
      directAssignments: {
        d1: { id: "d1", nodeId: "wave", attributeId: "ok" },
      },
      overrides: {
        o1: {
          id: "o1",
          nodeId: "wave",
          attributeId: "year",
          required: true,
          reason: "Why",
        },
      },
      exclusions: {},
      valuelists: {
        sizes: {
          id: "sizes",
          items: [{ code: "s", en: "Small", si: "Majhna" }],
        },
      },
      ui: { advanced: true },
    };

    const parsed = parseAttributeSchema(legacy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { schema } = parsed;
    expect(schema.types.map((t) => t.id)).toEqual(["all", "wave"]);
    expect(schema.sets[0]).toEqual({
      id: "core",
      name: "Core",
      description: "Shared",
    });
    const size = schema.attributes.find((a) => a.id === "size");
    expect(size).toMatchObject({
      setId: "core",
      dataType: "single_select",
      scope: "variant",
      key: "recharge.size",
      implementation: "custom",
      requiredDefault: true,
      filterable: true,
      valueListId: "sizes",
    });
    expect(schema.attributes.find((a) => a.id === "year")?.dataType).toBe(
      "decimal",
    );
    expect(schema.attributes.find((a) => a.id === "ok")).toMatchObject({
      setId: null,
      dataType: "boolean",
      scope: "product",
    });
    expect(schema.setAssignments).toEqual([
      { id: "a1", typeId: "all", setId: "core" },
    ]);
    expect(schema.attributeAssignments).toEqual([
      { id: "d1", typeId: "wave", attributeId: "ok" },
    ]);
    expect(schema.overrides[0]).toMatchObject({
      typeId: "wave",
      required: true,
      reason: "Why",
    });
    expect(schema.valueLists[0]?.items[0]).toEqual({
      code: "s",
      en: "Small",
      si: "Majhna",
    });
  });

  it("refuses a builder file whose references are broken, naming the problem", () => {
    const parsed = parseAttributeSchema({
      version: 2,
      taxonomy: { all: { name: "All", parentId: null, leaf: false } },
      attributes: {
        x: {
          name: "X",
          groupId: "missing",
          dataType: "Text",
          scope: "Product",
        },
      },
    });
    expect(parsed).toEqual({
      ok: false,
      message: '"X" belongs to a set that does not exist.',
    });
  });

  it("makes a Shopify field key from a name", () => {
    expect(slugify("Sail size")).toBe("sail_size");
    expect(slugify("Širina (cm)")).toBe("sirina_cm");
    expect(slugify("")).toBe("field");
    expect(keyFor("Luff length")).toBe("recharge.luff_length");
  });
});

describe("inheritance", () => {
  it("flows a set down the tree and reports where each field comes from", () => {
    const schema = starterSchema();
    const wave = activeAttributes(schema, "wave");
    const names = wave.map((row) => row.attribute.name);
    expect(names).toContain("Brand");
    expect(names).toContain("Sail size");
    expect(names).not.toContain("Volume");
    expect(wave.find((row) => row.attribute.id === "brand")?.sourceTypeId).toBe(
      "all",
    );
    expect(
      wave.find((row) => row.attribute.id === "sailsize")?.sourceTypeId,
    ).toBe("sails");
  });

  it("puts required fields first, then names in a stable order", () => {
    const rows = activeAttributes(starterSchema(), "wave");
    const required = rows.filter((row) => row.required).length;
    expect(rows.slice(0, required).every((row) => row.required)).toBe(true);
    expect(rows.slice(required).every((row) => !row.required)).toBe(true);
  });

  it("applies a requirement change to the exact type and to nothing else", () => {
    const schema = starterSchema();
    const onWave = activeAttributes(schema, "wave").find(
      (row) => row.attribute.id === "skill",
    );
    const onFreeride = activeAttributes(schema, "freeride").find(
      (row) => row.attribute.id === "skill",
    );
    expect(onWave?.required).toBe(true);
    expect(onWave?.override?.reason).toBe("Important for wave sail selection");
    expect(onFreeride?.required).toBe(false);
    expect(onFreeride?.override).toBeNull();
  });

  it("hides a removed field on the exact type only, and still lists it as a candidate", () => {
    const schema = starterSchema();
    schema.exclusions.push({ id: "ex1", typeId: "wave", attributeId: "brand" });
    expect(
      activeAttributes(schema, "wave").some(
        (row) => row.attribute.id === "brand",
      ),
    ).toBe(false);
    expect(
      candidateAttributes(schema, "wave").find(
        (row) => row.attribute.id === "brand",
      )?.exclusion?.id,
    ).toBe("ex1");
    expect(
      activeAttributes(schema, "freeride").some(
        (row) => row.attribute.id === "brand",
      ),
    ).toBe(true);
    expect(typesUsing(schema, "brand").map((t) => t.id)).not.toContain("wave");
  });

  it("lets the nearest source win when a set and a direct assignment both supply a field", () => {
    const schema = starterSchema();
    schema.attributeAssignments.push({
      id: "aa1",
      typeId: "wave",
      attributeId: "brand",
    });
    const row = activeAttributes(schema, "wave").find(
      (r) => r.attribute.id === "brand",
    );
    expect(row?.sourceTypeId).toBe("wave");
    expect(row?.individual).toBe(true);
  });

  it("orders children by sort order and names a path root to leaf", () => {
    const schema = starterSchema();
    expect(childrenOf(schema, "windsurf").map((t) => t.id)).toEqual([
      "sails",
      "boards",
    ]);
    expect(pathOf(schema, "wave")).toEqual([
      "All products",
      "Windsurf",
      "Sails",
      "Wave sails",
    ]);
  });

  it("survives a cycle without looping", () => {
    const schema = starterSchema();
    const all = schema.types.find((t) => t.id === "all");
    if (all) all.parentId = "wave";
    expect(pathOf(schema, "wave").length).toBe(4);
    expect(activeAttributes(schema, "wave").length).toBeGreaterThan(0);
  });
});

describe("health", () => {
  it("is quiet for the starter schema", () => {
    const checks = schemaHealth(starterSchema());
    expect(checks.every((check) => check.count === 0)).toBe(true);
    expect(schemaMetrics(starterSchema())).toEqual({
      assignableTypes: 4,
      categories: 5,
      attributes: 10,
      sets: 4,
    });
  });

  it("counts what a person has to fix, worded for the count", () => {
    const schema = starterSchema();
    schema.types.push({
      id: "bare",
      name: "Bare",
      parentId: null,
      leaf: true,
      sortOrder: 9,
      shopifyCategory: "",
      archetype: "",
    });
    schema.attributes.push({
      id: "loose",
      name: "Loose",
      setId: null,
      dataType: "single_select",
      unit: "",
      description: "",
      scope: "product",
      key: "bad key",
      implementation: "custom",
      requiredDefault: false,
      filterable: false,
      searchable: false,
      comparable: false,
      valueListId: null,
    });
    const byId = new Map(schemaHealth(schema).map((c) => [c.id, c]));
    expect(byId.get("empty-types")?.message).toBe(
      "1 product type has no attributes",
    );
    expect(byId.get("unused-attributes")?.message).toBe(
      "1 attribute is not used by any type",
    );
    expect(byId.get("select-without-options")?.message).toBe(
      "1 select attribute needs options",
    );
    expect(byId.get("field-keys")?.message).toBe(
      "1 malformed and 0 duplicate Shopify field key",
    );
    expect(byId.get("integrity")?.count).toBe(0);
  });
});
