/**
 * Splitting one Shopify payment across N MetaKocka documents (CLAUDE.md §8.6).
 *
 * MetaKocka's `warehouse` and `profit_center` are document-level, so a split
 * order becomes one sales order per supply source. The money then has to be
 * divided in a way that adds back up exactly, because a one-cent drift is a
 * manual reconciliation for a human being every time it happens.
 *
 * The rules, decided once and asserted in tests:
 *
 *  - One document is **primary**: highest line total, ties broken own before
 *    partner, then by source code. Deterministic, so a retry picks the same one.
 *  - **Shipping and order-level discounts are spread in proportion to each
 *    document's merchandise value.** They were once assigned to the primary
 *    document alone, which never duplicated them but did put the whole postage
 *    of a split order on whichever warehouse happened to hold the most. A
 *    document's non-product value now matches the trade it actually carries,
 *    and the property that mattered before still holds and is what the tests
 *    assert: **the shares sum to the charge exactly, once.**
 *  - Everything is integer minor units (§15). No floats anywhere near money.
 *  - Any rounding remainder lands on the primary, so the documents sum to the
 *    Shopify total to the cent.
 */

import { compareCodepoints } from "~/domain/types";

export type SourceKind = "own" | "partner";

export interface SourceLineTotal {
  sourceId: string;
  sourceCode: string;
  kind: SourceKind;
  /** Sum of this source's allocated line values, tax included, minor units. */
  lineTotalMinor: number;
}

export interface MoneySplitInput {
  perSource: SourceLineTotal[];
  /** What Shopify says the order came to, in minor units. */
  orderTotalMinor: number;
  /** Shipping and any COD surcharge, minor units. Spread by merchandise value. */
  shippingMinor: number;
  /** Order-level discount as a positive number, minor units. Spread likewise. */
  discountMinor: number;
}

export interface DocumentShare {
  sourceId: string;
  sourceCode: string;
  isPrimary: boolean;
  lineTotalMinor: number;
  shippingMinor: number;
  discountMinor: number;
  /** What this document should come to. The shares sum to the order total. */
  totalMinor: number;
}

/**
 * Picks the primary document.
 *
 * Ties are broken all the way down to the source code so the choice is stable:
 * the same order must produce the same primary on every run, or a retry moves
 * the shipping charge from one document to another.
 */
function primaryIndex(perSource: SourceLineTotal[]): number {
  let best = 0;
  for (let index = 1; index < perSource.length; index += 1) {
    const candidate = perSource[index]!;
    const current = perSource[best]!;

    if (candidate.lineTotalMinor !== current.lineTotalMinor) {
      if (candidate.lineTotalMinor > current.lineTotalMinor) best = index;
      continue;
    }
    if (candidate.kind !== current.kind) {
      if (candidate.kind === "own") best = index;
      continue;
    }
    // Codepoint order, not `localeCompare`: which document carries the
    // shipping charge must not depend on the host's collation rules.
    if (compareCodepoints(candidate.sourceCode, current.sourceCode) < 0)
      best = index;
  }
  return best;
}

/**
 * Spreads one order-level charge across the documents by merchandise value.
 *
 * Deterministic in two senses, both load-bearing. The weights are read in a
 * canonical order - sorted by source code - so the cent that
 * `proportionalSplit` hands to the largest fractional part always goes to the
 * same document however the caller's array happened to be ordered. And a charge
 * on an order whose documents are all worth nothing lands entirely on the
 * primary rather than on whichever entry sorted first.
 *
 * The invariant, asserted in tests: the parts sum to the charge exactly. Never
 * more - a duplicated postage charge is money invented in a merchant's books -
 * and never less.
 */
function spread(
  perSource: SourceLineTotal[],
  amountMinor: number,
  primary: number,
): number[] {
  const shares = perSource.map(() => 0);
  if (amountMinor === 0) return shares;

  const order = perSource
    .map((source, index) => ({ index, code: source.sourceCode }))
    .sort((a, b) => compareCodepoints(a.code, b.code) || a.index - b.index);

  const weights = order.map((entry) =>
    Math.max(0, perSource[entry.index]!.lineTotalMinor),
  );

  if (weights.reduce((total, weight) => total + weight, 0) === 0) {
    shares[primary] = amountMinor;
    return shares;
  }

  const split = proportionalSplit(amountMinor, weights);
  order.forEach((entry, position) => {
    shares[entry.index] = split[position] ?? 0;
  });
  return shares;
}

export function splitOrderMoney(input: MoneySplitInput): DocumentShare[] {
  if (input.perSource.length === 0) return [];

  const primary = primaryIndex(input.perSource);
  const shipping = spread(input.perSource, input.shippingMinor, primary);
  const discount = spread(input.perSource, input.discountMinor, primary);

  const shares: DocumentShare[] = input.perSource.map((source, index) => ({
    sourceId: source.sourceId,
    sourceCode: source.sourceCode,
    isPrimary: index === primary,
    lineTotalMinor: source.lineTotalMinor,
    shippingMinor: shipping[index]!,
    discountMinor: discount[index]!,
    totalMinor: source.lineTotalMinor + shipping[index]! - discount[index]!,
  }));

  // Whatever the line values, shipping and discounts do not add up to, the
  // primary absorbs. Shopify's total is the number the customer was charged and
  // the one the books have to match, so it wins over our arithmetic.
  const sum = shares.reduce((total, share) => total + share.totalMinor, 0);
  const remainder = input.orderTotalMinor - sum;
  if (remainder !== 0) {
    const target = shares[primary]!;
    target.totalMinor += remainder;
  }

  return shares;
}

/**
 * The shares that would put a negative total on a MetaKocka document.
 *
 * §8.6 puts the order-level discount on the primary document alone — never
 * spread, because it is a single charge and not a per-source cost. On a split
 * order where that discount is larger than the primary's own lines, obeying
 * the rule produces a document worth less than nothing: a sales order for
 * -30.00 beside one for +30.00.
 *
 * MetaKocka would accept it. It accepts almost everything (§3), and the two
 * documents even sum to the right figure — so nothing downstream would ever
 * notice, and the merchant's ledger would carry a negative sales order it
 * cannot explain.
 *
 * There is no arithmetic that fixes this. Spreading the discount is forbidden,
 * and moving it to another document only moves the negative. What is left is
 * to stop and say so, which is what §11 calls an exception: the caller refuses
 * to write and a person decides. Pure, so the decision is the caller's and the
 * detection is testable without a database.
 */
export function negativeShares(shares: DocumentShare[]): DocumentShare[] {
  return shares.filter((share) => share.totalMinor < 0);
}

/**
 * Splits one amount across parts in proportion to their weights, in minor
 * units, with the remainder given to the largest part.
 *
 * Not used by `splitOrderMoney` — §8.6 is explicit that shipping is never
 * spread — but a proportional split is what a refund across documents needs in
 * phase 2, and doing it correctly once is cheaper than doing it wrongly twice.
 */
export function proportionalSplit(
  amountMinor: number,
  weights: number[],
): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return weights.map(() => 0);

  const exact = weights.map((weight) => (amountMinor * weight) / total);
  const floored = exact.map((value) => Math.floor(value));
  let remainder = amountMinor - floored.reduce((sum, value) => sum + value, 0);

  // Hand the leftover cents to the largest fractional parts first, which keeps
  // each share within one unit of its exact value.
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (const { index } of order) {
    if (remainder <= 0) break;
    floored[index] = (floored[index] ?? 0) + 1;
    remainder -= 1;
  }

  return floored;
}
