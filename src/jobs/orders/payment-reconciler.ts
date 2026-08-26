import {
  listLedger,
  recordPaymentSummary,
  recordPaymentTypes,
  syncLedger,
  type LedgerRow,
} from "~/adapters/db/repositories/order-payment.server";
import type { DocumentPayment } from "~/adapters/metakocka/documents";
import type { DocumentShare } from "~/domain/money/split";
import {
  allocatePayments,
  allocationPreservesReceipts,
  type AllocatableReceipt,
  type AllocatedEntry,
  type PayableDocument,
  type PaymentAllocationStrategy,
} from "~/domain/payments/allocation";
import {
  isSettledReceipt,
  summarisePayments,
  type OrderTransaction,
  type PaymentSummary,
} from "~/domain/payments/transactions";
import { resolvePaymentType } from "~/jobs/payment";
import type { Principal } from "~/domain/types";

/**
 * Turning Shopify's payment transactions into what each MetaKocka document
 * should carry (CLAUDE.md §8.7; order-reconciliation brief §15–§22).
 *
 * The shape of the whole thing, and the reason it is shaped that way:
 *
 * ```text
 * Shopify order
 * ├── commercial state ....... the lines, the warehouses, the documents
 * └── payment ledger ......... CAPTURE +100, CAPTURE +200, REFUND -50
 *                                   |
 *                                   v
 *                              allocated across documents by value
 *                                   |
 *                                   v
 *                              one mark_paid array per document
 * ```
 *
 * The ledger sits at **order** level and is deliberately independent of the
 * warehouse split. That independence is what stops a warehouse move rewriting
 * payment history: moving a line changes which documents exist and what they
 * are worth, and it changes not one thing about what the customer paid.
 *
 * Refunds are in the ledger and are **not** projected onto documents. §8.8 and
 * the verified update-is-replacement behaviour mean the only way to represent a
 * refund on a sales order would be to reduce a recorded receipt, which destroys
 * the record of what was actually received. In MetaKocka a refund is a credit
 * note; here it is history, a net figure, and an exception asking for that
 * credit note.
 */

export interface LedgerState {
  rows: LedgerRow[];
  summary: PaymentSummary;
  added: string[];
  changed: string[];
}

/**
 * Brings the stored ledger in line with Shopify and materialises the summary.
 *
 * Runs whether or not payments are being written to MetaKocka: "what has this
 * customer actually paid" is worth answering on the order screen even for a
 * merchant who settles in the ERP by hand.
 */
export async function reconcileLedger(
  principal: Principal,
  input: {
    orderId: string;
    transactions: readonly OrderTransaction[];
    orderTotalMinor: number;
    now: Date;
  },
): Promise<LedgerState> {
  const synced = await syncLedger(
    principal,
    input.orderId,
    input.transactions,
  );

  const summary = summarisePayments(
    synced.rows.map(toDomainTransaction),
    input.orderTotalMinor,
  );

  await recordPaymentSummary(input.orderId, {
    state: summary.state,
    grossReceivedMinor: summary.grossReceivedMinor,
    refundedMinor: summary.refundedMinor,
    netPaidMinor: summary.netPaidMinor,
    outstandingMinor: summary.outstandingMinor,
    readAt: input.now,
  });

  return {
    rows: synced.rows,
    summary,
    added: synced.added,
    changed: synced.changed,
  };
}

/** The stored ledger and its summary, without asking Shopify. */
export async function readLedger(
  principal: Principal,
  orderId: string,
  orderTotalMinor: number,
): Promise<LedgerState> {
  const rows = await listLedger(principal, orderId);
  return {
    rows,
    summary: summarisePayments(rows.map(toDomainTransaction), orderTotalMinor),
    added: [],
    changed: [],
  };
}

function toDomainTransaction(row: LedgerRow): OrderTransaction {
  return {
    shopifyTransactionId: row.shopifyTransactionId,
    kind: row.kind,
    status: row.status,
    amountMinor: row.amountMinor,
    currency: row.currency,
    gateway: row.gateway,
    processedAt: row.processedAt,
    parentTransactionId: row.parentTransactionId,
  };
}

export interface PaymentPlanEntry {
  orderPaymentId: string;
  shopifyTransactionId: string;
  amountMinor: number;
  paymentType: string;
  paidAt: Date;
}

