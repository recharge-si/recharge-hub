/**
 * Turning a desired MetaKocka state into the smallest set of changes that
 * reaches it (CLAUDE.md §8.4, §8.8).
 *
 * This is the diff step of the reconciliation loop, and it is pure so it can be
 * exhaustively tested without a database or an ERP. The caller has already
 * decided what MetaKocka *should* hold (`domain/orders/canonical`) and has read
 * what it *does* hold; this says what to do about the difference and, crucially,
 * what **not** to do:
 *
 *  - A source whose desired lines are unchanged produces no action at all. Ten
 *    reconciliations of an untouched order write nothing.
 *  - A source that already has a document is **updated**, never created again.
 *    This is the rule that stops one Shopify order becoming two sales orders
 *    when a line moves warehouse and back.
 *  - A source the order no longer takes anything from is **retired**, and
 *    retiring is a described action with a policy, not silence. Leaving the
 *    document alone is what left stale quantities in the ERP.
 *
 * Nothing here deletes anything. Whether a retired document may be emptied or
 * removed is the merchant's setting and the caller's call; this only names the
 * documents in that position and why.
 */

export interface DesiredDocumentLine {
  sku: string;
  quantity: number;
}

/**
 * The key of the one document an unsplit order has.
 *
 * A shop on `sales_order_split = single` writes one sales order for the whole
 * Shopify order and no warehouse mark on it, so there is no supply source to
 * key its document by — the stored row's `supply_source_id` is null, which is
 * exactly what it means: this document belongs to no warehouse.
 *
 * Null is not usable as a map key here, and it already means something else in
 * `ExistingDocument`: a row with no source under a *split* shop is a document
 * the order no longer takes anything from, which is retired. So the caller
 * substitutes this sentinel for null when — and only when — the shop is
 * unsplit, and everything below goes on treating a document key as a string.
 * Prefixed and bracketed so it can never collide with a cuid.
 */
export const WHOLE_ORDER_DOCUMENT = "[whole-order]";

export interface DesiredDocument {
  /** A supply source id, or `WHOLE_ORDER_DOCUMENT` for an unsplit shop. */
  supplySourceId: string;
  lines: DesiredDocumentLine[];
}

/** A MetaKocka document as this app currently records it. */
export interface ExistingDocument {
  documentId: string;
  supplySourceId: string | null;
  /**
   * What to call this document when telling somebody about it.
   *
   * The number MetaKocka holds it under — which is the app's internal claim key
   * only when the app chose the number. Nothing here looks a document *up* by
   * it: documents are addressed by `documentId` and grouped by supply source,
   * so this travels only into the actions and the messages they produce.
   */
  countCode: string;
  status: "pending" | "written" | "failed";
  /** Whether MetaKocka has actually acknowledged it with an id. */
  present: boolean;
  /** Whether a payment has been recorded against it. */
  paid: boolean;
  /** Whether it has already been retired by a previous pass. */
  retired: boolean;
  /** Lines this app last sent, so an unchanged source can be recognised. */
  lines: DesiredDocumentLine[];
}

export type DocumentAction =
  /** No document exists for this source; write one. */
  | { kind: "create"; supplySourceId: string; documentId: string | null }
  /** A document exists and its content has moved; replace it in place. */
  | {
      kind: "update";
      supplySourceId: string;
      documentId: string;
      countCode: string;
    }
  /** A document exists and already says exactly this. */
  | {
      kind: "unchanged";
      supplySourceId: string;
      documentId: string;
      countCode: string;
    }
  /**
   * A document for a source the order no longer takes anything from.
   *
   * `paid` and `present` travel with it because they decide what the caller is
   * allowed to do: an unpaid document that MetaKocka has never acknowledged can
   * simply be dropped, while a paid one is an accounting record.
   */
  | {
      kind: "retire";
      supplySourceId: string | null;
      documentId: string;
      countCode: string;
      paid: boolean;
      present: boolean;
    };

/** Sorted and summed, so two descriptions of the same content compare equal. */
function normaliseLines(
  lines: readonly DesiredDocumentLine[],
): DesiredDocumentLine[] {
  const totals = new Map<string, number>();
  for (const line of lines) {
    if (line.quantity <= 0) continue;
    totals.set(line.sku, (totals.get(line.sku) ?? 0) + line.quantity);
  }
  return [...totals.entries()]
    .map(([sku, quantity]) => ({ sku, quantity }))
    .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
}

export function sameLines(
  a: readonly DesiredDocumentLine[],
  b: readonly DesiredDocumentLine[],
): boolean {
  const left = normaliseLines(a);
  const right = normaliseLines(b);
  if (left.length !== right.length) return false;
  return left.every((line, index) => {
    const other = right[index]!;
    return line.sku === other.sku && line.quantity === other.quantity;
  });
}

/**
 * The plan.
 *
 * Deterministic in every respect — the actions come out in a stable order and
 * the same inputs always produce the same list — because the caller logs it as
 * the audit trail of the run and a merchant comparing two runs of an unchanged
 * order should see two identical plans.
 */
