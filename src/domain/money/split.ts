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
 *  - **Shipping, COD surcharge and order-level discounts go on the primary
 *    document only.** They are single charges, not per-source costs, and
 *    spreading them would invent numbers nobody agreed to.
 *  - Everything is integer minor units (§15). No floats anywhere near money.
 *  - Any rounding remainder lands on the primary, so the documents sum to the
 *    Shopify total to the cent.
 */

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
  /** Shipping and any COD surcharge, minor units. Primary document only. */
  shippingMinor: number;
  /** Order-level discount as a positive number, minor units. Primary only. */
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
    if (candidate.sourceCode.localeCompare(current.sourceCode) < 0)
      best = index;
  }
  return best;
}

export function splitOrderMoney(input: MoneySplitInput): DocumentShare[] {
  if (input.perSource.length === 0) return [];

  const primary = primaryIndex(input.perSource);

  const shares: DocumentShare[] = input.perSource.map((source, index) => {
    const isPrimary = index === primary;
    const shipping = isPrimary ? input.shippingMinor : 0;
    const discount = isPrimary ? input.discountMinor : 0;

    return {
      sourceId: source.sourceId,
      sourceCode: source.sourceCode,
      isPrimary,
      lineTotalMinor: source.lineTotalMinor,
      shippingMinor: shipping,
      discountMinor: discount,
      totalMinor: source.lineTotalMinor + shipping - discount,
    };
  });

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
