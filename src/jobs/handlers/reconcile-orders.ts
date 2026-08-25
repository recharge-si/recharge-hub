import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { fetchOrdersUpdatedSince } from "~/adapters/shopify/orders";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { syncOrderState } from "~/jobs/handlers/sync-order-state";
import { serviceToken, type Principal } from "~/domain/types";

/**
 * Re-reads orders from Shopify and applies whatever has changed (§8.10).
 *
 * Webhooks are the fast path. They are not a guarantee, and this app is not
 * allowed to depend on them:
 *
 *  - Shopify retries a failed delivery for a while and then stops. An app that
 *    is down for an afternoon never hears what happened in it.
 *  - Delivery order is not promised, so a late `orders/updated` can describe an
 *    older version of the order than the one already applied.
 *  - A subscription added today says nothing about the orders that moved
 *    yesterday. Every merchant who installs this app has a backlog.
 *
 * §8.10 already requires a nightly pass for exactly this reason. This runs more
 * often than nightly because a payment left unrecorded for a day is a payment
 * the merchant chases by hand, and the pass is cheap: it reads only what
 * Shopify says has changed, and `syncOrderState` does nothing for an order that
 * has not moved.
 *
 * The watermark is `updated_at`, read with deliberate overlap. Re-reading an
 * order costs one comparison; missing one is silent, and silence is the whole
 * failure this job exists to prevent.
 */

export const reconcileOrdersJobSchema = z.object({
  shopDomain: z.string().min(1),
  /** Injected by the order page's "Check with Shopify" action and by tests. */
  sinceIso: z.string().optional(),
  /** Bounds one run so a first pass over a busy store cannot hog the worker. */
  maxPages: z.number().int().positive().max(200).default(20),
});

/**
 * How far back the overlap reaches on every run.
 *
 * Covers the gap between a change happening and Shopify's index reflecting it,
 * and any clock difference between the two sides. Five minutes of re-reading is
 * a handful of diffs that find nothing.
 */
const OVERLAP_MS = 5 * 60 * 1000;

/** The first run's window. Not the beginning of time: a new install has one. */
const FIRST_RUN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The furthest back this may ever look.
 *
 * Orders older than sixty days need `read_all_orders`, which §2.3 does not
 * request and no requirement here justifies. A watermark older than this is
 * clamped rather than allowed to produce a query Shopify will refuse.
 */
const MAX_LOOKBACK_MS = 55 * 24 * 60 * 60 * 1000;

export function windowStart(input: {
  watermark: Date | null;
  installedAt: Date;
  now: Date;
}): Date {
  const floor = new Date(input.now.getTime() - MAX_LOOKBACK_MS);

  const from = input.watermark
    ? new Date(input.watermark.getTime() - OVERLAP_MS)
    : new Date(
        Math.max(
          input.installedAt.getTime(),
          input.now.getTime() - FIRST_RUN_WINDOW_MS,
        ),
      );

  return from < floor ? floor : from;
}

