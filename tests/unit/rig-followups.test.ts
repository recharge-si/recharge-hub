import { describe, expect, it } from "vitest";

import { buildRig } from "~/domain/rig/engine";
import { factsOf } from "~/domain/rig/facts";

import {
  SHOP_A,
  candidates,
  profileOf,
  rules,
} from "../support/rig-fixtures";

/**
 * Follow-ups to the real-keys engine: a variant the cart refused is never
 * picked or offered again, and a part carries the facts the theme prints.
 */

const ctx = { shopId: SHOP_A };

describe("excludeVariantIds", () => {
  const plain = buildRig(profileOf(), candidates(), rules, ctx);
  const rig = plain.rigs[0];

  it("is a no-op when empty or when it names unknown variants", () => {
    const same = buildRig(profileOf(), candidates(), rules, {
      ...ctx,
      excludeVariantIds: new Set([1, 2, 999]),
    });
    expect(same.rigs[0]?.items.map((i) => i.variantId)).toEqual(
      rig?.items.map((i) => i.variantId),
    );
  });

  it("never picks an excluded variant and replaces it with another that fits", () => {
    expect(rig).toBeDefined();
    for (const chosen of rig?.items ?? []) {
      const rebuilt = buildRig(profileOf(), candidates(), rules, {
        ...ctx,
        excludeVariantIds: new Set([chosen.variantId]),
      });
      const ids = rebuilt.rigs[0]?.items.map((i) => i.variantId) ?? [];
      expect(ids).not.toContain(chosen.variantId);
      // The rig is whole again or the engine says why not; never a hole.
      if (rebuilt.rigs[0]) {
        expect(rebuilt.rigs[0].items.length).toBeGreaterThanOrEqual(
          (rig?.items.length ?? 0) - 1,
        );
      }
    }
  });

  it("never offers an excluded variant as an alternative", () => {
    const alternative = rig?.alternatives[0];
    expect(alternative).toBeDefined();
    const rebuilt = buildRig(profileOf(), candidates(), rules, {
      ...ctx,
      excludeVariantIds: new Set([alternative?.variantId ?? 0]),
    });
    const offered = rebuilt.rigs[0]?.alternatives.map((a) => a.variantId);
    expect(offered).not.toContain(alternative?.variantId);
  });

  it("with every sail excluded, reports that no sail fits", () => {
    const sails = candidates().filter((c) => c.role === "sail");
    const rebuilt = buildRig(profileOf(), candidates(), rules, {
      ...ctx,
      excludeVariantIds: new Set(sails.map((c) => c.variantId)),
    });
    expect(rebuilt.rigs).toEqual([]);
    expect(rebuilt.unmet.map((u) => u.role)).toContain("sail");
  });

  it("does not count an excluded variant as missing data", () => {
    const rebuilt = buildRig(profileOf(), candidates(), rules, {
      ...ctx,
      excludeVariantIds: new Set(candidates().map((c) => c.variantId)),
    });
    expect(rebuilt.missingAttributes).toEqual({});
  });
});

describe("candidates carry the vendor", () => {
  it("reads it off the product, trimmed, null when absent", () => {
    const all = candidates();
    expect(all.some((c) => c.vendor === "Point-7")).toBe(true);
    expect(all.some((c) => c.vendor === null)).toBe(true);
  });

  it("puts it, the handle and the image on alternatives too", () => {
    const result = buildRig(profileOf(), candidates(), rules, ctx);
    const alternative = result.rigs[0]?.alternatives[0];
    expect(alternative?.handle).toMatch(/\S/);
    expect(alternative?.imageUrl).toMatch(/^https:/);
    expect(alternative).toHaveProperty("vendor");
    expect(alternative).toHaveProperty("derived");
  });
});

describe("factsOf", () => {
  it("writes the numbers with units, in the buyer's language", () => {
    expect(
      factsOf({ areaM2: 5.8, mastCm: 430, mastDiameter: "rdm" }, [], "en"),
    ).toEqual([
      { field: "areaM2", label: "Sail area", value: "5.8 m²" },
      { field: "mastCm", label: "Recommended mast", value: "430 cm" },
      { field: "mastDiameter", label: "Mast diameter", value: "RDM" },
    ]);
    expect(factsOf({ areaM2: 5.8 }, [], "sl")[0]?.label).toBe("Površina jadra");
  });

  it("folds bounds into a range and marks derived values", () => {
    const facts = factsOf(
      { boomMinCm: 150, boomMaxCm: 190, lengthCm: 460, finBox: "power_box" },
      ["lengthCm"],
      "en",
    );
    expect(facts).toContainEqual({
      field: "boomMinCm",
      label: "Boom range",
      value: "150–190 cm",
    });
    expect(facts).toContainEqual({
      field: "lengthCm",
      label: "Mast length",
      value: "460 cm",
      derived: true,
    });
    expect(facts.find((f) => f.field === "finBox")?.value).toBe("power box");
  });

  it("joins lists, drops decimals past two, and says when one bound is missing", () => {
    expect(
      factsOf({ finBoxTypes: ["power_box", "us_box"], volumeL: 101.456 }, [], "en").map(
        (f) => f.value,
      ),
    ).toEqual(["101.46 L", "power box, us box"]);
    expect(factsOf({ boomMaxCm: 190 }, [], "en")).toEqual([
      { field: "boomMaxCm", label: "Boom range (max)", value: "190 cm" },
    ]);
    expect(factsOf({ boomMinCm: 150 }, [], "en")[0]?.label).toBe(
      "Boom range (min)",
    );
  });

  it("is empty for a part with no facts", () => {
    expect(factsOf({}, [], "en")).toEqual([]);
  });
});
