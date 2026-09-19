import { describe, expect, it } from "vitest";

import {
  classifyObservation,
  decideVariantPricing,
  effectiveDiscountBp,
  roundPrice,
  salePriceFor,
} from "~/domain/sales";

/**
 * docs/sale-campaigns.md § Discount calculation and § Existing-sale policy.
 *
 * Money is integer minor units and every example in the brief is checked to
 * the cent: 20 % of €2,199 is €1,759.20 and not €1,759.2000000000003.
 */
describe("salePriceFor", () => {
  const none = { mode: "none" } as const;

  it("takes a percentage off in basis points, half up", () => {
    expect(
      salePriceFor(219_900, { type: "percentage", value: 2000 }, none),
    ).toBe(175_920);
    expect(
      salePriceFor(89_900, { type: "percentage", value: 2000 }, none),
    ).toBe(71_920);
    // 10 % of 0.05 is 0.005: rounds to a cent off.
    expect(salePriceFor(5, { type: "percentage", value: 1000 }, none)).toBe(4);
  });

  it("takes a fixed amount off and never goes below zero", () => {
    expect(
      salePriceFor(200_000, { type: "fixed_amount", value: 10_000 }, none),
    ).toBe(190_000);
    expect(
      salePriceFor(5_000, { type: "fixed_amount", value: 10_000 }, none),
    ).toBe(0);
  });

  it("sets a price", () => {
    expect(
      salePriceFor(200_000, { type: "fixed_price", value: 99_900 }, none),
    ).toBe(99_900);
  });
});

describe("roundPrice", () => {
  const price = 182_327; // €1,823.27, the brief's example

  it("rounds to the merchant's price points", () => {
    expect(roundPrice(price, { mode: "none" })).toBe(182_327);
    expect(roundPrice(price, { mode: "nearest_whole" })).toBe(182_300);
    expect(roundPrice(price, { mode: "ending_9" })).toBe(181_900);
    expect(roundPrice(price, { mode: "ending_99" })).toBe(182_299);
    expect(roundPrice(price, { mode: "ending_99_99" })).toBe(179_999);
    expect(roundPrice(price, { mode: "increment", incrementMinor: 500 })).toBe(
      182_500,
    );
  });

  it("rounds endings down so the sale is never smaller than advertised", () => {
    // 1,823.80 to the .99 below, not the .99 above.
    expect(roundPrice(182_380, { mode: "ending_99" })).toBe(182_299);
    expect(roundPrice(182_399, { mode: "ending_99" })).toBe(182_399);
  });

  it("leaves a price too small to carry the ending alone", () => {
    expect(roundPrice(50, { mode: "ending_99" })).toBe(50);
    expect(roundPrice(99, { mode: "ending_99" })).toBe(99);
    expect(roundPrice(500, { mode: "ending_9" })).toBe(500);
    expect(roundPrice(5_000, { mode: "ending_99_99" })).toBe(5_000);
  });

  it("ignores a missing or zero increment", () => {
    expect(roundPrice(price, { mode: "increment", incrementMinor: 0 })).toBe(
      price,
    );
    expect(roundPrice(price, { mode: "increment" })).toBe(price);
  });
});

