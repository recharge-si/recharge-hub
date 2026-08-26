import { describe, expect, it } from "vitest";

import {
  IDENTICAL_FAILURES_BEFORE_DROPPING_PRICE,
  pricingIsTheProblem,
} from "~/domain/products/pricing-failures";

/**
 * The case behind this rule: a merchant deleted their pricelists in MetaKocka,
 * and the next product sync sent a price to one that no longer existed for
 * every SKU in the catalogue. Every call was rejected, every product was left
 * alone, and the merchant was shown a count.
 *
 * What this has to get right is both directions. Stopping too eagerly loses
 * prices over one bad product; never stopping turns one deleted pricelist into
 * a whole catalogue of failures.
 */
describe("when a rejected price is the run's problem, not the product's", () => {
  it("stops as soon as MetaKocka names the pricelist", () => {
    expect(
      pricingIsTheProblem({
        description: "Pricelist '2' does not exist.",
        identicalRunLength: 1,
      }),
    ).toBe(true);
  });

  it("reads MetaKocka's Slovenian as readily as its English", () => {
    expect(
      pricingIsTheProblem({
        description: "Cenik '2' ne obstaja.",
        identicalRunLength: 1,
      }),
    ).toBe(true);
  });

  it("lets one product fail on its own without dropping prices", () => {
    expect(
      pricingIsTheProblem({
        description: "Attribute 'tax' for product with code 'A-1' must be set.",
        identicalRunLength: 1,
      }),
    ).toBe(false);
  });

  it("stops once the same rejection has repeated across products", () => {
    const description = "Something MetaKocka has never said before.";

    expect(
      pricingIsTheProblem({
        description,
        identicalRunLength: IDENTICAL_FAILURES_BEFORE_DROPPING_PRICE - 1,
      }),
    ).toBe(false);
    expect(
      pricingIsTheProblem({
        description,
        identicalRunLength: IDENTICAL_FAILURES_BEFORE_DROPPING_PRICE,
      }),
    ).toBe(true);
  });

  it("still stops when MetaKocka answered nothing at all", () => {
    expect(
      pricingIsTheProblem({
        description: null,
        identicalRunLength: IDENTICAL_FAILURES_BEFORE_DROPPING_PRICE,
      }),
    ).toBe(true);
    expect(
      pricingIsTheProblem({ description: null, identicalRunLength: 1 }),
    ).toBe(false);
  });
});
