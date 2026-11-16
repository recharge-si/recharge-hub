import type { Job } from "pg-boss";
import { z } from "zod";

import { getEnv } from "~/adapters/config/env.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  closeExceptionsFor,
  raiseException,
} from "~/adapters/db/repositories/exception.server";
import {
  getWatchdogShop,
  listWatchdogOrders,
} from "~/adapters/db/repositories/order-watchdog.server";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  describeOverdue,
  watchOrder,
  type WatchFine,
} from "~/domain/orders/watchdog";
import { serviceToken } from "~/domain/types";

/**
 * The order watchdog: a shop-wide sweep for orders that should be in
 * MetaKocka and quietly are not (docs/project-status.md T-11).
 *
 * Everything else in the pipeline reacts to something — a webhook, a changed
 * order, an open exception. An order nothing reacted to has no such hook:
 * a write that returned without writing, a reconciliation that was never
 * queued, a worker that died between retries. Before this it sat at
 * "Received" for as long as nobody opened it, with a calm dashboard.
 *
 * Every quarter-hour, per shop, it judges each live order of the last
 * `LOOKBACK_DAYS` that is not both written and verified (`watchOrder`):
 *
 *  - **Overdue** raises `order_not_transferred`, deduped per order, so the
 *    order shows on Needs attention and on its own page. Retry reconciles it,
 *    and `recheck-exceptions` does that by itself every quarter-hour.
 *  - **In MetaKocka now**, or no longer owed (cancelled, deleted, redacted,
 *    held by the transfer switch), closes it, attributed to the app.
 *  - **Owned** by another open exception, or not old enough, leaves it as it
 *    is: a person already has the more specific story.
 *
 * Database reads and exception rows only; it never calls Shopify or
 * MetaKocka, so it is cheap to run often.
 */

export const watchOrdersJobSchema = z.object({
  shopDomain: z.string().min(1),
  /** Bounded so one shop's backlog cannot monopolise the worker. */
  limit: z.number().int().positive().max(2000).default(500),
});

/**
 * How far back the watchdog looks. Older than this, an order that never
 * reached MetaKocka is a decision somebody made, or one nobody will act on;
 * raising it now would only bury the new ones.
 */
export const LOOKBACK_DAYS = 30;

/** Why a flagged order no longer is, in the words of the audit trail. */
const CLEARED: Partial<Record<WatchFine, string>> = {
  transferred: "The order is in MetaKocka and verified.",
  over: "The order was cancelled, deleted or redacted.",
  not_activated: "Setup is not finished, so nothing is sent yet.",
  held_transfer_off: "Order transfer was turned off.",
  held_received_while_off: "The order was received while order transfer was off.",
};

export async function handleWatchOrders(
  job: Job<unknown>,
  options: { now?: Date } = {},
): Promise<{ raised: number; cleared: number; checked: number }> {
  const { shopDomain, limit } = watchOrdersJobSchema.parse(job.data ?? {});
  const principal = serviceToken(shopDomain, "watch-orders");
  const log = getLogger();
  const now = options.now ?? new Date();
  const thresholdMs = getEnv().ORDER_WATCHDOG_THRESHOLD_MINUTES * 60_000;

  const shop = await getWatchdogShop(principal);
  if (!shop) return { raised: 0, cleared: 0, checked: 0 };

  const orders = await listWatchdogOrders(principal, {
    receivedAfter: new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60_000),
    receivedBefore: new Date(now.getTime() - thresholdMs),
    limit,
  });

  let raised = 0;
  let cleared = 0;

  for (const order of orders) {
    const verdict = watchOrder(order.watched, {
      activatedAt: shop.activatedAt,
      transfer: shop.transfer,
      settingsChangedAt: shop.settingsChangedAt,
      thresholdMs,
      now,
    });

    if (verdict.kind === "overdue") {
      // An open one is updated in place with the newer waiting time.
      await raiseException(principal, {
        orderId: order.id,
        kind: "order_not_transferred",
        message: describeOverdue(order.orderNumber, verdict),
        detail: {
          problem: verdict.problem,
          waitingMinutes: Math.floor(verdict.waitingMs / 60_000),
          documents: order.watched.documents.length,
          syncState: order.watched.syncState,
        },
      });
      if (!order.flagged) raised += 1;
      continue;
    }

    const why = CLEARED[verdict.why];
    if (!order.flagged || !why) continue;

    await closeExceptionsFor(principal, order.id, ["order_not_transferred"]);
    await appendEvent(principal, {
      entityType: "order",
      entityId: order.id,
      event: "exception.resolved_automatically",
      detail: { kind: "order_not_transferred", orderId: order.id, why },
    });
    cleared += 1;
  }

  log.info(
    { shop: shopDomain, checked: orders.length, raised, cleared },
    "Order watchdog swept the shop",
  );
  return { raised, cleared, checked: orders.length };
}