describe("decideVariantPricing", () => {
  const twentyOff = { type: "percentage", value: 2000 } as const;
  const none = { mode: "none" } as const;

  it("writes the original as compare-at for a variant not on sale", () => {
    const decision = decideVariantPricing({
      live: { priceMinor: 219_900, compareAtMinor: null },
      policy: "skip",
      discount: twentyOff,
      rounding: none,
    });
    expect(decision).toEqual({
      kind: "apply",
      original: { priceMinor: 219_900, compareAtMinor: null },
      baseMinor: 219_900,
      salePriceMinor: 175_920,
      saleCompareAtMinor: 219_900,
    });
  });

  it("treats a compare-at at or below the price as not on sale", () => {
    const decision = decideVariantPricing({
      live: { priceMinor: 10_000, compareAtMinor: 10_000 },
      policy: "skip",
      discount: twentyOff,
      rounding: none,
    });
    expect(decision.kind).toBe("apply");
  });

  describe("a variant already on sale (1,500 was 2,000)", () => {
    const live = { priceMinor: 150_000, compareAtMinor: 200_000 };

    it("is skipped by default", () => {
      expect(
        decideVariantPricing({
          live,
          policy: "skip",
          discount: twentyOff,
          rounding: none,
        }),
      ).toEqual({ kind: "skip", reason: "already_on_sale", original: live });
    });

    it("can be discounted from its selling price, keeping the compare-at", () => {
      expect(
        decideVariantPricing({
          live,
          policy: "discount_selling_price",
          discount: twentyOff,
          rounding: none,
        }),
      ).toEqual({
        kind: "apply",
        original: live,
        baseMinor: 150_000,
        salePriceMinor: 120_000,
        saleCompareAtMinor: 200_000,
      });
    });

    it("can be discounted from the compare-at, unless that would raise the price", () => {
      expect(
        decideVariantPricing({
          live,
          policy: "discount_compare_at",
          discount: { type: "percentage", value: 3000 },
          rounding: none,
        }),
      ).toMatchObject({
        kind: "apply",
        baseMinor: 200_000,
        salePriceMinor: 140_000,
      });

      expect(
        decideVariantPricing({
          live,
          policy: "discount_compare_at",
          discount: twentyOff,
          rounding: none,
        }),
      ).toEqual({ kind: "skip", reason: "would_raise_price", original: live });
    });

    it("can be overridden, even to a smaller discount", () => {
      expect(
        decideVariantPricing({
          live,
          policy: "override",
          discount: twentyOff,
          rounding: none,
        }),
      ).toMatchObject({
        kind: "apply",
        baseMinor: 200_000,
        salePriceMinor: 160_000,
        saleCompareAtMinor: 200_000,
      });
    });
  });

  it("never writes a sale that does not lower the price", () => {
    expect(
      decideVariantPricing({
        live: { priceMinor: 50_000, compareAtMinor: null },
        policy: "skip",
        discount: { type: "fixed_price", value: 60_000 },
        rounding: none,
      }),
    ).toMatchObject({ kind: "skip", reason: "no_discount" });

    expect(
      decideVariantPricing({
        live: { priceMinor: 50, compareAtMinor: null },
        policy: "skip",
        discount: { type: "percentage", value: 100 },
        rounding: { mode: "nearest_whole" },
      }),
    ).toMatchObject({ kind: "skip", reason: "zero_price" });

    expect(
      decideVariantPricing({
        live: { priceMinor: 50_000, compareAtMinor: null },
        policy: "skip",
        discount: { type: "percentage", value: 0 },
        rounding: none,
      }),
    ).toMatchObject({ kind: "skip", reason: "no_discount" });
  });
});

describe("effectiveDiscountBp", () => {
  it("compares campaigns by what they actually take off", () => {
    expect(effectiveDiscountBp(200_000, 160_000)).toBe(2000);
    expect(effectiveDiscountBp(200_000, 179_999)).toBe(1000);
    expect(effectiveDiscountBp(0, 0)).toBe(0);
  });
});

describe("classifyObservation", () => {
  const expected = {
    sale: { priceMinor: 160_000, compareAtMinor: 200_000 },
    original: { priceMinor: 200_000, compareAtMinor: null },
  };

  it("recognises its own write and the restored state", () => {
    expect(classifyObservation(expected, expected.sale)).toEqual({
      kind: "as_expected",
    });
    expect(classifyObservation(expected, expected.original)).toEqual({
      kind: "as_original",
    });
  });

  it("reads an ERP writing its list price into `price` as the new base", () => {
    expect(
      classifyObservation(expected, {
        priceMinor: 210_000,
        compareAtMinor: 200_000,
      }),
    ).toEqual({
      kind: "external",
      live: { priceMinor: 210_000, compareAtMinor: 200_000 },
      newBaseMinor: 210_000,
    });
  });

  it("reads a restated compare-at as the new base", () => {
    expect(
      classifyObservation(expected, {
        priceMinor: 160_000,
        compareAtMinor: 220_000,
      }),
    ).toMatchObject({ kind: "external", newBaseMinor: 220_000 });
    expect(
      classifyObservation(expected, {
        priceMinor: 210_000,
        compareAtMinor: null,
      }),
    ).toMatchObject({ kind: "external", newBaseMinor: 210_000 });
  });
});
