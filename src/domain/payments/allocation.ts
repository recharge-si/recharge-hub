/**
 * Dividing one Shopify order's payments across its MetaKocka documents
 * (CLAUDE.md §8.6, §8.7).
 *
 * The failure this module exists to prevent is stated as a rule and is worth
 * repeating as arithmetic. A Shopify order of 300 split into a 100 document and
 * a 200 document, paid once for 300, must not become two documents each
 * recording 300. That is 600 in the merchant's books for 300 of trade, and
 * nothing downstream would ever notice, because each document on its own looks
 * perfectly reasonable.
 *
 * **Payments belong to the Shopify order. Documents are a physical
 * subdivision of it.** So the ledger is kept whole at order level and *shares*
 * of it are projected onto documents, exactly as `domain/money/split` projects
 * the order's value. The two must agree, and they do: this weights by the same
 * `DocumentShare.totalMinor` the document writer builds from.
 *
 * Every function is pure (§5) and every amount is integer minor units (§15).
 */

import { proportionalSplit } from "~/domain/money/split";
import { compareCodepoints } from "~/domain/types";

/**
 * A document, as far as payment allocation is concerned.
 *
 * `valueMinor` is what the document is worth — the share the money split gave
 * it — not what has been paid against it.
 */
export interface PayableDocument {
  /**
   * Whatever stable value identifies this document to the caller.
   *
   * The supply source id in practice, not the `metakocka_document` row id, and
   * that is deliberate: allocation has to happen *before* the documents of a
   * new order exist, because the amount a document will carry is part of the
   * body that creates it. A supply source is the thing that exists at both
   * moments.
   */
  documentKey: string;
  /** Stable tiebreaker, so a re-run allocates identically. */
  countCode: string;
  isPrimary: boolean;
  valueMinor: number;
  /**
   * A document this order no longer takes anything from.
   *
   * Retired documents are excluded from allocation entirely. Paying one is how
   * a split that moved warehouse once gets paid twice: the money would be
   * recorded against a document describing goods this order does not contain,
   * on top of the document that does.
   */
  retired: boolean;
}

/** One receipt to distribute. Refunds are deliberately not allocated — see below. */
export interface AllocatableReceipt {
  shopifyTransactionId: string;
  amountMinor: number;
  gateway: string | null;
  processedAt: Date | null;
}

/**
 * How a payment is spread over the documents of a split order.
 *
 * Both are defensible and which is right depends on how the merchant invoices,
 * so it is a setting rather than a decision this app makes for them.
 */
export type PaymentAllocationStrategy =
  /**
   * Each receipt is divided across documents in proportion to what each is
   * worth. The default: every document's payment then matches its own value,
   * which is what an accountant reading one document in isolation expects.
   */
  | "proportional"
  /**
   * Every receipt goes on the one primary document. For merchants who treat the
   * non-primary documents as picking papers and settle the order in one place.
   */
  | "primary";

export interface AllocatedEntry {
  documentKey: string;
  shopifyTransactionId: string;
  amountMinor: number;
  gateway: string | null;
  processedAt: Date | null;
}

export interface AllocationResult {
  entries: AllocatedEntry[];
  /**
   * Receipts that could not be placed on any document, with the reason.
   *
   * Never silently dropped: money arriving for an order whose documents have
   * all been retired is precisely the situation a person must be told about
   * (§11), and it is the situation that used to end in the payment being
   * recorded against a document that no longer described the order.
   */
  unallocated: { shopifyTransactionId: string; amountMinor: number; reason: string }[];
}

/**
 * Picks the document a remainder — and, under `primary`, everything — lands on.
 *
 * Falls back to the highest-value document and then to the count code so the
 * answer is stable even for an order whose primary flag has not been written
 * yet. Stability is the point: an unstable choice moves cents between documents
 * on every reconciliation, and each move rewrites an ERP document.
 */
