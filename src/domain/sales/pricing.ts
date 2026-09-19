import type {
  DiscountSpec,
  ExistingSalePolicy,
  PricePair,
  RoundingSpec,
  SkipReason,
} from "~/domain/sales/types";

/**
 * How a sale price is computed (docs/sale-campaigns.md § Discount
 * calculation).
 *
 * Integer arithmetic over minor units throughout. A percentage is basis
 * points, so 20 % of €18.2327 is `1_823_27 × 2000 / 10_000`, rounded half
 * up on the integer — never a float, never a cent of drift.
 */

/** Minor units in one whole unit of currency. Every supported currency has two places. */
const UNIT = 100;

function roundHalfUp(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator / 2) / denominator);
}

/** The reduction a discount takes off `base`, before rounding. */
export function reductionFor(base: number, discount: DiscountSpec): number {
  switch (discount.type) {
    case "percentage":
      return roundHalfUp(base * discount.value, 10_000);
    case "fixed_amount":
      return discount.value;
    case "fixed_price":
      return base - discount.value;
  }
}

/**
 * Rounds a computed price to the merchant's price point.
 *
 * The named endings round **down** — a sale that is advertised as 20 % off
 * must not come to more than 20 % off would — and a price too small to carry
 * the ending is left alone rather than rounded to nothing. `nearest_whole`
 * and `increment` round half up, which is what "nearest" means.
 */
export function roundPrice(minor: number, rounding: RoundingSpec): number {
  switch (rounding.mode) {
    case "none":
      return minor;
    case "nearest_whole":
      return roundHalfUp(minor, UNIT) * UNIT;
    case "ending_99":
      return endingBelow(minor, UNIT, 1);
    case "ending_9":
      return endingBelow(minor, 10 * UNIT, UNIT);
    case "ending_99_99":
      return endingBelow(minor, 100 * UNIT, 1);
    case "increment": {
      const increment = rounding.incrementMinor ?? 0;
      if (increment <= 0) return minor;
      return roundHalfUp(minor, increment) * increment;
    }
  }
}

/**
 * The largest `k × step − offset` that is at most `minor`: 1823.27 with a step
 * of 100.00 and an offset of 0.01 is 1799.99. Below the first such price the
 * value is returned unchanged.
 */
function endingBelow(minor: number, step: number, offset: number): number {
  const candidate = Math.floor((minor + offset) / step) * step - offset;
  return candidate < step - offset ? minor : candidate;
}

/** The sale price for a base, after discount and rounding, never below zero. */
export function salePriceFor(
  base: number,
  discount: DiscountSpec,
  rounding: RoundingSpec,
): number {
  const reduced = base - reductionFor(base, discount);
  return Math.max(0, roundPrice(Math.max(0, reduced), rounding));
}

export type PricingDecision =
  | {
      kind: "apply";
      /** Exactly what Shopify holds now; what restore writes. */
      original: PricePair;
      /** What the discount was computed from. */
      baseMinor: number;
      salePriceMinor: number;
      saleCompareAtMinor: number;
    }
  | { kind: "skip"; reason: SkipReason; original: PricePair };

/** Whether Shopify's pair reads as a sale to a customer. */
export function isOnSale(pair: PricePair): boolean {
  return pair.compareAtMinor !== null && pair.compareAtMinor > pair.priceMinor;
}

/**
 * What a campaign does to one variant, given what Shopify holds right now
 * (docs/sale-campaigns.md § Existing-sale policy).
 *
 * The original pair is recorded whatever the policy decides, so restore is
 * exact. A variant already on sale is left alone by default; the other
 * policies choose the base and keep the customer-visible compare-at. A sale
 * that would not lower the price is never written.
 */
export function decideVariantPricing(input: {
  live: PricePair;
  policy: ExistingSalePolicy;
  discount: DiscountSpec;
  rounding: RoundingSpec;
}): PricingDecision {
  const { live, policy, discount, rounding } = input;
  const original: PricePair = {
    priceMinor: live.priceMinor,
    compareAtMinor: live.compareAtMinor,
  };

  let base: number;
  let compareAt: number;

  if (isOnSale(live) && live.compareAtMinor !== null) {
    switch (policy) {
      case "skip":
        return { kind: "skip", reason: "already_on_sale", original };
      case "discount_selling_price":
        base = live.priceMinor;
        compareAt = live.compareAtMinor;
        break;
      case "discount_compare_at": {
        base = live.compareAtMinor;
        compareAt = live.compareAtMinor;
        const sale = salePriceFor(base, discount, rounding);
        if (sale >= live.priceMinor) {
          return { kind: "skip", reason: "would_raise_price", original };
        }
        break;
      }
      case "override":
        base = live.compareAtMinor;
        compareAt = live.compareAtMinor;
        break;
    }
  } else {
    base = live.priceMinor;
    compareAt = live.priceMinor;
  }

  const salePriceMinor = salePriceFor(base, discount, rounding);
  if (salePriceMinor >= compareAt) {
    return { kind: "skip", reason: "no_discount", original };
  }
  // A discount that rounds to nothing is a giveaway, not a sale.
  if (salePriceMinor <= 0) {
    return { kind: "skip", reason: "zero_price", original };
  }

  return {
    kind: "apply",
    original,
    baseMinor: base,
    salePriceMinor,
    saleCompareAtMinor: compareAt,
  };
}

/** The reduction as basis points of the base, for comparing two campaigns. */
export function effectiveDiscountBp(base: number, sale: number): number {
  if (base <= 0) return 0;
  return roundHalfUp((base - sale) * 10_000, base);
}

export function samePair(a: PricePair, b: PricePair): boolean {
  return a.priceMinor === b.priceMinor && a.compareAtMinor === b.compareAtMinor;
}
