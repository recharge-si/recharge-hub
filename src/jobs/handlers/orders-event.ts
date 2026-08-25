import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { raiseException } from "~/adapters/db/repositories/exception.server";
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
  })
  .passthrough();

/**
 * Refunds, cancellations and edits (CLAUDE.md §8.8).
 *
 * None of these are implemented in v1, and that is a deliberate decision rather
 * than an omission — but the webhooks are received and turned into exceptions
 * **from day one**, so nothing is lost silently. A refund that nobody hears
 * about is a refund that never reaches the ERP, and the merchant finds out at
 * the end of the quarter.
 *
 * The one rule that matters here: **never auto-delete a MetaKocka document.** A
 * cancelled Shopify order may already be invoiced on the MetaKocka side, and
 * deleting the document would destroy an accounting record. Every one of these
 * ends with a human deciding.
 */
export async function handleOrdersEvent(job: Job<unknown>): Promise<void> {
  const { shopDomain, topic, payload } = ordersEventJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "orders-event");
  const log = getLogger();

  const identity = identitySchema.safeParse(payload);
  const shopifyOrderId = identity.success
    ? (identity.data.order_id ?? identity.data.id ?? null)
    : null;

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
  } else if (topic === "orders/cancelled") {
    await raiseException(principal, {
      orderId: order.id,
      kind: "order_cancelled",
      message: `Order ${order.shopifyOrderNumber} was cancelled in Shopify. ${documentNote} Cancel or credit it in MetaKocka by hand, then resolve this.`,
      detail: { topic },
    });
    await prisma.order.update({
      where: { id: order.id },
      data: { status: "cancelled" },
    });
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
  } else if (topic === "orders/edited") {
    await raiseException(principal, {
      orderId: order.id,
      kind: "order_edited",
      message: `Order ${order.shopifyOrderNumber} was edited in Shopify after it was allocated. The allocation and any MetaKocka document still describe the order as it was. ${documentNote} Check both sides and update MetaKocka by hand.`,
      detail: { topic },
    });
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
