/**
 * The two things that must be true after every reconciliation (CLAUDE.md §8.6,
 * §8.11).
 *
 * Every other rule in this connector is a means to these ends, so they are
 * checked directly rather than assumed from the code paths that were supposed
 * to maintain them:
 *
 * ```text
 * for every SKU:
 *   SUM(quantity across the order's live MetaKocka documents)
 *     = the quantity Shopify currently says
 *
 * SUM(value of the order's live MetaKocka documents)
 *     ~ the value Shopify currently says
 * ```
 *
 * The response to a broken invariant is the important part, and it is stated
 * once here because getting it wrong is how a duplicate is created. **A
 * mismatch is never repaired by writing another document.** If MetaKocka holds
 * six where Shopify says four, another document makes it ten. The order is
 * marked inconsistent, the exact difference is recorded per SKU, and the
 * deterministic reconciliation — update the documents that exist — is what
 * repairs it on the next pass.
 *
 * Pure (§5).
 */

export interface SkuQuantity {
  sku: string;
  quantity: number;
}

export interface QuantityDiscrepancy {
  sku: string;
  /** What Shopify currently says. */
  expected: number;
  /** What the order's live MetaKocka documents add up to. */
  actual: number;
  /** `actual - expected`. Positive means the ERP holds too much. */
  difference: number;
}

export interface QuantityVerification {
  ok: boolean;
  discrepancies: QuantityDiscrepancy[];
  expectedTotal: number;
  actualTotal: number;
}

function totalsBySku(entries: readonly SkuQuantity[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    if (entry.quantity === 0) continue;
    totals.set(entry.sku, (totals.get(entry.sku) ?? 0) + entry.quantity);
  }
  return totals;
}

/**
 * Compares the order's desired quantities against what the documents hold.
 *
 * Both sides are flattened to SKU totals rather than compared document by
 * document, deliberately: moving a SKU from one warehouse to another changes
 * both documents and changes nothing about this invariant, which is exactly the
 * property that makes it worth asserting. A location move that is correct
 * passes; one that duplicated the line fails.
 *
 * A SKU present on one side only is a discrepancy with the other side at zero,
 * not a silently skipped comparison — an extra SKU in the ERP is the most
 * expensive failure there is.
 */
