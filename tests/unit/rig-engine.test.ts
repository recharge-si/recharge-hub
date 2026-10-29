import { describe, expect, it } from "vitest";

import { classifyProduct, rigReadiness } from "~/domain/rig/candidates";
import {
  buildRig,
  checkReport,
  checkRig,
  resolveFit,
} from "~/domain/rig/engine";
import type { RigRole, Specs } from "~/domain/rig/keys";
import type { Answers } from "~/domain/rig/profile";
import type { RigCandidate } from "~/domain/rig/types";
import {
  REFERENCE,
  SHOP_A,
  candidates,
  loadCatalogue,
  profileOf,
  rigPlan,
  rules,
  without,
} from "../support/rig-fixtures";

/*
 * The fixture catalogue (tests/fixtures/rig/catalogue.json) holds the shapes
 * the store really stores: number_decimal text, dimension / weight / volume
 * JSON with units, list JSON arrays, a Size option that carries the mast
 * length, the sail area ("5.8 m2 / Orange") or the fin length in mm.
 *
 * The rules table R1 is a PLACEHOLDER (src/domain/rig/rules.ts); the numbers
 * pinned here are the two the PRD fixes (sail 5.3-6.2 m2, board 95-115 L for
 * the reference buyer) and the fixture catalogue own.
 */

const ctx = { shopId: SHOP_A };
const build = (
  answers: Answers = REFERENCE,
  pool: RigCandidate[] = candidates(),
) => buildRig(profileOf(answers), pool, rules, ctx);

function item(result: ReturnType<typeof build>, role: RigRole) {
  return result.rigs[0]?.items.find((entry) => entry.role === role);
}

const num = (value: unknown) => (typeof value === "number" ? value : NaN);
const byTitle = (title: string, pool = candidates()) =>
  pool.find((c) => c.title === title);
const context = () => resolveFit(profileOf(), rules).context;

/** A part with exactly these specs, for rule tests that need no catalogue. */
function part(role: RigRole, specs: Specs): RigCandidate {
  return {
    role,
    shopId: SHOP_A,
    productId: `gid://shopify/Product/${role}`,
    variantGid: `gid://shopify/ProductVariant/${role}`,
    variantId: 1,
    status: "ACTIVE",
    title: role,
    variantTitle: null,
    handle: null,
    imageUrl: null,
    priceMinor: 100,
    currency: "EUR",
    inStock: true,
    inventoryQuantity: 1,
    specs,
    derived: [],
    category: null,
    missing: [],
  };
}

describe("buildRig: the reference buyer", () => {
  const result = build();

  it("returns one complete rig with every check passing and nothing unchecked", () => {
    expect(result.needs).toEqual([]);
    expect(result.unmet).toEqual([]);
    expect(result.rigs).toHaveLength(1);
    expect(result.rigs[0]?.items.map((entry) => entry.role)).toEqual([
      "sail",
      "mast",
      "base",
      "boom",
      "board",
      "fin",
    ]);
    expect(result.checks.map((check) => check.id)).toEqual([
      "sail-fit",
      "board-fit",
      "board-sail-range",
      "rider-fit",
      "sail-mast-diameter",
      "sail-mast-length",
      "mast-boom-diameter",
      "sail-boom-range",
      "fin-box",
      "fin-length",
    ]);
    expect(result.checks.every((check) => check.ok)).toBe(true);
    expect(result.unchecked).toEqual([]);
    expect(result.rigs[0]?.unchecked).toEqual([]);
    expect(result.rigs[0]?.label).toBe("Recommended");
  });

  it("picks the stocked freeride sail closest to the middle of the band, 5.75", () => {
    expect(item(result, "sail")?.title).toBe("Aero Ride");
    expect(item(result, "sail")?.variantTitle).toBe("5.8 m2 / Orange");
    expect(num(item(result, "sail")?.specs.areaM2)).toBe(5.8);
  });

  it("prefers the sail that states more when two are equally close (5.7 derived vs 5.8)", () => {
    const dacron = byTitle("XO Sails - Experience TR Dacron Sail Only");
    expect(dacron).toBeDefined();
    expect(item(result, "sail")?.title).not.toBe(dacron?.title);
  });

  it("picks a board within the volume band that takes the sail and has stock", () => {
    const board = item(result, "board");
    expect(board?.title).toBe("Free Board 105");
    expect(num(board?.specs.volumeL)).toBe(105);
    expect(num(board?.specs.sailMinM2)).toBeLessThanOrEqual(5.8);
    expect(num(board?.specs.sailMaxM2)).toBeGreaterThanOrEqual(5.8);
    expect(board?.available).toBe(true);
  });

  it("flags the facts it derived", () => {
    const mast = item(result, "mast");
    expect(mast?.title).toContain("HD RDM C75");
    expect(mast?.derived).toEqual(
      expect.arrayContaining(["lengthCm", "mastDiameter", "carbonPercent"]),
    );
    expect(item(result, "sail")?.derived).toEqual([]);
  });

  it("is byte-identical for the same input, whatever the order of candidates", () => {
    const again = build(REFERENCE, [...candidates()].reverse());
    expect(JSON.stringify(again)).toBe(JSON.stringify(result));
  });

  it("totals the parts and offers only alternatives that keep every check", () => {
    const rig = result.rigs[0];
    expect(rig?.totalMinor).toBe(
      rig?.items.reduce((sum, entry) => sum + entry.priceMinor, 0),
    );
    expect(rig?.alternatives.length).toBeGreaterThan(0);
    expect(rig?.currency).toBe("EUR");
    const pool = candidates();
    for (const alternative of rig?.alternatives ?? []) {
      const found = pool.find((c) => c.variantId === alternative.variantId);
      if (alternative.role === "sail" || alternative.role === "board") {
        // A wave or foil part is not an alternative for a freeride rider.
        expect(["freeride", "beginner", null]).toContain(found?.category);
      }
    }
  });

  it("says that stock was not read for a part that has no quantity", () => {
    expect(result.warnings.map((w) => w.code)).toContain("stock_not_read");
    const stockless = byTitle("Stockless Sail");
    expect(stockless?.inStock).toBe(false);
    expect(stockless?.inventoryQuantity).toBeNull();
    expect(
      result.rigs[0]?.items.some((i) => i.variantId === stockless?.variantId),
    ).toBe(false);
  });
});

