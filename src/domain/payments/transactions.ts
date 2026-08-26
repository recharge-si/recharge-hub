/**
 * The payment ledger of one Shopify order (CLAUDE.md §8.7).
 *
 * The rule this module exists to enforce is that **a payment is a transaction,
 * not a flag**. `financial_status` is a *display* summary Shopify computes: it
 * collapses two captures into "paid", says "partially_paid" without saying how
 * much, and reports "refunded" for an order whose money mostly stayed put. An
 * ERP that files its books from that summary files them from a rounding of the
 * truth.
 *
 * So the ledger is built from `order.transactions` and nothing else, and every
 * figure the rest of the app uses — gross received, refunded, net, outstanding
 * — is derived here from individual transactions with individual Shopify ids.
 *
 * Three distinctions carry the whole design:
 *
 *  - **An authorization is not money.** It is a hold on a card. Booking it as a
 *    receipt states income that has not happened; the corresponding capture may
 *    never come, or may come for less.
 *  - **A refund is not a smaller payment.** It is its own movement in the other
 *    direction. Rewriting a 300 capture into a 250 one to represent a 50 refund
 *    destroys the record of what was actually received, which is the one thing
 *    the books need.
 *  - **Only success counts.** Pending, failure, error and awaiting-response are
 *    all money that has not moved, and a pending transaction that later
 *    succeeds arrives again as an update to the same id.
 *
 * Pure (§5): every function here takes values and returns values.
 */

/**
 * Shopify's `OrderTransactionKind`, narrowed.
 *
 * `change` covers the transactions an order *edit* produces when the total
 * moves. Shopify reports them with a sale-like or refund-like effect that is
 * not separately documented as settled money, so they are carried in the ledger
 * and deliberately excluded from the settled arithmetic. Anything unrecognised
 * is `other`, which is likewise carried and not counted.
 */
export type TransactionKind =
  | "authorization"
  | "capture"
  | "sale"
  | "void"
  | "refund"
  | "change"
  | "other";

export type TransactionStatus =
  | "success"
  | "pending"
  | "failure"
  | "error"
  | "awaiting_response"
  | "unknown";

export interface OrderTransaction {
  /** Shopify's own transaction id. The ledger's identity (§8.7). */
  shopifyTransactionId: string;
  kind: TransactionKind;
  status: TransactionStatus;
  /**
   * Always the magnitude Shopify reports, never signed. Direction is the
   * `kind`'s job — a refund carrying a negative amount *and* a refund kind
   * would cancel itself out.
   */
  amountMinor: number;
  currency: string;
  gateway: string | null;
  processedAt: Date | null;
  /** The authorization a capture belongs to, or the sale a refund reverses. */
  parentTransactionId: string | null;
}

const KINDS = new Set<TransactionKind>([
  "authorization",
  "capture",
  "sale",
  "void",
  "refund",
  "change",
]);

const STATUSES = new Set<TransactionStatus>([
  "success",
  "pending",
  "failure",
  "error",
  "awaiting_response",
]);

/** Shopify's enum, in either case, narrowed. Unknown members are not guessed. */
export function toTransactionKind(
  raw: string | null | undefined,
): TransactionKind {
  const value = (raw ?? "").toLowerCase().trim();
  // Shopify's chip-and-PIN member behaves as an authorization for our purposes:
  // it is a hold, and its capture arrives separately.
  if (value === "emv_authorization") return "authorization";
  return KINDS.has(value as TransactionKind)
    ? (value as TransactionKind)
    : "other";
}

export function toTransactionStatus(
  raw: string | null | undefined,
): TransactionStatus {
  const value = (raw ?? "").toLowerCase().trim();
  return STATUSES.has(value as TransactionStatus)
    ? (value as TransactionStatus)
    : "unknown";
}

/**
 * Money actually received.
 *
 * A sale is a capture and an authorization in one step, which is what every
 * immediate-payment gateway sends. A capture is the second half of a two-step
 * payment. Nothing else is income — see the module note on authorizations.
 */
export function isSettledReceipt(transaction: OrderTransaction): boolean {
  return (
    transaction.status === "success" &&
    (transaction.kind === "sale" || transaction.kind === "capture")
  );
}

/** Money actually given back. */
export function isSettledRefund(transaction: OrderTransaction): boolean {
  return transaction.status === "success" && transaction.kind === "refund";
}

/**
 * A hold that has not been captured and has not been voided.
 *
 * Reported so the merchant can see why an order shows as authorized in Shopify
 * and unpaid in the ERP, and so the app can say *why* it is not sending a
 * payment rather than saying nothing at all.
 */