export interface DocumentPaymentPlan {
  /** Supply source id — the key documents are addressed by before they exist. */
  supplySourceId: string;
  /** What the document's `mark_paid` should contain, in a stable order. */
  payments: DocumentPayment[];
  /** The same thing with ledger identity attached, for `order_payment_application`. */
  entries: PaymentPlanEntry[];
  totalMinor: number;
}

export interface PaymentPlan {
  bySource: Map<string, DocumentPaymentPlan>;
  /** Money that could be placed nowhere. Always reported (§11). */
  unallocated: { shopifyTransactionId: string; amountMinor: number; reason: string }[];
  /**
   * Gateways with no MetaKocka payment type and no fallback.
   *
   * Never guessed at (§8.7). The order still gets its documents; the payment
   * waits for the merchant to map the gateway, and the exception says which.
   */
  unmappedGateways: string[];
  /** Sum of everything actually placed. The §24 invariant's left-hand side. */
  plannedTotalMinor: number;
}

/**
 * What every document of one order should say about payments.
 *
 * Deliberately keyed by **supply source**, not by document row, because the
 * plan has to exist before the documents do: the amount a document carries is
 * part of the body that creates it, and a create that omitted the payment would
 * need a follow-up update — which is the destructive call this app avoids.
 */
export async function planPayments(
  principal: Principal,
  input: {
    ledger: LedgerState;
    shares: DocumentShare[];
    /** Sources whose document this order no longer takes anything from. */
    retiredSourceIds: Set<string>;
    /** Existing count codes by source, for a stable allocation tiebreaker. */
    countCodeBySource: Map<string, string>;
    strategy: PaymentAllocationStrategy;
    entryMode: "per_transaction" | "aggregate";
    /**
     * The date to use for a receipt Shopify gave no `processed_at` for.
     *
     * The order's own date, injected rather than read from the clock. Without
     * it the epoch stands in, and a MetaKocka payment dated 01.01.1970 is a
     * book entry in the wrong financial year — the kind of wrong that is
     * accepted silently and found by an accountant.
     */
    fallbackPaidAt: Date;
  },
): Promise<PaymentPlan> {
  const receiptsRows = input.ledger.rows.filter((row) =>
    isSettledReceipt(toDomainTransaction(row)),
  );

  /* ---------------------------------------------------------------------- */
  /* Which MetaKocka payment type each receipt is                           */
  /* ---------------------------------------------------------------------- */

  /*
   * Resolved per transaction, not per order, because one order can be paid
   * partly by card and partly by transfer — a deposit online and a balance on
   * delivery — and those are different types in the merchant's register. The
   * order's `payment_gateway` column names only the first of them.
   */
  const unmappedGateways = new Set<string>();
  const typeByPayment = new Map<string, string>();

  for (const row of receiptsRows) {
    if (typeByPayment.has(row.id)) continue;

    // `settle` rather than `create`: a settled receipt is money that has
    // actually moved, including for cash on delivery, which the create-time
    // rule deliberately refuses to record in advance.
    const decision = await resolvePaymentType(principal, {
      gateway: row.gateway,
      phase: "settle",
    });

    if (decision.kind === "pay") {
      typeByPayment.set(row.id, decision.paymentType);
      continue;
    }

    unmappedGateways.add(row.gateway ?? "(no gateway)");
  }

  await recordPaymentTypes(
    [...typeByPayment.entries()].map(([orderPaymentId, paymentType]) => ({
      orderPaymentId,
      paymentType,
    })),
  );

  /* ---------------------------------------------------------------------- */
  /* Spreading them over the documents                                      */
  /* ---------------------------------------------------------------------- */

  const documents: PayableDocument[] = input.shares.map((share) => ({
    documentKey: share.sourceId,
    countCode: input.countCodeBySource.get(share.sourceId) ?? share.sourceCode,
    isPrimary: share.isPrimary,
    valueMinor: share.totalMinor,
    retired: input.retiredSourceIds.has(share.sourceId),
  }));

  // Only receipts whose type is known are placed. A gateway the merchant has
  // not mapped stops *its own* payment, not the whole order's.
  const placeable = receiptsRows.filter((row) => typeByPayment.has(row.id));

  const receipts: AllocatableReceipt[] = placeable.map((row) => ({
    shopifyTransactionId: row.shopifyTransactionId,
    amountMinor: row.amountMinor,
    gateway: row.gateway,
    processedAt: row.processedAt,
  }));

  const allocation = allocatePayments({
    documents,
    receipts,
    strategy: input.strategy,
  });

  /*
   * The assertion that makes this safe to run unattended.
   *
   * A bug in the split is money invented or lost in a merchant's ledger, and it
   * would be invisible on any single document — each one would look perfectly
   * reasonable. So the arithmetic is checked rather than trusted, and a failure
   * refuses to write anything rather than writing part of it.
   */
  const preserved = allocationPreservesReceipts({ receipts, result: allocation });
  if (!preserved.ok) {
    throw new Error(
      `Payment allocation did not preserve every receipt: ${preserved.drift
        .map(
          (entry) =>
            `${entry.shopifyTransactionId} expected ${entry.expected}, allocated ${entry.allocated}`,
        )
        .join("; ")}`,
    );
  }

  const rowByTransaction = new Map(
    placeable.map((row) => [row.shopifyTransactionId, row] as const),
  );

  const bySource = new Map<string, DocumentPaymentPlan>();

  // Every share gets a plan, including an empty one. An empty plan is
  // meaningful: it is what clears a payment from a document whose receipt has
  // moved elsewhere, and a source missing from this map would instead keep
  // whatever it had.
  for (const share of input.shares) {
    bySource.set(share.sourceId, {
      supplySourceId: share.sourceId,
      payments: [],
      entries: [],
      totalMinor: 0,
    });
  }

  const sorted = [...allocation.entries].sort(byTransactionThenDocument);

  for (const entry of sorted) {
    const plan = bySource.get(entry.documentKey);
    const row = rowByTransaction.get(entry.shopifyTransactionId);
    if (!plan || !row) continue;

    const paymentType = typeByPayment.get(row.id);
    if (!paymentType) continue;

    plan.entries.push({
      orderPaymentId: row.id,
      shopifyTransactionId: row.shopifyTransactionId,
      amountMinor: entry.amountMinor,
      paymentType,
      paidAt: row.processedAt ?? input.fallbackPaidAt,
    });
    plan.totalMinor += entry.amountMinor;
  }

  for (const plan of bySource.values()) {
    plan.payments =
      input.entryMode === "aggregate"
        ? aggregate(plan.entries)
        : plan.entries.map((entry) => ({
            paymentType: entry.paymentType,
            paidAt: entry.paidAt,
            amountMinor: entry.amountMinor,
          }));
  }

  return {
    bySource,
    unallocated: allocation.unallocated,
    unmappedGateways: [...unmappedGateways],
    plannedTotalMinor: [...bySource.values()].reduce(
      (total, plan) => total + plan.totalMinor,
      0,
    ),
  };
}