describe("rules", () => {
  it("asks for the weight and nothing else", () => {
    const { weightKg: _weight, ...rest } = REFERENCE;
    const result = build(rest);
    expect(result.needs).toEqual(["weightKg"]);
    expect(result.rigs).toEqual([]);
  });

  it("says what it assumed when the buyer left something out", () => {
    const result = build({ discipline: "windsurf", weightKg: 82 });
    expect(result.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(["kind_assumed", "skill_assumed", "wind_assumed"]),
    );
    expect(result.rigs).toHaveLength(1);
  });

  it("has no sail rule for a category the table lacks", () => {
    const fit = resolveFit(
      { ...profileOf(), boardKind: null },
      { ...rules, defaultBoardKind: "freeride", sail: [] },
    );
    expect(fit.unmet).toContainEqual({ role: "sail", reason: "no_rule" });
  });

  it("builds a wave rig from wave sails and wave boards only", () => {
    const result = build({ ...REFERENCE, boardKind: "wave" });
    expect(result.unmet).toEqual([]);
    expect(item(result, "sail")?.title).toBe("Wave Blade");
    expect(item(result, "board")?.title).toBe("Wave Board 85");
    expect(item(result, "fin")?.title).toBe("US Box Fin 34");
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });

  it("keeps a foil or beginner part out of a freeride rig by its plan type", () => {
    const titles = new Set(
      (build().rigs[0]?.items ?? []).map((entry) => entry.title),
    );
    expect(titles.has("Foil Wing Sail")).toBe(false);
    expect(titles.has("Foil Board 110")).toBe(false);
    expect(titles.has("Beginner Board 140")).toBe(false);
  });
});

