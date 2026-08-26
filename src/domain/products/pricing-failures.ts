/**
 * When a rejected price stops being this product's problem and starts being
 * the run's.
 *
 * A merchant may delete a pricelist in MetaKocka at any time. CLAUDE.md §3 says
 * the API can neither create nor list pricelists, so the app cannot see that
 * happen — it finds out the way everything else about MetaKocka is found out,
 * from a rejected write. Left alone, the product sync then sends the same
 * doomed price once per SKU and reports a number: "39 products were rejected".
 *
 * This is the rule that turns that into one rejection, a reason, and a run that
 * still does the part of its job that works. Pure so it can be tested without a
 * catalogue: it takes what MetaKocka said and how many times in a row it has
 * said it, and nothing else.
 */

/**
 * How many identical rejections on priced writes are enough to conclude the
 * price is the problem, when MetaKocka has not said so in as many words.
 *
 * MetaKocka's wording is not documented and not stable enough to match on alone
 * (§3), so repetition is the second signal. One product can be rejected for its
 * own reasons; the same sentence about three in a row is a condition of the run.
 */
export const IDENTICAL_FAILURES_BEFORE_DROPPING_PRICE = 3;

/**
 * Words that put a rejection on the pricelist rather than on the product.
 *
 * Only ever asked of a write that carried a price, which is what makes a
 * mention of the pricelist mean the price. Slovenian included because MetaKocka
 * answers in it: `opr_desc` is written for whoever is looking at the ERP.
 */
const PRICELIST_WORDS = /pricelist|price list|cenik|ceniku|cenika/i;

export interface PriceFailure {
  /** MetaKocka's `opr_desc`, or null when it never answered. */
  description: string | null;
  /** How many priced writes in a row have failed with this same description. */
  identicalRunLength: number;
}

/**
 * True when the price should stop going out for the rest of the run.
 *
 * The caller drops the price and retries the SKU with its name alone, so a
 * deleted pricelist costs one rejected call and nothing else: names keep
 * syncing, and nobody has to fix the ERP before the rest of the catalogue can
 * be renamed.
 */
export function pricingIsTheProblem(failure: PriceFailure): boolean {
  if (failure.description && PRICELIST_WORDS.test(failure.description)) {
    return true;
  }

  return failure.identicalRunLength >= IDENTICAL_FAILURES_BEFORE_DROPPING_PRICE;
}
