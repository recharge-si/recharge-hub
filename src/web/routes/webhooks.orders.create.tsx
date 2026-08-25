import type { ActionFunctionArgs } from "react-router";

import { saveIncomingOrder } from "~/adapters/db/repositories/order.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { parseOrder } from "~/adapters/shopify/order-payload";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { captureException } from "~/adapters/observability/sentry.server";
import { serviceToken } from "~/domain/types";

/**
 * Order intake (CLAUDE.md §8.1).
 *
 * Unlike every other webhook in this app, this one does not simply hand the
 * payload to a queue. §8.1 is specific: the order and its lines are written and
 * the allocation job is enqueued **in one transaction**. Writing the row in a
 * job instead would mean a window where Shopify has been told 200 and nothing
 * anywhere records the order.
 *
 * What it does *not* do is any of the work. No MetaKocka call, no allocation,
 * no stock read — those all live in jobs, because this handler has five seconds
 * and MetaKocka alone can take tens of them (§2.5, §3).
 *
 * `authenticate.webhook` verifies the HMAC against the raw body before anything
 * is parsed (§2.1.7). The payload is not read until that returns.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload } =
    await authenticate.webhook(request);

  const log = getLogger();
  const principal = serviceToken(shop, "orders-create");

  try {
    const parsed = parseOrder(payload);
    const { orderId, created } = await saveIncomingOrder(
      principal,
      parsed,
      payload,
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
        },
      });
    }

    log.info(
      { shop, topic, webhookId, orderId, created },
      created ? "Order received" : "Order already known, ignored",
    );
  } catch (error) {
    // 500 asks Shopify to redeliver. Swallowing it would lose the order, and an
    // order this app never saw is the one failure mode with no way back.
    log.error({ err: error, shop, topic, webhookId }, "Failed to accept order");
    captureException(error, { shop, topic, webhookId });
    return new Response("Failed to accept order", { status: 500 });
  }

  return new Response(null, { status: 200 });
};
