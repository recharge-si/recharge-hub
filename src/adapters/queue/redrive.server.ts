import type { ExceptionKind } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import type { Principal } from "~/domain/types";

/**
 * Re-driving the work behind an order, from wherever the request comes from.
 *
 * "Retry" used to mean one thing — re-queue the allocation — whatever had
 * actually gone wrong. For an order MetaKocka rejected over a missing address
 * that is not a retry at all: allocation was never the problem, so it succeeds
 * instantly, the write fails again the same way, and the merchant watches a
 * button do nothing. That is the bug this module exists to remove.
 *
 * Shared by the exceptions page, the order page and the background re-check, so
 * a retry means the same thing in all three and there is one place to be right
 * about which job answers which problem.
 */

export type RedriveTarget =
  /** Decide where the order is stuck from its own state. */
  | "auto"
  /**
   * There is nothing to re-drive, and saying so is the honest answer.
   *
   * For the exceptions that describe something a person did in the ERP: this
   * app cannot undo it, and pretending a button will is worse than the button
   * not being there.
   */
  | "none"
  /** Choose sources again, from scratch. */
  | "allocate"
  /** Send the sales orders. */
  | "write"
  /** Record the payment against documents MetaKocka already holds. */
  | "payment"
  /** Ask Shopify what the order is now. */
  | "refresh";

/**
 * Which job answers which problem.
 *
 * The mapping is about the *blocker*, not about where in the pipeline the order
 * happens to be sitting. A rejected profit centre and an unknown warehouse both
 * stop the write and neither is helped by allocating again.
 */
export const TARGET_FOR_KIND: Record<ExceptionKind, RedriveTarget> = {
  insufficient_stock: "allocate",
  sku_not_in_metakocka: "write",
  profit_center_rejected: "write",
  warehouse_invalid: "write",
  tax_undeterminable: "write",
  metakocka_write_failed: "write",
  unmapped_payment_gateway: "auto",
  payment_write_failed: "payment",
  partially_paid: "refresh",
  voided_payment: "refresh",
  refund_received: "refresh",
  order_cancelled: "refresh",
  // Both mean Shopify has moved on from what MetaKocka holds, so the useful
  // thing is to find out what it says now rather than to send anything.
  order_edited: "refresh",
  order_diverged: "refresh",
  fulfillment_split_failed: "allocate",
  /*
   * Stock, not an order. There is nothing order-shaped to re-drive: the sync
   * runs every five minutes on its own and will clear this the moment it
   * works. Pressing a button would only make the merchant think they had done
   * something.
   */
  stock_sync_failed: "none",
  /*
   * Deleted in MetaKocka. Writing it again is the right answer and it works,
   * because the poller marks the row failed when it finds the document gone —
   * which is what lets the `count_code` claim be taken a second time (§8.4).
   */
  metakocka_document_missing: "write",
  /*
   * Edited in MetaKocka. Nothing here can put that right: the document exists,
   * it may already be invoiced, and sending another would make two.
   */
  metakocka_document_changed: "none",
  /*
   * A dead-lettered job. Where the work was about an order, its own state says
   * which step to re-drive; a queue-level job (a sync, a reload) is re-run
   * from its page rather than from here.
   */
  job_failed: "auto",
};

export interface RedriveResult {
  /** What was queued, in the merchant's words. Empty means nothing to do. */
  queued: string[];
  /** Why nothing was queued, when nothing was. */
  reason: string | null;
}

/**
 * Queues whatever will move this order forward.
 *
 * Every job it can queue is idempotent by its own guard — the `count_code`
 * claim for a write (§8.4), the per-document payment claim (§8.7), a full
 * replacement for an allocation — so pressing the button twice costs nothing.
 */