describe("strict: a rule without its data is unchecked, never passed or failed", () => {
  it("reports a sail with no mast, boom or diameter data as unchecked and names the keys", () => {
    const sail = byTitle("XO Sails - Experience TR Dacron Sail Only");
    const pool = candidates().filter(
      (c) => c.role !== "sail" || c.title === sail?.title,
    );
    const result = build(REFERENCE, pool);
    const rig = result.rigs[0];
    expect(item(result, "sail")?.title).toBe(sail?.title);
    expect(item(result, "sail")?.derived).toEqual(["areaM2"]);
    const ids = rig?.checks.map((check) => check.id) ?? [];
    for (const unchecked of [
      "sail-mast-diameter",
      "sail-mast-length",
      "sail-boom-range",
    ]) {
      expect(ids).not.toContain(unchecked);
      expect(rig?.unchecked.map((u) => u.id)).toContain(unchecked);
    }
    expect(rig?.unchecked.find((u) => u.id === "sail-boom-range")?.missing).toEqual([
      { role: "sail", key: "boom_min_cm" },
      { role: "sail", key: "boom_max_cm" },
    ]);
    expect(result.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining([
        "unchecked_sail_recommended_mast_diameter",
        "unchecked_sail_recommended_mast_cm",
        "unchecked_sail_boom_min_cm",
        "unchecked_sail_boom_max_cm",
      ]),
    );
    // What could be checked still is, and passes.
    expect(rig?.checks.every((check) => check.ok)).toBe(true);
  });

  it("does not let a missing value fail a check either", () => {
    const report = checkReport(
      { sail: part("sail", { areaM2: 5.8 }), boom: part("boom", { boomMinCm: 150, boomMaxCm: 190 }) },
      context(),
    );
    expect(report.checks.map((check) => check.id)).toEqual(["sail-fit"]);
    expect(report.unchecked).toEqual([
      {
        id: "sail-boom-range",
        missing: [
          { role: "sail", key: "boom_min_cm" },
          { role: "sail", key: "boom_max_cm" },
        ],
      },
    ]);
  });

  it("names the part that lacks the data, on either side of a rule", () => {
    const report = checkReport(
      {
        sail: part("sail", { areaM2: 5.8, mastCm: 460, mastDiameter: "rdm" }),
        mast: part("mast", {}),
      },
      context(),
    );
    expect(report.checks.map((check) => check.id)).not.toContain("sail-mast-length");
    expect(report.unchecked).toEqual([
      { id: "sail-mast-diameter", missing: [{ role: "mast", key: "mast_diameter" }] },
      { id: "sail-mast-length", missing: [{ role: "mast", key: "length_cm" }] },
    ]);
  });

  it("checks the board against the rider only when the board states the riders it takes", () => {
    const heavy = resolveFit(profileOf({ ...REFERENCE, weightKg: 110 }), rules).context;
    const stated = checkRig({ board: part("board", { volumeL: 130, riderMinKg: 70, riderMaxKg: 95 }) }, heavy);
    expect(stated.find((c) => c.id === "rider-fit")?.ok).toBe(false);
    const silent = checkRig({ board: part("board", { volumeL: 130 }) }, heavy);
    expect(silent.find((c) => c.id === "rider-fit")).toBeUndefined();
  });

  it("leaves board fit unchecked for a board with a sail range but no volume", () => {
    const board = part("board", { sailMinM2: 5, sailMaxM2: 6.5, finBoxTypes: ["tuttle"] });
    const report = checkReport({ board, sail: part("sail", { areaM2: 5.8 }) }, context());
    expect(report.unchecked).toContainEqual({
      id: "board-fit",
      missing: [{ role: "board", key: "volume_l" }],
    });
    expect(report.checks.find((c) => c.id === "board-sail-range")?.ok).toBe(true);
  });

  it("can still build with a board that has only a sail range, saying board fit is unchecked", () => {
    const pool = candidates().filter(
      (c) => c.role !== "board" || c.title === "Range Only Board",
    );
    const result = build(REFERENCE, pool);
    expect(item(result, "board")?.title).toBe("Range Only Board");
    expect(result.rigs[0]?.unchecked.map((u) => u.id)).toContain("board-fit");
    expect(result.warnings.map((w) => w.code)).toContain("unchecked_board_volume_l");
    expect(result.checks.find((c) => c.id === "board-fit")).toBeUndefined();
  });
});

