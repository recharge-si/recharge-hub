import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { raiseException } from "~/adapters/db/repositories/exception.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { getLogger } from "~/adapters/observability/logger.server";
import { serviceToken, shopDomainOf } from "~/domain/types";

export const ordersEventJobSchema = z.object({
  shopDomain: z.string().min(1),
  topic: z.string().min(1),
  payload: z.unknown(),
});

const identitySchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String).optional(),
    order_id: z.union([z.string(), z.number()]).transform(String).optional(),
    order_number: z
      .union([z.string(), z.number()])
      .transform(String)
      .optional(),
    /**
     * `orders/edited` does not carry the order at any top level: its payload
     * is an *order edit*, `{ order_edit: { id, order_id, ... } }`, where the
     * top-level-adjacent `id` is the id of the edit. Reading only the top
     * level meant every edit resolved to "event for unknown order" and was
     * dropped on the floor.
     */
    order_edit: z
      .object({
        order_id: z
          .union([z.string(), z.number()])
          .transform(String)
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * The Shopify order id an order event is about, whatever envelope it arrived
 * in. The edit envelope wins over the top level: on `orders/edited` the
 * top-level `id` is the id of the edit, not of the order.
 */
export function orderIdOfEvent(payload: unknown): string | null {
  const identity = identitySchema.safeParse(payload);
  if (!identity.success) return null;
  return (
    identity.data.order_edit?.order_id ??
    identity.data.order_id ??
    identity.data.id ??
    null
  );
}

/**
 * The order topics whose payload is not an order (CLAUDE.md §8.8).
 *
 * `orders/updated`, `orders/paid` and `orders/cancelled` all carry the order
 * itself and go straight to `sync-order-state`, which compares it against what
 * is stored. The three left here cannot: `refunds/create` describes a refund,
 * `orders/edited` describes an edit, and `orders/delete` describes an order
 * that no longer exists.
 *
 * So the first two do the only sensible thing with an event that says *that*
 * something happened without saying what the order is now — they queue a read
 * of the order from the Admin API, and let the same comparison as everything
 * else decide. That matters most for an edit: before this, every edit raised an
 * exception, including the ones to orders nothing had been sent for yet, where
 * the right answer is simply to allocate again.
 *
 * The rule that outranks all of it: **never auto-delete a MetaKocka document.**
 * A cancelled or deleted Shopify order may already be invoiced on the MetaKocka
 * side, and deleting the document would destroy an accounting record.
 */
export async function handleOrdersEvent(job: Job<unknown>): Promise<void> {
  const { shopDomain, topic, payload } = ordersEventJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "orders-event");
  const log = getLogger();

  const shopifyOrderId = orderIdOfEvent(payload);

  const order = shopifyOrderId
    ? await prisma.order.findFirst({
        where: {
          shopifyOrderId,
          shop: { domain: shopDomainOf(principal) },
        },
        select: {
          id: true,
          shopifyOrderNumber: true,
          documents: { select: { countCode: true, mkId: true, status: true } },
        },
      })
    : null;

  // An event for an order this app never saw. Worth recording — it usually
  // means the app was installed after the order — but there is nothing to act
  // on, and an exception with no order attached helps nobody.
  if (!order) {
    await appendEvent(principal, {
      entityType: "order",
      event: "order.event_ignored",
      detail: { topic, shopifyOrderId },
    });
    log.info(
      { shop: shopDomain, topic, shopifyOrderId },
      "Event for unknown order",
    );
    return;
  }

  const written = order.documents.filter((doc) => doc.status === "written");
  const documentNote =
    written.length === 0
      ? "Nothing has been sent to MetaKocka for this order yet."
      : `MetaKocka already holds ${written.length === 1 ? "a document" : `${written.length} documents`} for this order (${written.map((doc) => doc.countCode).join(", ")}). It may already be invoiced, so nothing here is deleted automatically.`;

  if (topic === "refunds/create") {
    await raiseException(principal, {
      orderId: order.id,
      kind: "refund_received",
      message: `Order ${order.shopifyOrderNumber} was refunded in Shopify. Refunds are not sent to MetaKocka automatically. ${documentNote} Issue the credit note in MetaKocka, then resolve this.`,
      detail: { topic },
    });

    // The refund also moves the order's financial status, and this event does
    // not say what it moved to. Reading the order back keeps the payment state
    // on the order page honest rather than frozen at "paid".
    await refreshOrder(shopDomain, shopifyOrderId);
  } else if (topic === "orders/edited") {
    /*
     * An edit, described as a set of additions and removals rather than as an
     * order. Reading the order back and comparing it is the only way to know
     * what it now is — and the comparison, not this handler, decides what
     * follows: allocate again when nothing has been sent to MetaKocka, or raise
     * a divergence when it has.
     */
    await refreshOrder(shopDomain, shopifyOrderId);

    await appendEvent(principal, {
      entityType: "order",
      entityId: order.id,
      event: "order.edit_received",
      detail: { topic, documents: written.length },
    });

    log.info(
      { shop: shopDomain, topic, orderId: order.id },
      "Order edited in Shopify, re-reading it",
    );
    return;
  } else if (topic === "orders/delete") {
    /*
     * Deleted in Shopify, kept in MetaKocka.
     *
     * The ERP document is the accounting record and may already be invoiced;
     * removing it because Shopify no longer lists the order would destroy a
     * book entry to tidy up a screen. So the order is hidden here and nothing
     * is sent anywhere — and this is deliberately *not* an exception, because
     * there is nothing for anyone to decide.
     */
    await prisma.order.updateMany({
      where: { id: order.id, shopifyDeletedAt: null },
      data: { shopifyDeletedAt: new Date() },
    });

    await appendEvent(principal, {
      entityType: "order",
      entityId: order.id,
      event: "order.deleted_in_shopify",
      detail: {
        documents: written.length,
        countCodes: written.map((d) => d.countCode),
      },
    });

    log.info(
      { shop: shopDomain, orderId: order.id, documents: written.length },
      "Order deleted in Shopify; MetaKocka documents left in place",
    );
    return;
  } else {
    await appendEvent(principal, {
      entityType: "order",
      entityId: order.id,
      event: "order.event_ignored",
      detail: { topic },
    });
    return;
  }

  await appendEvent(principal, {
    entityType: "order",
    entityId: order.id,
    event: "order.exception_raised",
    detail: { topic, documents: written.length },
  });

  log.info(
    { shop: shopDomain, topic, orderId: order.id },
    "Order event raised an exception",
  );
}

/**
 * Queues a read of one order from the Admin API.
 *
 * Separate from the exception above rather than replacing it: a refund still
 * needs a human, and what the order looks like afterwards is a different
 * question from what somebody has to do about it.
 */
async function refreshOrder(
  shopDomain: string,
  shopifyOrderId: string | null,
): Promise<void> {
  if (!shopifyOrderId) return;

  await enqueue(
    QUEUES.syncOrderState,
    { shopDomain, shopifyOrderId },
    { singletonKey: `refresh:${shopDomain}:${shopifyOrderId}` },
  );
}