export function verifyQuantities(input: {
  expected: readonly SkuQuantity[];
  actual: readonly SkuQuantity[];
}): QuantityVerification {
  const expected = totalsBySku(input.expected);
  const actual = totalsBySku(input.actual);

  const skus = [...new Set([...expected.keys(), ...actual.keys()])].sort(
    (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  );

  const discrepancies: QuantityDiscrepancy[] = [];
  for (const sku of skus) {
    const want = expected.get(sku) ?? 0;
    const have = actual.get(sku) ?? 0;
    if (want === have) continue;
    discrepancies.push({
      sku,
      expected: want,
      actual: have,
      difference: have - want,
    });
  }

  const sum = (totals: Map<string, number>) =>
    [...totals.values()].reduce((total, value) => total + value, 0);

  return {
    ok: discrepancies.length === 0,
    discrepancies,
    expectedTotal: sum(expected),
    actualTotal: sum(actual),
  };
}

export interface ValueVerification {
  ok: boolean;
  expectedMinor: number;
  actualMinor: number;
  differenceMinor: number;
  toleranceMinor: number;
}

/**
 * How far the documents may sum away from the order before it is a problem.
 *
 * Not zero, and the reason is a real gap rather than sloppiness: shipping and
 * order-level discounts are accounted for in the *shares* but are not yet
 * represented as MetaKocka document lines (project status T-05/T-06), so an
 * exact comparison would report every order with postage on it as broken. One
 * unit of currency absorbs rounding; the caller passes the shipping and
 * discount it knows about as an explicit allowance rather than widening this.
 */
export const DEFAULT_VALUE_TOLERANCE_MINOR = 1;

/**
 * Compares what the documents come to against what the order comes to.
 *
 * `allowanceMinor` is money the caller *knows* is not represented on the
 * documents — today, shipping and the order-level discount. Passing it keeps
 * the check honest: the invariant still fails when a line price drifts, which
 * is what it is for, and does not fail for a limitation that is recorded
 * elsewhere and has its own fix.
 */
export function verifyValue(input: {
  expectedMinor: number;
  actualMinor: number;
  allowanceMinor?: number;
  toleranceMinor?: number;
}): ValueVerification {
  const tolerance =
    (input.toleranceMinor ?? DEFAULT_VALUE_TOLERANCE_MINOR) +
    Math.abs(input.allowanceMinor ?? 0);

  const differenceMinor = input.actualMinor - input.expectedMinor;

  return {
    ok: Math.abs(differenceMinor) <= tolerance,
    expectedMinor: input.expectedMinor,
    actualMinor: input.actualMinor,
    differenceMinor,
    toleranceMinor: tolerance,
  };
}

/* -------------------------------------------------------------------------- */
/* The value invariant, stated as an identity rather than a tolerance          */
/* -------------------------------------------------------------------------- */

export interface ValueReconciliation {
  ok: boolean;
  /** What Shopify charged, including shipping and after discounts. */
  orderTotalMinor: number;
  /** Line value the MetaKocka documents actually hold. */
  documentsMinor: number;
  /** Line value they *should* hold: managed quantity at Shopify's unit price. */
  productsExpectedMinor: number;
  /** `documents - productsExpected`. Real drift; nothing explains this away. */
  documentDriftMinor: number;

  /* The parts of the order that are deliberately not on a document line. */
  lineDiscountMinor: number;
  orderDiscountMinor: number;
  shippingMinor: number;
  /** Value of quantity fulfilled outside MetaKocka. */
  externalValueMinor: number;

  /** The order total reconstructed from every named part. */
  explainedMinor: number;
  /** `orderTotal - explained`. Anything here is genuinely unaccounted for. */
  unexplainedMinor: number;
  toleranceMinor: number;
}

/**
 * Reconciles the Shopify order total against everything the connector knows.
 *
 * The previous version of this check took a single `allowanceMinor` and widened
 * the tolerance by it, which is a way of not checking: any difference smaller
 * than the shipping charge passed, whatever caused it. So the identity is
 * written out instead, and every term is named:
 *
 * ```text
 *   products represented          (managed quantity x unit price)
 * - line discounts                (parsed, stored, not on a document line)
 * - order-level discount          (assigned to the primary share, not a line)
 * + shipping                      (assigned to the primary share, not a line)
 * + value fulfilled externally    (deliberately not in MetaKocka)
 * = the Shopify order total
 * ```
 *
 * Two failures fall out of it, and they mean different things:
 *
 *  - **`documentDriftMinor`** — the documents do not hold what this app meant
 *    to send. A price that moved after the document was written, a line that
 *    was rewritten by hand in the ERP. Nothing explains this and it always
 *    fails.
 *  - **`unexplainedMinor`** — the identity does not close. Something about the
 *    order's money is not in any of the named terms, which is precisely the
 *    condition the old allowance was hiding.
 *
 * Rounding only: `toleranceMinor` is a cent, not a shipping charge.
 */
export function reconcileValue(input: {
  orderTotalMinor: number;
  documentsMinor: number;
  productsExpectedMinor: number;
  lineDiscountMinor: number;
  orderDiscountMinor: number;
  shippingMinor: number;
  externalValueMinor: number;
  toleranceMinor?: number;
}): ValueReconciliation {
  const tolerance = input.toleranceMinor ?? DEFAULT_VALUE_TOLERANCE_MINOR;

  const documentDriftMinor = input.documentsMinor - input.productsExpectedMinor;

  const explainedMinor =
    input.productsExpectedMinor -
    input.lineDiscountMinor -
    input.orderDiscountMinor +
    input.shippingMinor +
    input.externalValueMinor;

  const unexplainedMinor = input.orderTotalMinor - explainedMinor;

  return {
    ok:
      Math.abs(documentDriftMinor) <= tolerance &&
      Math.abs(unexplainedMinor) <= tolerance,
    orderTotalMinor: input.orderTotalMinor,
    documentsMinor: input.documentsMinor,
    productsExpectedMinor: input.productsExpectedMinor,
    documentDriftMinor,
    lineDiscountMinor: input.lineDiscountMinor,
    orderDiscountMinor: input.orderDiscountMinor,
    shippingMinor: input.shippingMinor,
    externalValueMinor: input.externalValueMinor,
    explainedMinor,
    unexplainedMinor,
    toleranceMinor: tolerance,
  };
}

/** Merchant-readable, one term per line. The brief's requested breakdown. */
export function describeValueReconciliation(
  value: ValueReconciliation,
  money: (minor: number) => string,
): string[] {
  const lines = [
    `Products represented in MetaKocka: ${money(value.productsExpectedMinor)}.`,
  ];

  if (value.lineDiscountMinor !== 0) {
    lines.push(`Line discounts not represented: ${money(value.lineDiscountMinor)}.`);
  }
  if (value.orderDiscountMinor !== 0) {
    lines.push(`Order discount not represented: ${money(value.orderDiscountMinor)}.`);
  }
  if (value.shippingMinor !== 0) {
    lines.push(`Shipping not represented: ${money(value.shippingMinor)}.`);
  }
  if (value.externalValueMinor !== 0) {
    lines.push(
      `Fulfilled outside MetaKocka: ${money(value.externalValueMinor)}.`,
    );
  }

  lines.push(
    `Explained total: ${money(value.explainedMinor)} against a Shopify total of ${money(value.orderTotalMinor)}.`,
  );

  if (value.documentDriftMinor !== 0) {
    lines.push(
      `The documents hold ${money(value.documentsMinor)} where ${money(value.productsExpectedMinor)} was expected (${value.documentDriftMinor > 0 ? "+" : ""}${money(value.documentDriftMinor)}).`,
    );
  }
  if (value.unexplainedMinor !== 0) {
    lines.push(
      `${money(Math.abs(value.unexplainedMinor))} of this order's value is not accounted for by any of the above.`,
    );
  }

  return lines;
}

export interface PaymentVerification {
  ok: boolean;
  /** Settled receipts less settled refunds, from the ledger. */
  netPaidMinor: number;
  /** What the connector has recorded against MetaKocka documents. */
  representedMinor: number;
  differenceMinor: number;
}

/**
 * The payment invariant of §8.7, stated the way §24 asks for it.
 *
 * Deliberately compares against `grossReceivedMinor`, not the net. Refunds are
 * credit notes in MetaKocka, not reductions of a recorded receipt: a document
 * that received 300 and was later credited 50 still legitimately carries a 300
 * payment, and comparing the net would report every refunded order as broken
 * for ever.
 */
export function verifyPaymentRepresentation(input: {
  grossReceivedMinor: number;
  representedMinor: number;
}): PaymentVerification {
  const differenceMinor = input.representedMinor - input.grossReceivedMinor;
  return {
    ok: differenceMinor === 0,
    netPaidMinor: input.grossReceivedMinor,
    representedMinor: input.representedMinor,
    differenceMinor,
  };
}

/**
 * A one-line-per-SKU description of what is wrong, for the exception message.
 *
 * §11 wants an exception to say what is wrong *and* what to do; the "what to do"
 * belongs to the caller, which knows whether the difference is repairable. This
 * is the "what is wrong", in the form the brief asks for.
 */
export function describeDiscrepancies(
  discrepancies: readonly QuantityDiscrepancy[],
): string[] {
  return discrepancies.map(
    (entry) =>
      `${entry.sku || "(no SKU)"}: Shopify ${entry.expected}, MetaKocka ${entry.actual} (${entry.difference > 0 ? "+" : ""}${entry.difference}).`,
  );
}