describe("mast", () => {
  const sail = () =>
    candidates().find((c) => c.title === "Aero Ride" && c.specs.areaM2 === 5.8);
  const hd = (cm: number) =>
    candidates().find(
      (c) => c.title.includes("HD RDM") && c.specs.lengthCm === cm,
    );

  it("matches the diameter and the length the sail recommends", () => {
    const fits = checkRig({ sail: sail(), mast: hd(460) }, context());
    expect(fits.find((c) => c.id === "sail-mast-diameter")?.ok).toBe(true);
    expect(fits.find((c) => c.id === "sail-mast-length")?.ok).toBe(true);

    const short = checkRig({ sail: sail(), mast: hd(430) }, context());
    expect(short.find((c) => c.id === "sail-mast-length")?.ok).toBe(false);

    const sdm = byTitle("Unifiber - Elite SDM C100 Constant FL Curve Incl. Mastbag");
    const wrong = checkRig({ sail: sail(), mast: sdm }, context());
    expect(wrong.find((c) => c.id === "sail-mast-diameter")?.ok).toBe(false);
  });

  it("takes the sail list of compatible diameters as well as its recommended one", () => {
    const mastSdm = part("mast", { lengthCm: 460, mastDiameter: "sdm" });
    const both = part("sail", { areaM2: 5.8, mastCm: 460, mastDiameter: "rdm", compatibleDiameters: ["rdm", "sdm"] });
    expect(checkRig({ sail: both, mast: mastSdm }, context()).find((c) => c.id === "sail-mast-diameter")?.ok).toBe(true);
    const rdmOnly = part("sail", { areaM2: 5.8, mastCm: 460, mastDiameter: "rdm" });
    expect(checkRig({ sail: rdmOnly, mast: mastSdm }, context()).find((c) => c.id === "sail-mast-diameter")?.ok).toBe(false);
  });

  it("compares IMCS only when both sides state it", () => {
    const sail = part("sail", { areaM2: 5.8, mastImcs: 21 });
    const find = (mastImcs?: number) =>
      checkRig(
        { sail, mast: part("mast", { lengthCm: 460, mastDiameter: "rdm", ...(mastImcs ? { mastImcs } : {}) }) },
        context(),
      ).find((c) => c.id === "sail-mast-imcs");
    expect(find(21)?.ok).toBe(true);
    expect(find(25)?.ok).toBe(false);
    expect(find()).toBeUndefined();
  });

  it("stretches a short mast with an extension range, and fails one that still falls short", () => {
    const ext = byTitle("Unifiber Extension RDM 25");
    const ok = checkRig({ sail: sail(), mast: hd(430), extension: ext }, context());
    expect(ok.find((c) => c.id === "sail-mast-length")?.ok).toBe(true);
    expect(ok.find((c) => c.id === "mast-extension-diameter")?.ok).toBe(true);
    const still = checkRig({ sail: sail(), mast: hd(400), extension: ext }, context());
    expect(still.find((c) => c.id === "sail-mast-length")?.ok).toBe(false);
    const sdmExt = byTitle("Unifiber Extension SDM 25");
    const wrong = checkRig({ sail: sail(), mast: hd(430), extension: sdmExt }, context());
    expect(wrong.find((c) => c.id === "mast-extension-diameter")?.ok).toBe(false);
  });

  it("leaves the length unchecked when the extension states no range", () => {
    const ext = part("extension", { mastDiameter: "rdm" });
    const report = checkReport({ sail: sail(), mast: hd(430), extension: ext }, context());
    expect(report.checks.map((c) => c.id)).not.toContain("sail-mast-length");
    expect(report.unchecked.find((u) => u.id === "sail-mast-length")?.missing).toEqual([
      { role: "extension", key: "extension_min_cm" },
      { role: "extension", key: "extension_max_cm" },
    ]);
  });

  it("adds an extension to a shorter mast when no mast reaches the sail", () => {
    const pool = candidates().filter(
      (c) => !(c.title.includes("HD RDM") && c.specs.lengthCm === 460),
    );
    const result = build(REFERENCE, pool);
    expect(item(result, "mast")?.specs.lengthCm).toBe(430);
    expect(item(result, "extension")?.title).toBe("Unifiber Extension RDM 25");
    expect(result.checks.every((check) => check.ok)).toBe(true);
    // The extension fits the base by its connection, and the engine used that.
    expect(item(result, "base")?.title).toBe("Euro Pin Base");
    expect(result.checks.find((c) => c.id === "extension-base-connection")?.ok).toBe(true);
  });

  it("tries the next sail size when the best one has no mast that reaches it", () => {
    const pool = candidates().filter(
      (c) => !(c.role === "mast" && c.specs.mastDiameter === "rdm" && c.specs.lengthCm === 460) && c.role !== "extension",
    );
    const result = build(REFERENCE, pool);
    expect(result.unmet).toEqual([]);
    expect(result.checks.every((check) => check.ok)).toBe(true);
    expect(num(item(result, "sail")?.specs.areaM2)).not.toBe(5.8);
  });

  it("reports no mast when the catalogue holds none", () => {
    const pool = candidates(without(loadCatalogue(), (p) => p.productType === "Masts"));
    const result = build(REFERENCE, pool);
    expect(result.unmet).toContainEqual({ role: "mast", reason: "no_compatible_in_stock" });
    expect(item(result, "mast")).toBeUndefined();
  });

  it("leaves out a mast with no diameter or length, and counts the gaps by key", () => {
    const universal = byTitle("Universal Mast");
    expect(universal?.missing).toEqual(["length_cm", "mast_diameter"]);
    const result = build();
    expect(result.missingAttributes["length_cm"]).toBe(1);
    expect(result.missingAttributes["mast_diameter"]).toBe(1);
  });
});

