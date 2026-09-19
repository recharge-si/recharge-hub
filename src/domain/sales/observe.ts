import { isOnSale, samePair } from "~/domain/sales/pricing";
import type { PricePair } from "~/domain/sales/types";

/**
 * Telling our own writes apart from everybody else's
 * (docs/sale-campaigns.md § Loop prevention, § External base-price change).
 *
 * A campaign knows what it wrote (`sale`) and what it will put back
 * (`original`). Anything Shopify reports that is one of those two is either
 * our write echoing back through a webhook or a harmless state; anything else
 * is an external modification, and the pair says what the new base is.
 */

export interface ExpectedPairs {
  sale: PricePair;
  original: PricePair;
}

export type Observation =
  | { kind: "as_expected" }
  | { kind: "as_original" }
  | {
      kind: "external";
      live: PricePair;
      /** The price the campaign should now treat as the base. */
      newBaseMinor: number;
    };

export function classifyObservation(
  expected: ExpectedPairs,
  live: PricePair,
): Observation {
  if (samePair(live, expected.sale)) return { kind: "as_expected" };
  if (samePair(live, expected.original)) return { kind: "as_original" };

  /*
   * Which of the two numbers is the new base. A compare-at that moved and is
   * above the price is somebody restating the full price (the ERP wrote both
   * fields, or a person edited the compare-at). Otherwise the price itself
   * moved — the ERP's price sync writing its list price straight into `price`
   * — and that is the base.
   */
  const compareAtMoved =
    live.compareAtMinor !== null &&
    live.compareAtMinor !== expected.sale.compareAtMinor;
  const newBaseMinor =
    compareAtMoved && isOnSale(live) && live.compareAtMinor !== null
      ? live.compareAtMinor
      : live.priceMinor;

  return { kind: "external", live, newBaseMinor };
}