export async function handleReconcileOrders(job: Job<unknown>): Promise<void> {
  const { shopDomain, sinceIso, maxPages } = reconcileOrdersJobSchema.parse(
    job.data ?? {},
  );
  const principal = serviceToken(shopDomain, "reconcile-orders");
  const log = getLogger();

  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true, installedAt: true, ordersReconciledThrough: true },
  });
  if (!shop) return;

  const startedAt = new Date();
  const since = sinceIso
    ? new Date(sinceIso)
    : windowStart({
        watermark: shop.ordersReconciledThrough,
        installedAt: shop.installedAt,
        now: startedAt,
      });

  const { admin } = await unauthenticated.admin(shopDomain);

  let cursor: string | null = null;
  let pages = 0;
  let read = 0;
  let ingested = 0;
  let updated = 0;
  let lastSeenUpdatedAt: Date | null = null;
  let complete = true;

  for (;;) {
    const page = await fetchOrdersUpdatedSince(admin, since, { cursor });

    for (const payload of page.orders) {
      read += 1;

      const updatedAt = payload.updated_at;
      if (typeof updatedAt === "string") {
        const at = new Date(updatedAt);
        if (!lastSeenUpdatedAt || at > lastSeenUpdatedAt) lastSeenUpdatedAt = at;
      }

      /*
       * One order failing does not stop the pass.
       *
       * A single unparsable or unusual order would otherwise block every order
       * behind it in the page and, because the watermark would not advance,
       * block them again on the next run. The failure is logged and the sweep
       * carries on; whatever is wrong with that order is still wrong next time.
       */
      try {
        const outcome = await syncOrderState(principal, payload, {
          source: "reconciler",
          now: new Date(),
        });
        if (outcome.result === "ingested") ingested += 1;
        if (outcome.result === "updated") updated += 1;
      } catch (error) {
        log.error(
          { err: error, shop: shopDomain, order: payload.id },
          "Could not reconcile one order",
        );
      }
    }

    pages += 1;
    cursor = page.cursor;

    if (!page.hasNextPage) break;
    if (pages >= maxPages) {
      // Stop short rather than run for an hour. The watermark advances to what
      // was actually read, so the next tick continues from there.
      complete = false;
      break;
    }
  }

  /*
   * Where the next run starts.
   *
   * A run that reached the end has covered everything Shopify had changed as of
   * `startedAt`, so that is the mark — anything changed while it ran comes back
   * through the overlap. A run that stopped at the page cap has only covered as
   * far as the last order it read, so that is the mark instead. Neither ever
   * moves forward past work that was not done.
   */
  const through = complete ? startedAt : (lastSeenUpdatedAt ?? since);

  await prisma.shop.update({
    where: { id: shop.id },
    data: { ordersReconciledThrough: through },
  });

  await recoverStuckOrders(principal, log);

  if (ingested > 0 || updated > 0) {
    await appendEvent(principal, {
      entityType: "order",
      event: "orders.reconciled",
      detail: {
        read,
        ingested,
        updated,
        since: since.toISOString(),
        through: through.toISOString(),
        complete,
      },
    });
  }

  log.info(
    { shop: shopDomain, read, ingested, updated, pages, complete },
    "Orders reconciled against Shopify",
  );
}

/**
 * How long an allocated order may sit with nothing sent before it is re-queued.
 *
 * Long enough that an order still working its way through the write queue is
 * never touched, short enough that a job lost to a worker restart is picked up
 * within the hour.
 */
const STUCK_AFTER_MS = 30 * 60 * 1000;

/**
 * Re-queues orders that were allocated and then went quiet.
 *
 * The gap this closes is narrow and real: `allocate-order` enqueues one write
 * per supply source, and if the worker dies after pg-boss has exhausted a job's
 * retries, nothing else in the system will ever look at that order again. It
 * would sit at "Allocated" forever, with no exception, because nothing failed
 * in a way anybody noticed.
 *
 * Deliberately narrow. Only orders at `allocated` — an order at
 * `needs_attention` has an open exception and a human owns it, and re-driving
 * it would fight them. Only orders with no document row at all, so an order
 * mid-write is left alone. The write job's own `count_code` claim makes a
 * needless re-queue harmless (§8.4).
 */
async function recoverStuckOrders(
  principal: Principal,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  const stuck = await prisma.order.findMany({
    where: {
      shop: { domain: principal.shopDomain },
      status: "allocated",
      shopifyDeletedAt: null,
      updatedAt: { lt: new Date(Date.now() - STUCK_AFTER_MS) },
      documents: { none: {} },
      lines: { some: { allocations: { some: { supplySourceId: { not: null } } } } },
    },
    select: {
      id: true,
      shopifyOrderNumber: true,
      lines: {
        select: { allocations: { select: { supplySourceId: true } } },
      },
    },
    take: 50,
  });

  for (const order of stuck) {
    const sourceIds = [
      ...new Set(
        order.lines.flatMap((line) =>
          line.allocations
            .map((allocation) => allocation.supplySourceId)
            .filter((id): id is string => id !== null),
        ),
      ),
    ];
    if (sourceIds.length === 0) continue;

    for (const supplySourceId of sourceIds) {
      await enqueue(
        QUEUES.writeMetakockaOrder,
        { shopDomain: principal.shopDomain, orderId: order.id, supplySourceId },
        { singletonKey: `mk:${order.id}:${supplySourceId}:recover` },
      );
    }

    await appendEvent(principal, {
      entityType: "order",
      entityId: order.id,
      event: "order.write_requeued",
      detail: { sources: sourceIds.length, reason: "no document after 30 minutes" },
    });

    log.warn(
      { shop: principal.shopDomain, orderId: order.id, sources: sourceIds.length },
      "Re-queued an allocated order with nothing written",
    );
  }
}