describe("boom", () => {
  const part2 = (role: RigRole, specs: Specs) => part(role, specs);

  it("must cover the whole range the sail asks for", () => {
    const sail165 = part2("sail", { areaM2: 5.8, boomMinCm: 165, boomMaxCm: 175 });
    const sail160 = part2("sail", { areaM2: 5.8, boomMinCm: 160, boomMaxCm: 170 });
    const boom = (min: number, max: number) =>
      part2("boom", { boomMinCm: min, boomMaxCm: max });
    const ok = (sail: RigCandidate, b: RigCandidate) =>
      checkRig({ sail, boom: b }, context()).find((c) => c.id === "sail-boom-range")?.ok;
    expect(ok(sail165, boom(150, 190))).toBe(true);
    expect(ok(sail160, boom(170, 210))).toBe(false);
    expect(ok(sail165, boom(130, 170))).toBe(false);
  });

  it("falls back to the sail recommended boom length, which the boom must contain", () => {
    const sail = part2("sail", { areaM2: 5.8, recommendedBoomCm: 180 });
    const find = (min: number, max: number) =>
      checkRig({ sail, boom: part2("boom", { boomMinCm: min, boomMaxCm: max }) }, context()).find(
        (c) => c.id === "sail-boom-range",
      )?.ok;
    expect(find(150, 190)).toBe(true);
    expect(find(190, 230)).toBe(false);
  });

  it("is unchecked on the sail side when it has neither range nor recommendation, and on the boom side when it has no range", () => {
    const boom = part2("boom", { boomMinCm: 150 });
    const report = checkReport({ sail: part2("sail", { areaM2: 5.8 }), boom }, context());
    expect(report.unchecked[0]?.missing).toEqual([
      { role: "sail", key: "boom_min_cm" },
      { role: "sail", key: "boom_max_cm" },
      { role: "boom", key: "boom_max_cm" },
    ]);
  });

  it("checks the boom against the mast diameter only when the boom lists some", () => {
    const sail = part2("sail", { areaM2: 5.8, boomMinCm: 170, boomMaxCm: 190 });
    const mast = part2("mast", { lengthCm: 460, mastDiameter: "sdm" });
    const listed = checkRig({ sail, mast, boom: part2("boom", { boomMinCm: 150, boomMaxCm: 190, compatibleDiameters: ["rdm"] }) }, context());
    expect(listed.find((c) => c.id === "mast-boom-diameter")?.ok).toBe(false);
    const silent = checkRig({ sail, mast, boom: part2("boom", { boomMinCm: 150, boomMaxCm: 190 }) }, context());
    expect(silent.find((c) => c.id === "mast-boom-diameter")).toBeUndefined();
  });

  it("never picks a boom that fails the mast, and leaves out a boom without a range", () => {
    const result = build();
    expect(item(result, "boom")?.title).toBe("Boom 150-190");
    expect(result.missingAttributes["boom_min_cm"]).toBe(1);
    const noRange = candidates().find((c) => c.title === "Boom no range");
    expect(noRange?.missing).toEqual(["boom_min_cm", "boom_max_cm"]);
  });
});

describe("base", () => {
  it("takes a base the extension connects to, not a tendon or a no-data one", () => {
    const ext = byTitle("Unifiber Extension RDM 25");
    const euro = byTitle("Euro Pin Base");
    const tendon = byTitle("Tendon Base");
    const none = byTitle("Base no data");
    const check = (base: RigCandidate | undefined) =>
      checkReport({ extension: ext, base }, context());
    expect(check(euro).checks.find((c) => c.id === "extension-base-connection")?.ok).toBe(true);
    expect(check(tendon).checks.find((c) => c.id === "extension-base-connection")?.ok).toBe(false);
    expect(check(none).unchecked).toEqual([
      { id: "extension-base-connection", missing: [{ role: "base", key: "base_connection" }] },
    ]);
  });

  it("reports no compatible base when none is in stock", () => {
    const products = loadCatalogue().map((p) =>
      p.productType === "Mast bases"
        ? { ...p, variants: p.variants.map((v) => ({ ...v, inventoryQuantity: 0, availableForSale: false })) }
        : p,
    );
    const result = build(REFERENCE, candidates(products));
    expect(result.unmet).toContainEqual({ role: "base", reason: "no_compatible_in_stock" });
    expect(item(result, "base")).toBeUndefined();
    expect(item(result, "mast")).toBeDefined();
  });
});