function primaryOf(documents: PayableDocument[]): PayableDocument | null {
  if (documents.length === 0) return null;

  let best = documents[0]!;
  for (const candidate of documents.slice(1)) {
    if (candidate.isPrimary !== best.isPrimary) {
      if (candidate.isPrimary) best = candidate;
      continue;
    }
    if (candidate.valueMinor !== best.valueMinor) {
      if (candidate.valueMinor > best.valueMinor) best = candidate;
      continue;
    }
    if (compareCodepoints(candidate.countCode, best.countCode) < 0) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Spreads every receipt across the live documents.
 *
 * The invariant, asserted in tests: for each receipt, the amounts allocated
 * from it sum to exactly its amount. Never more — that is the doubled-payment
 * bug — and never less, which would understate what the merchant received.
 *
 * Refunds are not allocated here and that is deliberate, not an omission. §8.8
 * and the verification record are clear that a MetaKocka sales order's payment
 * is replaced rather than adjusted, and reducing a recorded receipt to
 * represent a refund destroys the record of what was received. A refund is a
 * credit note in MetaKocka; the ledger keeps its history and the connector
 * reports it (`refund_received`).
 */
export function allocatePayments(input: {
  documents: readonly PayableDocument[];
  receipts: readonly AllocatableReceipt[];
  strategy: PaymentAllocationStrategy;
}): AllocationResult {
  const live = input.documents.filter((document) => !document.retired);
  const entries: AllocatedEntry[] = [];
  const unallocated: AllocationResult["unallocated"] = [];

  if (live.length === 0) {
    return {
      entries,
      unallocated: input.receipts.map((receipt) => ({
        shopifyTransactionId: receipt.shopifyTransactionId,
        amountMinor: receipt.amountMinor,
        reason:
          "this order has no MetaKocka document that still describes any of it",
      })),
    };
  }

  // Sorted so the weights, the remainder and therefore every cent are the same
  // on every run for the same inputs.
  const ordered = [...live].sort((a, b) =>
    compareCodepoints(a.countCode, b.countCode),
  );
  const primary = primaryOf(ordered);

  for (const receipt of input.receipts) {
    if (receipt.amountMinor === 0) continue;

    if (input.strategy === "primary" || ordered.length === 1) {
      const target = primary ?? ordered[0]!;
      entries.push({
        documentKey: target.documentKey,
        shopifyTransactionId: receipt.shopifyTransactionId,
        amountMinor: receipt.amountMinor,
        gateway: receipt.gateway,
        processedAt: receipt.processedAt,
      });
      continue;
    }

    const weights = ordered.map((document) => Math.max(0, document.valueMinor));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

    /*
     * Every document is worth nothing, and money has still arrived.
     *
     * A fully discounted order paid for its shipping, for instance. Splitting
     * by zero weights would put the whole receipt on the first document by
     * accident of ordering, so the primary takes it deliberately instead.
     */
    if (totalWeight === 0) {
      const target = primary ?? ordered[0]!;
      entries.push({
        documentKey: target.documentKey,
        shopifyTransactionId: receipt.shopifyTransactionId,
        amountMinor: receipt.amountMinor,
        gateway: receipt.gateway,
        processedAt: receipt.processedAt,
      });
      continue;
    }

    const split = proportionalSplit(receipt.amountMinor, weights);

    ordered.forEach((document, index) => {
      const amountMinor = split[index] ?? 0;
      if (amountMinor === 0) return;
      entries.push({
        documentKey: document.documentKey,
        shopifyTransactionId: receipt.shopifyTransactionId,
        amountMinor,
        gateway: receipt.gateway,
        processedAt: receipt.processedAt,
      });
    });
  }

  return { entries, unallocated };
}

/**
 * What one document's allocated entries add up to.
 *
 * Used by the verification pass, which compares it against what MetaKocka is
 * being told and against the document's own value.
 */
export function allocatedTotalFor(
  entries: readonly AllocatedEntry[],
  documentKey: string,
): number {
  return entries
    .filter((entry) => entry.documentKey === documentKey)
    .reduce((sum, entry) => sum + entry.amountMinor, 0);
}

/**
 * Whether an allocation preserved every receipt exactly.
 *
 * The one assertion that makes the multi-document payment path safe, checked at
 * runtime rather than only in tests: a bug here is money invented or lost in a
 * merchant's ledger, and it would be invisible on any single document.
 */
export function allocationPreservesReceipts(input: {
  receipts: readonly AllocatableReceipt[];
  result: AllocationResult;
}): { ok: boolean; drift: { shopifyTransactionId: string; expected: number; allocated: number }[] } {
  const allocated = new Map<string, number>();
  for (const entry of input.result.entries) {
    allocated.set(
      entry.shopifyTransactionId,
      (allocated.get(entry.shopifyTransactionId) ?? 0) + entry.amountMinor,
    );
  }
  const unplaced = new Set(
    input.result.unallocated.map((entry) => entry.shopifyTransactionId),
  );

  const drift = input.receipts
    .filter((receipt) => !unplaced.has(receipt.shopifyTransactionId))
    .map((receipt) => ({
      shopifyTransactionId: receipt.shopifyTransactionId,
      expected: receipt.amountMinor,
      allocated: allocated.get(receipt.shopifyTransactionId) ?? 0,
    }))
    .filter((entry) => entry.expected !== entry.allocated);

  return { ok: drift.length === 0, drift };
}