export async function redriveOrder(
  principal: Principal,
  orderId: string,
  target: RedriveTarget = "auto",
  options: {
    /**
     * Who is asking. A person re-allocating is allowed to overrule a
     * hand-made allocation — that is them changing their mind. The
     * background re-check is not a person, and must never quietly revert a
     * choice someone made by hand.
     */
    actor?: "person" | "background";
  } = {},
): Promise<RedriveResult> {
  const actor = options.actor ?? "person";
  const shopDomain = principal.shopDomain;

  const order = await prisma.order.findFirst({
    where: { id: orderId, shop: { domain: shopDomain } },
    select: {
      id: true,
      shopifyOrderId: true,
      financialStatus: true,
      allocationLockedAt: true,
      lines: {
        select: {
          allocations: { select: { supplySourceId: true } },
        },
      },
      documents: {
        select: { status: true, supplySourceId: true, paymentMarkedAt: true },
      },
    },
  });

  if (!order) return { queued: [], reason: "That order no longer exists." };

  const sourceIds = [
    ...new Set(
      order.lines.flatMap((line) =>
        line.allocations
          .map((allocation) => allocation.supplySourceId)
          .filter((id): id is string => id !== null),
      ),
    ),
  ];

  const written = order.documents.filter((doc) => doc.status === "written");
  const unpaid = written.filter((doc) => doc.paymentMarkedAt === null);

  /*
   * Where is this order actually stuck?
   *
   * Read from the state rather than from the exception, so it stays right for
   * an order whose exception was raised hours ago and whose situation has moved
   * on since.
   */
  let chosen: RedriveTarget = target;
  if (target === "auto") {
    if (sourceIds.length === 0) chosen = "allocate";
    else if (written.length < sourceIds.length) chosen = "write";
    else if (order.financialStatus === "paid" && unpaid.length > 0)
      chosen = "payment";
    else chosen = "refresh";
  }

  if (chosen === "none") {
    return {
      queued: [],
      reason:
        "There is nothing this app can retry for that. The document is in MetaKocka and only somebody looking at it there can decide what it should say.",
    };
  }

  // Distinct per press. Without it a second attempt collapses into the pending
  // job from the first and the button genuinely does nothing.
  const stamp = Date.now();
  const queued: string[] = [];

  if (chosen === "allocate") {
    /*
     * Allocating on purpose clears a hand-made choice.
     *
     * The lock exists to stop background jobs quietly reverting a decision a
     * person made. Someone asking for allocation again is that person changing
     * their mind, which is a different thing — and the fifteen-minute
     * re-check is not someone. It respects the lock and says so.
     */
    if (order.allocationLockedAt) {
      if (actor !== "person") {
        return {
          queued: [],
          reason:
            "The supply sources for this order were chosen by hand, and the automatic re-check does not overrule that. Re-allocate from the order page if you want the choice made again.",
        };
      }
      await prisma.order.update({
        where: { id: orderId },
        data: { allocationLockedAt: null },
      });
    }

    await enqueue(
      QUEUES.allocateOrder,
      { shopDomain, orderId },
      { singletonKey: `allocate:${orderId}:retry:${stamp}` },
    );
    queued.push("choosing supply sources again");
  }

  if (chosen === "write") {
    if (sourceIds.length === 0) {
      // Nothing to send yet. Allocating is the only thing that can help.
      await enqueue(
        QUEUES.allocateOrder,
        { shopDomain, orderId },
        { singletonKey: `allocate:${orderId}:retry:${stamp}` },
      );
      queued.push("choosing supply sources first, then sending");
    } else {
      for (const supplySourceId of sourceIds) {
        await enqueue(
          QUEUES.writeMetakockaOrder,
          { shopDomain, orderId, supplySourceId },
          { singletonKey: `mk:${orderId}:${supplySourceId}:retry:${stamp}` },
        );
      }
      queued.push(
        `sending ${sourceIds.length === 1 ? "the sales order" : `${sourceIds.length} sales orders`} to MetaKocka`,
      );
    }
  }

  if (chosen === "payment") {
    if (unpaid.length === 0) {
      return {
        queued: [],
        reason:
          "Every MetaKocka document for this order already carries its payment.",
      };
    }
    await enqueue(
      QUEUES.markMetakockaPaid,
      { shopDomain, orderId },
      { singletonKey: `paid:${orderId}:retry:${stamp}` },
    );
    queued.push("recording the payment in MetaKocka");
  }

  if (chosen === "refresh") {
    await enqueue(
      QUEUES.syncOrderState,
      { shopDomain, shopifyOrderId: order.shopifyOrderId },
      { singletonKey: `refresh:${shopDomain}:${order.shopifyOrderId}:${stamp}` },
    );
    queued.push("reading the order back from Shopify");
  }

  return { queued, reason: null };
}

/** Records that a person or the re-check asked for this again. */
export async function recordExceptionAttempt(
  exceptionId: string,
  at: Date,
): Promise<void> {
  await prisma.exception.updateMany({
    where: { id: exceptionId },
    data: { lastAttemptAt: at, attempts: { increment: 1 } },
  });
}