describe("fin", () => {
  it("fits one of the fin boxes the board lists", () => {
    const result = build();
    const board = item(result, "board");
    const fin = item(result, "fin");
    expect(board?.specs.finBoxTypes).toContain(fin?.specs.finBox);
  });

  it("never offers a Power Box fin for a Tuttle board", () => {
    const board = byTitle("Free Board 105");
    const fin = byTitle("Power Fin 36");
    const checks = checkRig({ board, fin }, context());
    expect(checks.find((c) => c.id === "fin-box")?.ok).toBe(false);
    for (const alternative of build().rigs[0]?.alternatives ?? []) {
      if (alternative.role === "fin") {
        expect(alternative.title).not.toBe("Power Fin 36");
      }
    }
  });

  it("uses the board own fin range, and the fin length derived from millimetres", () => {
    const board = byTitle("Free Board 105");
    const patrik = candidates().filter((c) => c.title === "Patrik FIN P-RIDE (TUTTLE)");
    expect(patrik.map((c) => c.specs.finLengthCm)).toEqual([44, 46, 48]);
    expect(patrik.every((c) => c.derived.includes("finLengthCm"))).toBe(true);
    // Free Board 105 takes 32 to 40 cm: 44 does not fit.
    const checks = checkRig({ board, fin: patrik[0] }, context());
    expect(checks.find((c) => c.id === "fin-length")?.ok).toBe(false);
    expect(checks.find((c) => c.id === "fin-box")?.ok).toBe(true);
  });

  it("falls back to the placeholder length table by volume, then to unchecked", () => {
    const fin = part("fin", { finBox: "tuttle", finLengthCm: 36 });
    const withVolume = part("board", { volumeL: 105, finBoxTypes: ["tuttle"] });
    expect(checkRig({ board: withVolume, fin }, context()).find((c) => c.id === "fin-length")?.ok).toBe(true);
    const bare = part("board", { sailMinM2: 5, sailMaxM2: 6, finBoxTypes: ["tuttle"] });
    const report = checkReport({ board: bare, fin }, context());
    expect(report.checks.map((c) => c.id)).not.toContain("fin-length");
    expect(report.unchecked.find((u) => u.id === "fin-length")?.missing).toEqual([
      { role: "board", key: "board_fin_min_cm" },
      { role: "board", key: "board_fin_max_cm" },
    ]);
  });

  it("leaves a fin without a length unchecked for length", () => {
    const fin = part("fin", { finBox: "tuttle" });
    const board = part("board", { volumeL: 105, finBoxTypes: ["tuttle"] });
    const report = checkReport({ board, fin }, context());
    expect(report.unchecked).toContainEqual({
      id: "fin-length",
      missing: [{ role: "fin", key: "length_cm" }],
    });
  });

  it("leaves a fin or a board with no box data out of the pool", () => {
    expect(byTitle("Fin no box")?.missing).toEqual(["fin_box"]);
    expect(byTitle("Board no fin boxes")?.missing).toEqual(["fin_box_types"]);
  });
});

describe("rider fit", () => {
  it("does not choose a board that states it is too light for the rider", () => {
    const result = build({ ...REFERENCE, weightKg: 100 });
    expect(item(result, "board")?.title).not.toBe("Free Board 105");
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });
});

describe("owned gear", () => {
  it("leaves an owned boom out and says it was not checked without its range", () => {
    const result = build({ ...REFERENCE, owns: ["boom"] });
    expect(item(result, "boom")).toBeUndefined();
    expect(result.warnings.map((w) => w.code)).toContain("owned_boom_unchecked");
    expect(result.checks.find((c) => c.id === "owned-boom")).toBeUndefined();
    expect(result.rigs[0]?.items).toHaveLength(5);
  });

  it("checks an owned boom whose range the buyer gave", () => {
    const fits = build({ ...REFERENCE, owns: ["boom"], ownedBoomMinCm: 150, ownedBoomMaxCm: 190 });
    expect(fits.checks.find((c) => c.id === "owned-boom")).toEqual({ id: "owned-boom", ok: true });
    const tooShort = build({ ...REFERENCE, owns: ["boom"], ownedBoomMinCm: 130, ownedBoomMaxCm: 170 });
    expect(tooShort.checks.find((c) => c.id === "owned-boom")?.ok).toBe(false);
    expect(tooShort.warnings.map((w) => w.code)).not.toContain("owned_boom_unchecked");
  });

  it("does not claim checks about gear it does not know", () => {
    const result = build({ ...REFERENCE, owns: ["board"] });
    expect(item(result, "board")).toBeUndefined();
    expect(result.checks.map((c) => c.id)).not.toContain("board-fit");
    expect(result.warnings.map((w) => w.code)).toContain("owned_board_unchecked");
  });
});

describe("budget", () => {
  const recommended = build();
  const cheapest = build({ ...REFERENCE, budgetEur: 1 });

  it("keeps the recommended rig when it fits the budget", () => {
    const result = build({ ...REFERENCE, budgetEur: 3500 });
    expect(result.unmet.find((u) => u.role === "budget")).toBeUndefined();
    expect(result.rigs[0]?.totalMinor).toBe(recommended.rigs[0]?.totalMinor);
    expect(result.rigs[0]?.totalMinor).toBeLessThanOrEqual(350000);
  });

  it("falls back to the cheapest compatible rig that fits", () => {
    const cheapTotal = cheapest.rigs[0]?.totalMinor ?? 0;
    expect(cheapTotal).toBeLessThan(recommended.rigs[0]?.totalMinor ?? 0);
    const result = build({ ...REFERENCE, budgetEur: cheapTotal / 100 });
    expect(result.rigs[0]?.label).toBe("Lowest price");
    expect(result.rigs[0]?.totalMinor).toBe(cheapTotal);
    expect(result.unmet.find((u) => u.role === "budget")).toBeUndefined();
  });

  it("returns the cheapest rig with the amount over when nothing fits", () => {
    const result = build({ ...REFERENCE, budgetEur: 1 });
    const over = (cheapest.rigs[0]?.totalMinor ?? 0) - 100;
    expect(result.unmet).toContainEqual({ role: "budget", reason: "over_budget", overMinor: over });
    expect(result.warnings).toContainEqual({ code: "over_budget", detail: { overMinor: over } });
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });
});

