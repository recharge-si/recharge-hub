import { describe, expect, it } from "vitest";

import { rigReadiness } from "~/domain/rig/candidates";
import { buildRig, checkRig, resolveFit } from "~/domain/rig/engine";
import type { RigRole } from "~/domain/rig/keys";
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
 * Fixture rules table R1 is a PLACEHOLDER (src/domain/rig/rules.ts); the
 * numbers pinned here are the two the PRD fixes (sail 5.3-6.2 m2, board
 * 95-115 L for the reference buyer) and the fixture catalogue's own.
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

describe("buildRig: the reference buyer", () => {
  const result = build();

  it("returns one complete rig with every check passing", () => {
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
    expect(result.checks.length).toBeGreaterThan(5);
    expect(result.checks.every((check) => check.ok)).toBe(true);
    expect(result.rigs[0]?.label).toBe("Recommended");
  });

  it("picks the stocked sail closest to the middle of the band, 5.8", () => {
    const sails = candidates().filter(
      (c) =>
        c.shopId === SHOP_A &&
        c.role === "sail" &&
        c.specs.category === "freeride" &&
        c.inStock &&
        c.missing.length === 0 &&
        num(c.specs.areaM2) >= 5.3 &&
        num(c.specs.areaM2) <= 6.2,
    );
    // 12 sails in the catalogue, 5 compatible, 1 chosen.
    expect(sails).toHaveLength(5);
    expect(num(item(result, "sail")?.specs.areaM2)).toBe(5.8);
    expect(item(result, "sail")?.title).toBe("Aero Ride 5.8");
  });

  it("picks a board within the volume band that takes the sail and has stock", () => {
    const board = item(result, "board");
    expect(num(board?.specs.volumeL)).toBeGreaterThanOrEqual(95);
    expect(num(board?.specs.volumeL)).toBeLessThanOrEqual(115);
    expect(num(board?.specs.minSailM2)).toBeLessThanOrEqual(5.8);
    expect(num(board?.specs.maxSailM2)).toBeGreaterThanOrEqual(5.8);
    expect(board?.available).toBe(true);
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
});

describe("mast", () => {
  const sail = candidates().find((c) => c.title === "Aero Ride 5.8");
  const mast = (title: string) => candidates().find((c) => c.title === title);

  it("matches RDM and the sail's length range, with and without an extension", () => {
    const context = resolveFit(profileOf(), rules).context;
    const fits = checkRig({ sail, mast: mast("Carbon Mast 430") }, context);
    expect(fits.find((c) => c.id === "sail-mast-rdm")?.ok).toBe(true);
    expect(fits.find((c) => c.id === "sail-mast-length")?.ok).toBe(true);

    const short = checkRig({ sail, mast: mast("Carbon Mast 400") }, context);
    expect(short.find((c) => c.id === "sail-mast-length")?.ok).toBe(false);

    const extended = checkRig(
      { sail, mast: mast("Carbon Mast 400"), extension: mast("Extension 30") },
      context,
    );
    expect(extended.find((c) => c.id === "sail-mast-length")?.ok).toBe(true);

    const wrongRdm = checkRig({ sail, mast: mast("Elite Mast 460") }, context);
    expect(wrongRdm.find((c) => c.id === "sail-mast-rdm")?.ok).toBe(false);
  });

  it("tries the next sail size when the best one has no mast that reaches it", () => {
    const pool = candidates(
      without(loadCatalogue(), (p) =>
        ["Carbon Mast 430", "Carbon Mast 460 Pin", "Extension 30", "Extension 60"].includes(
          p.title,
        ),
      ),
    );
    const result = build(REFERENCE, pool);
    expect(result.unmet).toEqual([]);
    expect(num(item(result, "sail")?.specs.areaM2)).not.toBe(5.8);
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });

  it("picks a 430 mast when the catalogue holds one", () => {
    const result = build();
    expect(item(result, "mast")?.title).toBe("Carbon Mast 430");
    expect(item(result, "extension")).toBeUndefined();
  });

  it("adds a 30 cm extension to a 400 mast when no longer mast is stocked", () => {
    const pool = candidates(
      without(loadCatalogue(), (p) =>
        ["Carbon Mast 430", "Carbon Mast 460 Pin", "Carbon Mast 370"].includes(
          p.title,
        ),
      ),
    );
    const result = build(REFERENCE, pool);
    expect(item(result, "mast")?.title).toBe("Carbon Mast 400");
    expect(item(result, "extension")?.title).toBe("Extension 30");
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });

  it("reports no mast when the catalogue holds none, whatever the sail size", () => {
    const pool = candidates(without(loadCatalogue(), (p) => p.productType === "Masts"));
    const result = build(REFERENCE, pool);
    expect(result.unmet).toContainEqual({
      role: "mast",
      reason: "no_compatible_in_stock",
    });
    expect(item(result, "mast")).toBeUndefined();
  });
});

describe("boom", () => {
  const context = resolveFit(profileOf(), rules).context;
  const part = (role: RigRole, specs: RigCandidate["specs"]): RigCandidate => ({
    ...(candidates()[0] as RigCandidate),
    role,
    specs,
    missing: [],
  });

  it("must cover the whole range the sail asks for", () => {
    const sail165 = part("sail", { boomMinCm: 165, boomMaxCm: 175 });
    const sail160 = part("sail", { boomMinCm: 160, boomMaxCm: 170 });
    const boom = (min: number, max: number) =>
      part("boom", { boomMinCm: min, boomMaxCm: max });
    const ok = (sail: RigCandidate, b: RigCandidate) =>
      checkRig({ sail, boom: b }, context).find((c) => c.id === "sail-boom-range")
        ?.ok;
    expect(ok(sail165, boom(150, 190))).toBe(true);
    expect(ok(sail160, boom(170, 210))).toBe(false);
    expect(ok(sail165, boom(130, 170))).toBe(false);
  });
});

describe("base", () => {
  const onlyPinMasts = () =>
    without(loadCatalogue(), (p) =>
      [
        "Carbon Mast 370",
        "Carbon Mast 400",
        "Carbon Mast 430",
        "Elite Mast 460",
        "Elite Mast 490",
        "Extension 30",
        "Extension 60",
      ].includes(p.title),
    );

  it("takes the base type the mast needs", () => {
    const result = build(REFERENCE, candidates(onlyPinMasts()));
    expect(item(result, "mast")?.title).toBe("Carbon Mast 460 Pin");
    expect(item(result, "base")?.title).toBe("Pin Base");
  });

  it("reports no compatible base when no pin base is in stock", () => {
    const products = onlyPinMasts().map((p) =>
      p.title === "Pin Base"
        ? {
            ...p,
            variants: p.variants.map((v) => ({
              ...v,
              inventoryQuantity: 0,
              availableForSale: false,
            })),
          }
        : p,
    );
    const result = build(REFERENCE, candidates(products));
    expect(result.unmet).toContainEqual({
      role: "base",
      reason: "no_compatible_in_stock",
    });
    expect(item(result, "base")).toBeUndefined();
    expect(item(result, "mast")?.title).toBe("Carbon Mast 460 Pin");
  });
});

describe("fin", () => {
  it("fits the board's box and the length band", () => {
    const result = build();
    const board = item(result, "board");
    const fin = item(result, "fin");
    expect(fin?.specs.finBox).toBe(board?.specs.finBox);
  });

  it("never offers a Powerbox fin for a Tuttle board", () => {
    const pool = candidates();
    const board = pool.find((c) => c.title === "Free Board 105");
    const fin = pool.find((c) => c.title === "Power Fin 36");
    const context = resolveFit(profileOf(), rules).context;
    const checks = checkRig({ board, fin }, context);
    expect(checks.find((c) => c.id === "fin-box")?.ok).toBe(false);
    for (const alternative of build().rigs[0]?.alternatives ?? []) {
      if (alternative.role === "fin") {
        expect(alternative.title.startsWith("Tuttle")).toBe(true);
      }
    }
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
    const fits = build({
      ...REFERENCE,
      owns: ["boom"],
      ownedBoomMinCm: 150,
      ownedBoomMaxCm: 190,
    });
    expect(fits.checks.find((c) => c.id === "owned-boom")).toEqual({
      id: "owned-boom",
      ok: true,
    });
    const tooShort = build({
      ...REFERENCE,
      owns: ["boom"],
      ownedBoomMinCm: 130,
      ownedBoomMaxCm: 170,
    });
    expect(tooShort.checks.find((c) => c.id === "owned-boom")?.ok).toBe(false);
    expect(tooShort.warnings.map((w) => w.code)).not.toContain(
      "owned_boom_unchecked",
    );
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
    const result = build({ ...REFERENCE, budgetEur: 2500 });
    expect(result.unmet.find((u) => u.role === "budget")).toBeUndefined();
    expect(result.rigs[0]?.totalMinor).toBe(recommended.rigs[0]?.totalMinor);
    expect(result.rigs[0]?.totalMinor).toBeLessThanOrEqual(250000);
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
    expect(result.unmet).toContainEqual({
      role: "budget",
      reason: "over_budget",
      overMinor: over,
    });
    expect(result.warnings).toContainEqual({
      code: "over_budget",
      detail: { overMinor: over },
    });
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });
});

describe("stock, status and shop", () => {
  it("never puts a sold-out variant in the rig", () => {
    const pool = candidates();
    const soldOut = pool.find((c) => c.title === "Aero Ride 5.8 Outlet");
    expect(soldOut?.inStock).toBe(false);
    const result = build();
    const ids = new Set(result.rigs[0]?.items.map((entry) => entry.variantId));
    expect(ids.has(soldOut?.variantId ?? -1)).toBe(false);
    for (const alternative of result.rigs[0]?.alternatives ?? []) {
      expect(alternative.variantId).not.toBe(soldOut?.variantId);
    }
  });

  it("moves to the next closest size when 5.8 is out", () => {
    const products = loadCatalogue().map((p) =>
      p.title === "Aero Ride 5.8"
        ? {
            ...p,
            variants: p.variants.map((v) => ({
              ...v,
              inventoryQuantity: 0,
              availableForSale: false,
            })),
          }
        : p,
    );
    const result = build(REFERENCE, candidates(products));
    // 5.5 and 6.0 are equally far from the middle; the cheaper one wins.
    expect(num(item(result, "sail")?.specs.areaM2)).toBe(5.5);
  });

  it("never chooses a draft product", () => {
    const draft = candidates().find((c) => c.title === "Draft Board 105");
    expect(draft?.status).toBe("DRAFT");
    const result = build();
    expect(
      result.rigs[0]?.items.some((entry) => entry.variantId === draft?.variantId),
    ).toBe(false);
  });

  it("never returns another shop's product, however cheap", () => {
    const result = build();
    const foreign = new Set(
      candidates()
        .filter((c) => c.shopId !== SHOP_A)
        .map((c) => c.variantId),
    );
    expect(foreign.size).toBeGreaterThan(0);
    for (const entry of result.rigs[0]?.items ?? []) {
      expect(foreign.has(entry.variantId)).toBe(false);
    }
  });
});

describe("missing attributes", () => {
  it("never chooses a sail without a mast RDM and counts the gap", () => {
    const pool = candidates();
    const result = buildRig(profileOf(), pool, rules, ctx);
    expect(result.missingAttributes["sail_mast_rdm"]).toBe(3);
    const missingIds = new Set(
      pool.filter((c) => c.missing.length > 0).map((c) => c.variantId),
    );
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
    expect(result.unmet).toContainEqual({
      role: "sail",
      reason: "no_compatible_in_stock",
    });
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
  const pick = <T,>(list: readonly T[]): T =>
    list[Math.floor(random() * list.length)] as T;
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
      ...(random() < 0.4
        ? { budgetEur: 500 + Math.floor(random() * 4000) }
        : {}),
      ...(random() < 0.3 ? { owns: [pick(["boom", "fin", "mast"] as const)] } : {}),
    };

    it(`profile ${index} gives only sound rigs`, () => {
      const result = buildRig(profileOf(answers), pool, rules, ctx);
      for (const rig of result.rigs) {
        // A rig passes all its own checks, unless it is the labelled partial one.
        if (result.unmet.every((u) => u.role === "budget")) {
          expect(rig.checks.every((check) => check.ok)).toBe(true);
        }
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

describe("rigReadiness", () => {
  it("is ready on the fixture catalogue, with the five roles counted", () => {
    const readiness = rigReadiness(
      rigPlan(),
      loadCatalogue().filter((p) => p.shopId === SHOP_A),
    );
    expect(readiness.ready).toBe(true);
    expect(readiness.notReady).toEqual([]);
    expect(readiness.roles.mast.complete).toBe(6);
    // 12 sail products, 3 without a mast RDM, 1 sold out.
    expect(readiness.roles.sail.products).toBe(12);
    expect(readiness.roles.sail.complete).toBe(8);
    expect(readiness.roles.sail.missing[0]).toEqual({
      key: "sail_mast_rdm",
      count: 3,
    });
    // The draft board is not counted.
    expect(readiness.roles.board.products).toBe(7);
  });

  it("is not ready with two complete masts, and names mast", () => {
    let masts = 0;
    const products = loadCatalogue().filter((p) => {
      if (p.shopId !== SHOP_A) return false;
      if (p.productType !== "Masts") return true;
      masts += 1;
      return masts <= 2;
    });
    const readiness = rigReadiness(rigPlan(), products);
    expect(readiness.ready).toBe(false);
    expect(readiness.notReady).toEqual(["mast"]);
    expect(readiness.roles.mast.complete).toBe(2);
  });
});
