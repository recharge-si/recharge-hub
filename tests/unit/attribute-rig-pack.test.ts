import { describe, expect, it } from "vitest";

import { coverage, type CoverageProduct } from "~/domain/attributes/coverage";
import {
  RIG_ATTRIBUTES,
  mergeRigPack,
  rangeOrdering,
  rangePairs,
  rigPack,
} from "~/domain/attributes/rig-pack";
import { schemaHealth } from "~/domain/attributes/resolve";
import {
  parseAttributeSchema,
  schemaProblems,
} from "~/domain/attributes/schema";
import { starterSchema } from "~/domain/attributes/starter";
import { emptySchema } from "~/domain/attributes/types";

function health(schema: ReturnType<typeof rigPack>) {
  return Object.fromEntries(schemaHealth(schema).map((c) => [c.id, c.count]));
}

describe("rigPack", () => {
  it("is a valid plan on its own", () => {
    const pack = rigPack();
    expect(schemaProblems(pack)).toEqual([]);
    expect(parseAttributeSchema(pack).ok).toBe(true);
    expect(health(pack)).toMatchObject({
      "unmapped-attributes": 0,
      "select-without-options": 0,
      "field-keys": 0,
      "empty-types": 0,
      "unused-attributes": 0,
      integrity: 0,
    });
  });

  it("merges into the starter with no problems and no gaps", () => {
    const merged = mergeRigPack(starterSchema());
    expect(schemaProblems(merged.schema)).toEqual([]);
    expect(parseAttributeSchema(merged.schema).ok).toBe(true);
    expect(health(merged.schema)).toMatchObject({
      "unmapped-attributes": 0,
      "select-without-options": 0,
      "field-keys": 0,
      integrity: 0,
    });
  });

  it("defines the assignable types of a windsurf rig", () => {
    const names = rigPack()
      .types.filter((t) => t.leaf)
      .map((t) => t.name);
    expect(names).toEqual([
      "Boards",
      "Sails",
      "Masts",
      "Booms",
      "Bases and extensions",
      "Fins",
      "Harnesses",
    ]);
  });

  it("uses exactly the keys the rig engine reads, in the recharge namespace", () => {
    const keys = rigPack().attributes.map((a) => a.key);
    for (const key of [
      "sail_area_m2",
      "sail_luff_cm",
      "sail_mast_rdm",
      "sail_mast_length_min_cm",
      "sail_mast_length_max_cm",
      "sail_boom_min_cm",
      "sail_boom_max_cm",
      "sail_wind_min_kn",
      "sail_wind_max_kn",
      "sail_category",
      "mast_length_cm",
      "mast_rdm",
      "mast_imcs",
      "mast_carbon_percent",
      "mast_base_type",
      "board_volume_l",
      "board_width_cm",
      "board_length_cm",
      "board_fin_box",
      "board_max_sail_m2",
      "board_min_sail_m2",
      "boom_min_cm",
      "boom_max_cm",
      "fin_box",
      "fin_length_cm",
      "extension_length_cm",
      "base_type",
      "rider_weight_min_kg",
      "rider_weight_max_kg",
      "skill_level",
    ])
      expect(keys).toContain(`recharge.${key}`);
    expect(RIG_ATTRIBUTES).toHaveLength(keys.length);
  });

  it("types the machine-readable values", () => {
    const by = Object.fromEntries(rigPack().attributes.map((a) => [a.key, a]));
    expect(by["recharge.sail_area_m2"]).toMatchObject({ dataType: "decimal" });
    expect(by["recharge.sail_luff_cm"]).toMatchObject({ dataType: "integer" });
    expect(by["recharge.mast_imcs"]).toMatchObject({ dataType: "integer" });
    const options = (key: string) => {
      const list = rigPack().valueLists.find(
        (l) => l.id === by[key]?.valueListId,
      );
      return list?.items.map((i) => i.code);
    };
    expect(options("recharge.sail_category")).toEqual([
      "wave",
      "freeride",
      "freerace",
      "slalom",
      "freestyle",
      "race",
    ]);
    expect(options("recharge.board_fin_box")).toEqual([
      "tuttle",
      "deep_tuttle",
      "powerbox",
      "us_box",
      "slot_box",
      "foil",
    ]);
    expect(options("recharge.skill_level")).toEqual([
      "beginner",
      "intermediate",
      "advanced",
    ]);
  });

  it("adds once: merging again changes nothing and says so", () => {
    const first = mergeRigPack(emptySchema());
    expect(first.changed).toBe(true);
    expect(first.added.attributes).toBe(RIG_ATTRIBUTES.length);
    const second = mergeRigPack(first.schema);
    expect(second.changed).toBe(false);
    expect(second.schema).toEqual(first.schema);
    expect(second.added).toEqual({ types: 0, sets: 0, attributes: 0 });
  });

  it("reports a name collision instead of duplicating, and extends the starter's skill options", () => {
    const merged = mergeRigPack(starterSchema());
    expect(merged.skipped.map((s) => s.name)).toContain("Skill level");
    expect(merged.extended).toEqual([
      { name: "Skill level", codes: ["intermediate"] },
    ]);
    const names = merged.schema.attributes.map((a) => a.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    // The pack's types reuse the starter's Sails and Boards instead of adding twins.
    expect(merged.schema.types.filter((t) => t.name === "Sails")).toHaveLength(
      1,
    );
  });

  it("does not mutate the plan it was given", () => {
    const base = starterSchema();
    const copy = structuredClone(base);
    mergeRigPack(base);
    expect(base).toEqual(copy);
  });
});

describe("rangeOrdering", () => {
  const plan = rigPack();
  it("finds the pairs of minimum and maximum fields", () => {
    const pairs = rangePairs(plan).map((p) => p.min);
    expect(pairs).toEqual(
      expect.arrayContaining([
        "sail_boom_min_cm",
        "boom_min_cm",
        "board_min_sail_m2",
        "rider_weight_min_kg",
        "sail_wind_min_kn",
      ]),
    );
  });
  it("names both fields and both values", () => {
    expect(
      rangeOrdering(plan, { sail_boom_min_cm: 180, sail_boom_max_cm: 160 }),
    ).toEqual([
      "sail_boom_min_cm (180) is greater than sail_boom_max_cm (160).",
    ]);
  });
  it("accepts equal values and half a pair", () => {
    expect(rangeOrdering(plan, { boom_min_cm: 160, boom_max_cm: 160 })).toEqual(
      [],
    );
    expect(rangeOrdering(plan, { boom_min_cm: 300 })).toEqual([]);
  });
});

describe("coverage", () => {
  const plan = rigPack();
  const required = plan.attributes
    .filter((a) => a.requiredDefault)
    .map((a) => a.key);

  function sails(): CoverageProduct[] {
    const typeId = plan.types.find((t) => t.name === "Sails")?.id ?? "";
    const sailKeys = (
      [
        "sail_area_m2",
        "sail_mast_rdm",
        "sail_mast_length_min_cm",
        "sail_mast_length_max_cm",
        "sail_boom_min_cm",
        "sail_boom_max_cm",
        "sail_category",
      ] as const
    ).map((k) => `recharge.${k}`);
    return Array.from({ length: 20 }, (_, i) => ({
      productId: `gid://shopify/Product/${i}`,
      typeId,
      filled:
        i < 12
          ? sailKeys
          : sailKeys.filter((k) => k !== "recharge.sail_boom_max_cm"),
    }));
  }

  it("counts 20 sails, 12 complete, 8 missing the boom maximum", () => {
    expect(required).toContain("recharge.sail_boom_max_cm");
    const result = coverage(plan, sails()).find((c) => c.type === "sails");
    expect(result).toMatchObject({
      products: 20,
      withAllRequired: 12,
      missing: { sail_boom_max_cm: 8 },
    });
    expect(result?.incomplete).toHaveLength(8);
  });

  it("counts a product under a nested type and ignores other types", () => {
    const wave = {
      ...emptySchema(),
      ...mergeRigPack(starterSchema()).schema,
    };
    const waveId = wave.types.find((t) => t.name === "Wave sails")?.id ?? "";
    const boardsId = wave.types.find((t) => t.name === "Wave boards")?.id ?? "";
    const result = coverage(wave, [
      { productId: "a", typeId: waveId, filled: [] },
      { productId: "b", typeId: boardsId, filled: [] },
      { productId: "c", typeId: null, filled: [] },
    ]);
    expect(result.find((c) => c.type === "sails")?.products).toBe(1);
    expect(result.find((c) => c.type === "boards")?.products).toBe(1);
    expect(result.find((c) => c.type === "masts")?.products).toBe(0);
  });

  it("omits rig types the plan does not have", () => {
    expect(coverage(emptySchema(), [])).toEqual([]);
  });
});