describe("stock, status and shop", () => {
  it("never puts a sold-out variant in the rig", () => {
    const pool = candidates();
    const soldOut = byTitle("Aero Ride Outlet", pool);
    expect(soldOut?.inStock).toBe(false);
    const result = build();
    const ids = new Set(result.rigs[0]?.items.map((entry) => entry.variantId));
    expect(ids.has(soldOut?.variantId ?? -1)).toBe(false);
    for (const alternative of result.rigs[0]?.alternatives ?? []) {
      expect(alternative.variantId).not.toBe(soldOut?.variantId);
    }
  });

  it("treats a null quantity as unknown, so not in stock, whatever availableForSale says", () => {
    const stockless = byTitle("Stockless Sail");
    expect(stockless?.inStock).toBe(false);
    const allNull = candidates(
      loadCatalogue().map((p) => ({
        ...p,
        variants: p.variants.map((v) => ({ ...v, inventoryQuantity: null, availableForSale: true })),
      })),
    );
    const result = build(REFERENCE, allNull);
    expect(result.rigs).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toContain("stock_not_read");
    expect(result.unmet).toContainEqual({ role: "sail", reason: "no_compatible_in_stock" });
  });

  it("moves to the next closest size when 5.8 is out, and then names what it could not check", () => {
    const products = loadCatalogue().map((p) =>
      p.title === "Aero Ride"
        ? {
            ...p,
            variants: p.variants.map((v) =>
              v.title === "5.8 m2 / Orange" ? { ...v, inventoryQuantity: 0, availableForSale: false } : v,
            ),
          }
        : p,
    );
    const result = build(REFERENCE, candidates(products));
    // 5.7 (a Dacron sail whose area is only in its option text) is next.
    expect(num(item(result, "sail")?.specs.areaM2)).toBe(5.7);
    expect(result.rigs[0]?.unchecked.length).toBeGreaterThan(0);
  });

  it("never chooses a draft product", () => {
    const draft = byTitle("Draft Board 105");
    expect(draft?.status).toBe("DRAFT");
    const result = build();
    expect(result.rigs[0]?.items.some((entry) => entry.variantId === draft?.variantId)).toBe(false);
  });

  it("never returns another shop's product, however cheap", () => {
    const result = build();
    const foreign = new Set(candidates().filter((c) => c.shopId !== SHOP_A).map((c) => c.variantId));
    expect(foreign.size).toBeGreaterThan(0);
    for (const entry of result.rigs[0]?.items ?? []) {
      expect(foreign.has(entry.variantId)).toBe(false);
    }
  });
});

describe("missing attributes", () => {
  it("never chooses a sail without an area and counts the gap", () => {
    const pool = candidates();
    const result = buildRig(profileOf(), pool, rules, ctx);
    expect(result.missingAttributes["canopy_area"]).toBe(1);
    const missingIds = new Set(pool.filter((c) => c.missing.length > 0).map((c) => c.variantId));
    for (const entry of result.rigs[0]?.items ?? []) {
      expect(missingIds.has(entry.variantId)).toBe(false);
    }
  });
});

describe("nothing in stock", () => {
  it("returns no rig and says which part is missing", () => {
    const pool = candidates().map((c) => ({ ...c, inStock: false }));
    const result = build(REFERENCE, pool);
    expect(result.rigs).toEqual([]);
    expect(result.unmet).toContainEqual({ role: "sail", reason: "no_compatible_in_stock" });
  });
});

describe("property: 200 generated profiles against the fixture catalogue", () => {
  // A small seeded generator, so the run is the same everywhere.
  function lcg(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }
  const random = lcg(20261028);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const pool = candidates();
  const byVariant = new Map(pool.map((c) => [c.variantId, c]));

  for (let index = 0; index < 200; index += 1) {
    const windMin = 5 + Math.floor(random() * 25);
    const answers: Answers = {
      discipline: "windsurf",
      weightKg: 40 + Math.floor(random() * 90),
      skill: pick(["beginner", "intermediate", "advanced"] as const),
      boardKind: pick(["freeride", "wave"] as const),
      windMinKn: windMin,
      windMaxKn: windMin + Math.floor(random() * 20),
      ...(random() < 0.4 ? { budgetEur: 500 + Math.floor(random() * 4000) } : {}),
      ...(random() < 0.3 ? { owns: [pick(["boom", "fin", "mast"] as const)] } : {}),
    };

    it(`profile ${index} gives only sound rigs`, () => {
      const result = buildRig(profileOf(answers), pool, rules, ctx);
      for (const rig of result.rigs) {
        // A rig passes all its own checks, unless it is the labelled partial one.
        if (result.unmet.every((u) => u.role === "budget")) {
          expect(rig.checks.every((check) => check.ok)).toBe(true);
        }
        // No check is both run and unchecked.
        const ran = new Set(rig.checks.map((check) => check.id));
        for (const unchecked of rig.unchecked) expect(ran.has(unchecked.id)).toBe(false);
        const ids = rig.items.map((entry) => entry.variantId);
        expect(new Set(ids).size).toBe(ids.length);
        for (const entry of rig.items) {
          const candidate = byVariant.get(entry.variantId);
          expect(candidate?.shopId).toBe(SHOP_A);
          expect(candidate?.status).toBe("ACTIVE");
          expect(candidate?.inStock).toBe(true);
          expect(candidate?.missing).toEqual([]);
        }
      }
    });
  }
});