export function isOpenAuthorization(
  transaction: OrderTransaction,
  all: readonly OrderTransaction[],
): boolean {
  if (transaction.status !== "success") return false;
  if (transaction.kind !== "authorization") return false;

  return !all.some(
    (other) =>
      other.status === "success" &&
      (other.kind === "void" || other.kind === "capture") &&
      other.parentTransactionId === transaction.shopifyTransactionId,
  );
}

/**
 * The payment state this app computes for itself, from transactions.
 *
 * Deliberately not Shopify's `financial_status`, and the members differ from it
 * on purpose so nothing reads one where the other is meant.
 */
export type PaymentState =
  /** Nothing successful has happened. */
  | "unpaid"
  /** A hold exists and no money has moved. */
  | "authorized"
  /** Some money received, less than the order total. */
  | "partially_paid"
  /** Received equals the order total. */
  | "paid"
  /** Received exceeds the order total. Always worth a person's attention. */
  | "overpaid"
  /** Some received money has been given back, and some remains. */
  | "partially_refunded"
  /** Everything received has been given back. */
  | "refunded";

export interface PaymentSummary {
  /** Sum of successful sale and capture amounts. Never reduced by a refund. */
  grossReceivedMinor: number;
  /** Sum of successful refund amounts. */
  refundedMinor: number;
  /** Gross received less refunded. What the customer has actually paid. */
  netPaidMinor: number;
  /** Order total less net paid, floored at zero. */
  outstandingMinor: number;
  /** Successful, uncaptured, unvoided holds. Not money. */
  authorizedMinor: number;
  state: PaymentState;
  /** How many transactions were counted, for the audit trail. */
  receiptCount: number;
  refundCount: number;
}

/**
 * The whole ledger reduced to the figures the rest of the app reasons about.
 *
 * `orderTotalMinor` is Shopify's *current* total — which moves when an order is
 * edited — so "outstanding" answers the only question that matters: how much of
 * what the customer now owes has arrived.
 */
export function summarisePayments(
  transactions: readonly OrderTransaction[],
  orderTotalMinor: number,
): PaymentSummary {
  let grossReceivedMinor = 0;
  let refundedMinor = 0;
  let authorizedMinor = 0;
  let receiptCount = 0;
  let refundCount = 0;

  for (const transaction of transactions) {
    if (isSettledReceipt(transaction)) {
      grossReceivedMinor += transaction.amountMinor;
      receiptCount += 1;
      continue;
    }
    if (isSettledRefund(transaction)) {
      refundedMinor += transaction.amountMinor;
      refundCount += 1;
      continue;
    }
    if (isOpenAuthorization(transaction, transactions)) {
      authorizedMinor += transaction.amountMinor;
    }
  }

  const netPaidMinor = grossReceivedMinor - refundedMinor;
  const outstandingMinor = Math.max(0, orderTotalMinor - netPaidMinor);

  return {
    grossReceivedMinor,
    refundedMinor,
    netPaidMinor,
    outstandingMinor,
    authorizedMinor,
    receiptCount,
    refundCount,
    state: paymentStateOf({
      grossReceivedMinor,
      refundedMinor,
      netPaidMinor,
      authorizedMinor,
      orderTotalMinor,
    }),
  };
}

/**
 * The state, from the figures.
 *
 * Order matters. A fully refunded order is described as refunded even though
 * its outstanding balance also happens to equal the total, because "unpaid"
 * would invite the app to chase a payment that already came and went.
 */
function paymentStateOf(input: {
  grossReceivedMinor: number;
  refundedMinor: number;
  netPaidMinor: number;
  authorizedMinor: number;
  orderTotalMinor: number;
}): PaymentState {
  if (input.grossReceivedMinor > 0 && input.netPaidMinor <= 0) {
    return "refunded";
  }
  if (input.refundedMinor > 0) return "partially_refunded";

  if (input.grossReceivedMinor === 0) {
    return input.authorizedMinor > 0 ? "authorized" : "unpaid";
  }

  if (input.netPaidMinor > input.orderTotalMinor) return "overpaid";
  if (input.netPaidMinor === input.orderTotalMinor) return "paid";
  return "partially_paid";
}

/**
 * A stable order for transactions.
 *
 * Everything downstream — the allocation across documents, the `mark_paid`
 * array, the audit line — has to come out the same on every run for the same
 * ledger, or a reconciliation that changed nothing still rewrites the ERP
 * document. Time first because that is the meaningful order, then id, because
 * two transactions can share a timestamp and ids are unique.
 */
export function sortTransactions(
  transactions: readonly OrderTransaction[],
): OrderTransaction[] {
  return [...transactions].sort((a, b) => {
    const at = a.processedAt?.getTime() ?? 0;
    const bt = b.processedAt?.getTime() ?? 0;
    if (at !== bt) return at - bt;
    return a.shopifyTransactionId < b.shopifyTransactionId
      ? -1
      : a.shopifyTransactionId > b.shopifyTransactionId
        ? 1
        : 0;
  });
}
