import type { Job } from "pg-boss";
import { z } from "zod";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { raiseException } from "~/adapters/db/repositories/exception.server";
import {
  applyOrderSync,
  getOrderState,
  saveIncomingOrder,
  snapshotOf,
  touchOrderSync,
} from "~/adapters/db/repositories/order.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { redriveOrder } from "~/adapters/queue/redrive.server";
import { parseOrder, toSnapshot } from "~/adapters/shopify/order-payload";
import { fetchOrderById } from "~/adapters/shopify/orders";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import { getSalesOrderSettings } from "~/adapters/db/repositories/sales-order-setting.server";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  contentChangePolicy,
  diffOrder,
  paymentActionFor,
} from "~/domain/orders/state";
import { serviceToken, type Principal } from "~/domain/types";

/**
 * Everything that happens to an order after it arrives (CLAUDE.md §8.7, §8.8).
 *
 * The app used to hear `orders/create` and nothing else. An order that came in
 * unpaid — every bank transfer, every cash on delivery, every manual payment —
 * was written to MetaKocka unpaid and stayed that way, because the moment it
 * was paid produced no webhook this app was subscribed to. Editing an order
 * after it was sent was equally invisible: the ERP kept describing an order
 * that no longer existed and nobody was told.
 *
 * This handler is the ear for all of it. It is fed from three places, and
 * deliberately does the same thing whichever one it came from:
 *
 *  - `orders/updated`, which Shopify sends for essentially every change;
 *  - `orders/paid`, which is redundant with the above and kept precisely
 *    because it is — two independent signals for the one event that moves
 *    money;
 *  - the reconciler (`reconcile-orders`), which re-reads orders from the Admin
 *    API because webhooks are best-effort and an app that is down for an
 *    afternoon never hears what happened in it.
 *
 * Three rules make it safe to run at any time, in any order, as often as it
 * likes:
 *
 *  1. **Nothing is done for a change that did not happen.** The diff is
 *     computed against what this app holds, so a tag being added — which sends
 *     the same `orders/updated` as a refund — costs one comparison.
 *  2. **An older update never overwrites a newer one.** Shopify does not
 *     promise webhook ordering, and the reconciler re-reads orders the webhooks
 *     already delivered, so `shopify_updated_at` is a high-water mark.
 *  3. **Nothing that reached MetaKocka is rewritten here.** Once a document
 *     exists, a changed order is an exception for a human, not an automatic
 *     correction (`contentChangePolicy`) — the document may already be invoiced.
 */

export const syncOrderStateJobSchema = z.object({
  shopDomain: z.string().min(1),
  topic: z.string().optional(),
  /** The order as Shopify sent it, when the webhook carried one. */
  payload: z.unknown().optional(),
  /**
   * Read the order from the Admin API instead.
   *
   * For the topics whose payload is not an order — `orders/edited` describes an
   * edit, `refunds/create` describes a refund — and for the order page's own
   * "Check with Shopify" button. The event says *that* something happened; the
   * read says what the order is now.
   */
  shopifyOrderId: z.string().optional(),
});

export type SyncSource = "webhook" | "reconciler" | "manual";

export interface SyncOutcome {
  /** What happened, for the log and for the merchant-facing action result. */
  result: "ingested" | "unchanged" | "updated" | "stale" | "deleted";
  orderId: string | null;
  changes: string[];
}

/**
 * Applies one Shopify view of an order.
 *
 * Exported and called directly by the reconciler rather than through the queue:
 * a nightly pass over a busy store would otherwise enqueue thousands of jobs to
 * discover that nothing had changed.
 */