describe("roles from the plan", () => {
  it("does not take a Wing board for a windsurf board", () => {
    expect(
      classifyProduct(rigPlan(), { productType: null, categoryName: null, chosenTypeId: "wing-boards" }),
    ).toBeNull();
    expect(
      classifyProduct(rigPlan(), { productType: "Freeride boards", categoryName: null, chosenTypeId: null }),
    ).toEqual({ role: "board", category: "freeride", combined: false });
    expect(
      classifyProduct(rigPlan(), { productType: "Masts", categoryName: null, chosenTypeId: null }),
    ).toEqual({ role: "mast", category: null, combined: false });
  });
});

describe("rigReadiness", () => {
  const shopA = () => loadCatalogue().filter((p) => p.shopId === SHOP_A);

  it("is ready on the fixture catalogue, with complete, in-stock and missing keys per role", () => {
    const readiness = rigReadiness(rigPlan(), shopA());
    expect(readiness.ready).toBe(true);
    expect(readiness.notReady).toEqual([]);
    expect(readiness.stockNotRead).toBe(false);
    // 8 active sail products: one has no area, one sold out, one with stock never read.
    expect(readiness.roles.sail).toMatchObject({
      products: 8,
      complete: 7,
      inStock: 5,
      stockUnknown: 1,
    });
    expect(readiness.roles.sail.missing).toEqual([{ key: "canopy_area", count: 1 }]);
    expect(readiness.roles.sail.derived).toEqual({ areaM2: 3 });
    // Masts: the one with no diameter or length is incomplete; the others derive both.
    expect(readiness.roles.mast).toMatchObject({ products: 5, complete: 4 });
    expect(readiness.roles.mast.missing).toEqual([
      { key: "length_cm", count: 1 },
      { key: "mast_diameter", count: 1 },
    ]);
    expect(readiness.roles.mast.derived.mastDiameter).toBe(3);
    // The draft board is not counted.
    expect(readiness.roles.board.products).toBe(11);
    expect(readiness.roles.board.missing).toEqual([{ key: "fin_box_types", count: 1 }]);
    expect(readiness.roles.fin.missing).toEqual([{ key: "fin_box", count: 1 }]);
  });

  it("is not ready with two complete masts, and names mast", () => {
    let masts = 0;
    const products = shopA().filter((p) => {
      if (p.productType !== "Masts") return true;
      masts += 1;
      return masts <= 2;
    });
    const readiness = rigReadiness(rigPlan(), products);
    expect(readiness.ready).toBe(false);
    expect(readiness.notReady).toEqual(["mast"]);
    expect(readiness.roles.mast.inStock).toBe(2);
  });

  it("does not look empty when stock was never read: it says so", () => {
    const products = shopA().map((p) => ({
      ...p,
      variants: p.variants.map((v) => ({ ...v, inventoryQuantity: null })),
    }));
    const readiness = rigReadiness(rigPlan(), products);
    expect(readiness.stockNotRead).toBe(true);
    expect(readiness.ready).toBe(false);
    // The data counts are unchanged: the catalogue is complete, only stock is unknown.
    expect(readiness.roles.sail.complete).toBe(7);
    expect(readiness.roles.sail.inStock).toBe(0);
  });

  it("flags what it derived", () => {
    const pool = candidates();
    const dacron = pool.filter((c) => c.title.startsWith("XO Sails"));
    expect(dacron.map((c) => c.specs.areaM2)).toEqual([4, 5, 5.7]);
    expect(dacron.every((c) => c.derived.length === 1 && c.derived[0] === "areaM2")).toBe(true);
    const epoxy = byTitle("Unifiber - Mast Epoxy SDM", pool);
    expect(epoxy?.specs).toMatchObject({ lengthCm: 472, mastDiameter: "sdm" });
    expect(epoxy?.derived).toEqual(["lengthCm"]);
  });
});