export function planDocuments(input: {
  desired: readonly DesiredDocument[];
  existing: readonly ExistingDocument[];
}): DocumentAction[] {
  const actions: DocumentAction[] = [];

  const existingBySource = new Map<string, ExistingDocument>();
  for (const document of input.existing) {
    if (!document.supplySourceId) continue;
    // A source can only have one document; if history left more than one, the
    // written one is authoritative and the rest are retired below.
    const current = existingBySource.get(document.supplySourceId);
    if (!current || (document.status === "written" && current.status !== "written")) {
      existingBySource.set(document.supplySourceId, document);
    }
  }

  const desiredSources = new Set(
    input.desired.map((document) => document.supplySourceId),
  );

  const ordered = [...input.desired].sort((a, b) =>
    a.supplySourceId < b.supplySourceId
      ? -1
      : a.supplySourceId > b.supplySourceId
        ? 1
        : 0,
  );

  for (const document of ordered) {
    const existing = existingBySource.get(document.supplySourceId);

    /*
     * No usable document yet.
     *
     * `failed` and `pending` both land here: neither is a document MetaKocka is
     * known to hold, and the write path's own claim protocol decides whether
     * that means "send" or "look first" (§8.4). Handing the existing row's id
     * along matters — the claim is on that row, and losing it would invite a
     * second `count_code`.
     */
    if (!existing || !existing.present) {
      actions.push({
        kind: "create",
        supplySourceId: document.supplySourceId,
        documentId: existing?.documentId ?? null,
      });
      continue;
    }

    /*
     * A previously retired document whose source is wanted again.
     *
     * A line that moved to another warehouse and back. The document is revived
     * by updating it rather than by writing a second one — which is the whole
     * point of keeping the row instead of deleting it.
     */
    if (existing.retired || !sameLines(existing.lines, document.lines)) {
      actions.push({
        kind: "update",
        supplySourceId: document.supplySourceId,
        documentId: existing.documentId,
        countCode: existing.countCode,
      });
      continue;
    }

    actions.push({
      kind: "unchanged",
      supplySourceId: document.supplySourceId,
      documentId: existing.documentId,
      countCode: existing.countCode,
    });
  }

  const retiring = input.existing
    .filter(
      (document) =>
        !document.supplySourceId ||
        !desiredSources.has(document.supplySourceId),
    )
    .sort((a, b) => (a.countCode < b.countCode ? -1 : a.countCode > b.countCode ? 1 : 0));

  for (const document of retiring) {
    actions.push({
      kind: "retire",
      supplySourceId: document.supplySourceId,
      documentId: document.documentId,
      countCode: document.countCode,
      paid: document.paid,
      present: document.present,
    });
  }

  return actions;
}

/**
 * What the caller is allowed to do with a document the order has left behind.
 *
 * §8.8's absolute rule is that a MetaKocka document is never deleted
 * automatically, because it may already be invoiced and deleting it destroys an
 * accounting record. But leaving it untouched leaves *quantities* behind, which
 * breaks the order's central invariant — so the middle answer is to reconcile
 * it down to nothing it should not hold, and to say so loudly when that is not
 * possible.
 */
export type ObsoleteDocumentPolicy =
  /** Never touch it. Flag it and let a person decide. The cautious original. */
  | "report"
  /**
   * Rewrite it with no Shopify-linked lines, so it stops carrying quantity, and
   * report it. The default: it keeps the document, its number and its history,
   * and removes the goods the order no longer takes from there.
   */
  | "empty"
  /**
   * Delete it, but **only** when it has no payment recorded against it. A paid
   * document falls back to `empty`. For merchants who invoice separately and
   * want no orphan sales orders in the ERP at all.
   */
  | "delete_unpaid";

export type RetirementPlan =
  /** Nothing was ever written; drop the local row and say nothing. */
  | { kind: "discard"; reason: string }
  /** Empty it in MetaKocka, then flag it. */
  | { kind: "empty"; reason: string }
  /** Delete it in MetaKocka. */
  | { kind: "delete"; reason: string }
  /** Touch nothing; raise the exception that names it. */
  | { kind: "report"; reason: string };

export function retirementPlanFor(
  action: Extract<DocumentAction, { kind: "retire" }>,
  policy: ObsoleteDocumentPolicy,
): RetirementPlan {
  if (!action.present) {
    return {
      kind: "discard",
      reason:
        "nothing was ever written to MetaKocka for this supply source, so there is nothing there to reconcile",
    };
  }

  if (policy === "report") {
    return {
      kind: "report",
      reason:
        "emptying obsolete documents is turned off, so the document was left exactly as it is",
    };
  }

  if (policy === "delete_unpaid" && !action.paid) {
    return {
      kind: "delete",
      reason:
        "the document carries no payment and this order no longer takes anything from that warehouse",
    };
  }

  /*
   * A paid document under `delete_unpaid` deliberately falls through to
   * emptying rather than to deleting. A payment is the strongest signal
   * available that the document has been through the merchant's books, and the
   * setting the merchant chose says "delete the *unpaid* ones".
   */
  return {
    kind: "empty",
    reason: action.paid
      ? "the document carries a payment, so it is emptied rather than deleted and left for you to credit"
      : "this order no longer takes anything from that warehouse",
  };
}