export async function syncOrderState(
  principal: Principal,
  rawPayload: unknown,
  options: { source: SyncSource; now?: Date },
): Promise<SyncOutcome> {
  const log = getLogger();
  const now = options.now ?? new Date();

  const parsed = parseOrder(rawPayload);
  const existing = await getOrderState(principal, parsed.shopifyOrderId);

  /*
   * An order this app has never seen.
   *
   * From the reconciler this is the interesting case: it means `orders/create`
   * was never delivered, or was delivered while the app was down, and without
   * this the order would simply never exist here. Ingesting it puts it through
   * the same path a webhook would have — written and allocated in one
   * transaction (§8.1).
   */
  if (!existing) {
    const { orderId, created } = await saveIncomingOrder(
      principal,
      parsed,
      rawPayload,
    );

    if (created) {
      await appendEvent(principal, {
        entityType: "order",
        entityId: orderId,
        event: "order.received",
        detail: {
          orderNumber: parsed.orderNumber,
          lines: parsed.lines.length,
          totalMinor: parsed.totalMinor,
          currency: parsed.currency,
          financialStatus: parsed.financialStatus,
          // Worth having in the trail: an order that arrived this way is one
          // the webhook never delivered.
          via: options.source,
        },
      });

      log.info(
        { shop: principal.shopDomain, orderId, source: options.source },
        "Order recovered that no webhook delivered",
      );
    }

    return { result: "ingested", orderId, changes: [] };
  }

  // Deleted in Shopify: hidden here, kept in MetaKocka (§8.8). Nothing further
  // is applied, because there is no longer an order in Shopify to be in step
  // with.
  if (existing.shopifyDeletedAt) {
    return { result: "deleted", orderId: existing.id, changes: [] };
  }

  /*
   * An update older than the one already applied.
   *
   * Shopify does not promise webhooks arrive in the order the changes happened,
   * and the reconciler deliberately re-reads with a few minutes of overlap. So
   * a payload that describes an older version of the order is discarded rather
   * than allowed to undo a newer one — which, before the high-water mark
   * existed, is exactly how an order could flip back to unpaid.
   */
  if (
    parsed.updatedAt &&
    existing.shopifyUpdatedAt &&
    parsed.updatedAt.getTime() < existing.shopifyUpdatedAt.getTime()
  ) {
    log.info(
      {
        shop: principal.shopDomain,
        orderId: existing.id,
        seen: parsed.updatedAt,
        applied: existing.shopifyUpdatedAt,
      },
      "Ignored an order update older than the one already applied",
    );
    return { result: "stale", orderId: existing.id, changes: [] };
  }

  const diff = diffOrder(snapshotOf(existing), toSnapshot(parsed));

  const written = existing.documents.filter((doc) => doc.status === "written");
  const salesOrderSettings = await getSalesOrderSettings(principal);
  const policy = contentChangePolicy({
    contentChanged: diff.contentChanged,
    writtenDocuments: written.length,
    updatesAllowed: salesOrderSettings.updateOnChange,
  });

  /*
   * Whether the money is already recorded in MetaKocka.
   *
   * With no document written, the answer is no — and that is not a gap: the
   * order's financial status is about to be updated, and the document writer
   * reads it when it builds the sales order, so the payment travels in the
   * create (§8.7). Only an order that has *already* been written needs a
   * separate payment call.
   */
  const alreadyMarkedPaid =
    written.length > 0 && written.every((doc) => doc.paymentMarkedAt !== null);

  const payment = paymentActionFor(
    diff.financialStatusFrom,
    diff.financialStatusTo,
    { alreadyMarkedPaid },
  );

  /*
   * A payment still to record, whether or not anything changed this time.
   *
   * Deliberately not gated on `diff.paymentChanged`. An order can be paid in
   * this app's own database and unpaid in the ERP — the payment job failed, the
   * worker was restarted mid-write, MetaKocka was down — and gating on the
   * change would mean the only chance to notice it had already passed. This way
   * every reconciliation pass is another chance, and the claim plus
   * `payment_marked_at` make the passes that find nothing free.
   */
  const shouldSettle = payment.kind === "mark_paid" && written.length > 0;

  if (!diff.changed && !shouldSettle) {
    /*
     * Nothing to act on, but the payload is stored anyway.
     *
     * `raw_payload` is Shopify's whole record, not a copy of the diff's inputs,
     * and it is what the document writer, the partner resolver and the tax
     * re-derivation all read. Throwing away a newer one because nothing
     * *actionable* moved is how a field outside the diff goes stale for good.
     */
    await touchOrderSync(
      principal,
      existing.id,
      now,
      parsed.updatedAt,
      rawPayload,
    );
    return { result: "unchanged", orderId: existing.id, changes: [] };
  }

  await applyOrderSync(principal, existing.id, {
    parsed,
    rawPayload,
    /*
     * The lines follow Shopify whenever the document is going to follow it too.
     *
     * With `resend` the ERP is about to be brought in step, so the order rows
     * should describe the order rather than a superseded version of it — and
     * nothing is lost from the trail either way: `metakocka_document.request_body`
     * keeps the exact document that was sent each time.
     */
    replaceLines: policy.kind === "reallocate" || policy.kind === "resend",
    diverged: policy.kind === "diverged",
    status: diff.cancelledNow ? "cancelled" : null,
    now,
  });

  if (diff.changed) {
    await appendEvent(principal, {
      entityType: "order",
      entityId: existing.id,
      event: "order.updated_in_shopify",
      detail: {
        source: options.source,
        changes: diff.summary,
        financialStatus: diff.financialStatusTo,
        contentChanged: diff.contentChanged,
        documentsWritten: written.length,
      },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* The order was cancelled                                                */
  /* ---------------------------------------------------------------------- */

  if (diff.cancelledNow) {
    const held =
      written.length === 0
        ? "Nothing has been sent to MetaKocka for this order."
        : `MetaKocka holds ${written.length === 1 ? "a document" : `${written.length} documents`} for this order (${written.map((doc) => doc.countCode).join(", ")}). It may already be invoiced, so nothing is deleted automatically.`;

    await raiseException(principal, {
      orderId: existing.id,
      kind: "order_cancelled",
      message: `Order ${existing.shopifyOrderNumber} was cancelled in Shopify. ${held} Cancel or credit it in MetaKocka by hand, then resolve this.`,
      detail: { source: options.source },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* The order's content moved                                              */
  /* ---------------------------------------------------------------------- */

  if (policy.kind === "diverged") {
    await raiseException(principal, {
      orderId: existing.id,
      kind: "order_diverged",
      message: `Order ${existing.shopifyOrderNumber} changed in Shopify after it was sent to MetaKocka, so the ${written.length === 1 ? "document" : "documents"} there (${written.map((doc) => doc.countCode).join(", ")}) no longer match it. ${diff.summary.join(" ")} Nothing was changed automatically, because the document may already be invoiced. Correct it in MetaKocka, then use "Mark as sorted in MetaKocka" on the order page to stop this being reported again.`,
      detail: {
        changes: diff.summary,
        countCodes: written.map((doc) => doc.countCode),
      },
    });
  }

  /*
   * The customer arrived, and there is nothing to allocate again.
   *
   * An order that was refused for having no partner has everything else
   * already decided — lines, sources, quantities. What it was waiting for was
   * somebody in Shopify, and now there is one, so the useful thing is to send
   * it rather than to re-run a decision that was never the problem.
   */
  if (diff.partyArrived && policy.kind !== "diverged") {
    // Through the shared re-drive, which knows the write job needs one job per
    // supply source (§8.4) and falls back to allocating when there are none.
    await redriveOrder(principal, existing.id, "write");
  }

  if (policy.kind === "resend") {
    /*
     * Allocate again, then send again.
     *
     * Allocation comes first because a quantity change can move a line to a
     * different source — five units where the own warehouse has three is a
     * different split from four. The writes that follow update the documents
     * that already exist rather than creating new ones, so the `count_code`
     * guard is never in play (§8.4).
     */
    await enqueue(
      QUEUES.allocateOrder,
      { shopDomain: principal.shopDomain, orderId: existing.id },
      {
        singletonKey: `allocate:${existing.id}:${parsed.updatedAt?.getTime() ?? now.getTime()}`,
      },
    );

    await appendEvent(principal, {
      entityType: "order",
      entityId: existing.id,
      event: "order.resending_after_edit",
      detail: { changes: diff.summary, documents: written.length },
    });
  }

  if (policy.kind === "reallocate") {
    /*
     * Nothing has reached MetaKocka, so an edit is simply what the order is.
     * The lines have already been rewritten above; allocating again decides the
     * sources for the new quantities and re-queues the writes.
     *
     * The singleton key carries the version, so a second edit is a second run
     * rather than being collapsed into the first one's pending job.
     */
    await enqueue(
      QUEUES.allocateOrder,
      { shopDomain: principal.shopDomain, orderId: existing.id },
      {
        singletonKey: `allocate:${existing.id}:${parsed.updatedAt?.getTime() ?? now.getTime()}`,
      },
    );

    await appendEvent(principal, {
      entityType: "order",
      entityId: existing.id,
      event: "order.reallocating_after_edit",
      detail: { changes: diff.summary },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* The payment moved                                                      */
  /* ---------------------------------------------------------------------- */

  if (shouldSettle) {
    await enqueue(
      QUEUES.markMetakockaPaid,
      { shopDomain: principal.shopDomain, orderId: existing.id },
      { singletonKey: `paid:${existing.id}` },
    );
  }

  /*
   * Exceptions only on an actual change.
   *
   * `raiseException` dedupes against the *open* exception of the same kind, so
   * raising on every pass would be harmless while one is open — and would
   * quietly reopen the one the merchant resolved last week the next time the
   * reconciler read a refunded order. A payment state that has not moved is not
   * news.
   */
  if (payment.kind === "exception" && diff.paymentChanged) {
    await raiseException(principal, {
      orderId: existing.id,
      kind: payment.exception,
      message: payment.message,
      detail: {
        from: diff.financialStatusFrom,
        to: diff.financialStatusTo,
        countCodes: written.map((doc) => doc.countCode),
      },
    });
  }

  log.info(
    {
      shop: principal.shopDomain,
      orderId: existing.id,
      source: options.source,
      changes: diff.summary.length,
      policy: policy.kind,
      payment: payment.kind,
    },
    "Order state synced",
  );

  return { result: "updated", orderId: existing.id, changes: diff.summary };
}

/** The queue entry point. Everything real happens in `syncOrderState`. */
export async function handleSyncOrderState(job: Job<unknown>): Promise<void> {
  const { shopDomain, topic, payload, shopifyOrderId } =
    syncOrderStateJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "sync-order-state");
  const log = getLogger();

  let order = payload;

  if (order === undefined) {
    if (!shopifyOrderId) return;

    const { admin } = await unauthenticated.admin(shopDomain);
    order = await fetchOrderById(admin, shopifyOrderId);

    // Shopify no longer has it. `orders/delete` handles that case and leaves
    // the MetaKocka document alone; there is nothing to compare against here.
    if (!order) {
      log.info(
        { shop: shopDomain, topic, shopifyOrderId },
        "Order no longer exists in Shopify, nothing to sync",
      );
      return;
    }
  }

  const outcome = await syncOrderState(principal, order, {
    source: payload === undefined ? "manual" : "webhook",
  });

  log.info(
    {
      shop: shopDomain,
      topic,
      result: outcome.result,
      orderId: outcome.orderId,
    },
    "Order state applied",
  );
}