/**
 * Collapses a document's entries to one per payment type.
 *
 * The escape hatch for a MetaKocka company that will not take a multi-entry
 * `mark_paid`. It gives up *when* each part of the money arrived, which is a
 * real loss, and keeps the two things that cannot be given up: how much, and
 * under which payment type. Collapsing across types would file a bank transfer
 * as a card payment.
 *
 * Dated from the latest contributing receipt, because that is the day the
 * document became fully paid.
 */
function aggregate(entries: readonly PaymentPlanEntry[]): DocumentPayment[] {
  const byType = new Map<string, DocumentPayment>();

  for (const entry of entries) {
    const current = byType.get(entry.paymentType);
    if (!current) {
      byType.set(entry.paymentType, {
        paymentType: entry.paymentType,
        paidAt: entry.paidAt,
        amountMinor: entry.amountMinor,
      });
      continue;
    }
    current.amountMinor += entry.amountMinor;
    if (entry.paidAt.getTime() > current.paidAt.getTime()) {
      current.paidAt = entry.paidAt;
    }
  }

  return [...byType.values()].sort((a, b) =>
    a.paymentType < b.paymentType ? -1 : a.paymentType > b.paymentType ? 1 : 0,
  );
}

/**
 * A stable order for the `mark_paid` array.
 *
 * Not cosmetic. The array goes into the document body, and the body is compared
 * against the last one sent to decide whether anything needs writing — so an
 * unstable order would rewrite every document on every pass.
 */
function byTransactionThenDocument(a: AllocatedEntry, b: AllocatedEntry): number {
  const at = a.processedAt?.getTime() ?? 0;
  const bt = b.processedAt?.getTime() ?? 0;
  if (at !== bt) return at - bt;
  if (a.shopifyTransactionId !== b.shopifyTransactionId) {
    return a.shopifyTransactionId < b.shopifyTransactionId ? -1 : 1;
  }
  return a.documentKey < b.documentKey ? -1 : a.documentKey > b.documentKey ? 1 : 0;
}
