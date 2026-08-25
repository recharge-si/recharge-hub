import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { enqueueThrottled } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { getLogger } from "~/adapters/observability/logger.server";

export const scheduledTickJobSchema = z.object({
  /** Which cadence fired, so one handler can serve several schedules. */
  cadence: z
    .enum(["fast", "quarter_hourly", "nightly"])
    .default("quarter_hourly"),
});

/**
 * Fans a cron tick out to one job per shop.
 *
 * pg-boss schedules a queue, not a tenant, so a single cron entry cannot carry
 * "for every shop". This handler is that missing step: it reads the installed
 * shops and enqueues the per-shop work, which keeps exactly one cron entry per
 * cadence in the worker however many shops are installed.
 *
 * Everything it sends is throttled. A tick that fires while the previous run is
 * still going adds nothing rather than stacking a second copy of a job that can
 * take minutes (§2.5), and each throttle window is a little longer than its
 * cadence so a slow run cannot be lapped.
 *
 * Three cadences, and the split is about consequence rather than cost:
 *
 *  - **fast (5 minutes)** — stock. It is the number that decides whether the
 *    store oversells, and it is the number that changes most often.
 *  - **quarter-hourly** — everything that keeps orders and exceptions honest.
 *  - **nightly** — the registers, whose reads are deliberate rejections (§7),
 *    and the retention promise.
 */
export async function handleScheduledTick(job: Job<unknown>): Promise<void> {
  const { cadence } = scheduledTickJobSchema.parse(job.data ?? {});
  const log = getLogger();

  // Only shops that are installed and have credentials. Everything downstream
  // needs MetaKocka, so sending jobs for a shop without a key would just queue
  // work that returns immediately.
  const shops = await prisma.shop.findMany({
    where: {
      uninstalledAt: null,
      installState: "installed",
      metakockaCredential: { isNot: null },
    },
    select: {
      domain: true,
      productSyncSetting: {
        select: {
          scheduleEnabled: true,
          scheduleIntervalMinutes: true,
          lastRunAt: true,
        },
      },
    },
  });

  const now = Date.now();

  for (const shop of shops) {
    const { domain } = shop;

    if (cadence === "fast") {
      /*
       * Stock, every five minutes.
       *
       * MetaKocka's own webhook exists for this and gives up after two retries
       * (§3), which makes it a hint rather than a delivery guarantee. A short
       * cycle beside it is what turns "usually current" into "never more than
       * five minutes behind", and stock is the one figure where being behind
       * means selling something that is not there.
       *
       * Cheap by construction: the sync writes only what differs and skips
       * every no-op (§7).
       */
      await enqueueThrottled(
        QUEUES.syncInventory,
        { shopDomain: domain },
        `inventory:${domain}`,
        4 * 60,
      );
      continue;
    }

    if (cadence === "quarter_hourly") {
      // The warehouse list is small and cheap, and a stale mark is dangerous
      // (§3), so it refreshes on every tick.
      await enqueueThrottled(
        QUEUES.reloadWarehouses,
        { shopDomain: domain },
        `warehouses:${domain}`,
        14 * 60,
      );

      /*
       * Orders, re-read from Shopify (§8.10).
       *
       * Not an optimisation and not a nightly nicety: Shopify webhooks are
       * best-effort, and a payment this app never hears about is a payment the
       * merchant chases by hand. Cheap by construction — it asks Shopify only
       * for what has changed, and an order that has not moved costs one
       * comparison.
       */
      await enqueueThrottled(
        QUEUES.reconcileOrders,
        { shopDomain: domain },
        `orders:${domain}`,
        14 * 60,
      );

      /*
       * Open exceptions, re-checked (§11).
       *
       * An exception is a condition, not an event. "Not enough stock" stops
       * being true the moment stock arrives and nothing announces it, so
       * without this the queue fills with problems that were dealt with days
       * ago — and a queue nobody trusts is a queue nobody reads.
       */
      await enqueueThrottled(
        QUEUES.recheckExceptions,
        { shopDomain: domain },
        `exceptions:${domain}`,
        14 * 60,
      );

      /*
       * What MetaKocka has done with our documents since we wrote them.
       *
       * The ERP pushes nothing but stock (§3), so an order that is confirmed,
       * picked and delivered inside MetaKocka still reads as "written" here
       * unless somebody asks.
       */
      await enqueueThrottled(
        QUEUES.pollMetakockaDocuments,
        { shopDomain: domain },
        `documents:${domain}`,
        14 * 60,
      );

      /*
       * The catalogue, on the merchant's own schedule.
       *
       * A registry that is only as fresh as the last time somebody pressed a
       * button is a registry that silently stops matching: a product renamed in
       * MetaKocka, a SKU corrected in Shopify, a new variant added this
       * morning. Off by default and the interval is the merchant's, because
       * this is the one scheduled job that can write into their ERP catalogue
       * (§8.9).
       */
      const productSync = shop.productSyncSetting;
      if (productSync?.scheduleEnabled) {
        const due =
          !productSync.lastRunAt ||
          now - productSync.lastRunAt.getTime() >=
            productSync.scheduleIntervalMinutes * 60 * 1000;

        if (due) {
          await enqueueThrottled(
            QUEUES.syncCatalogue,
            { shopDomain: domain },
            `catalogue:${domain}`,
            // Never more than one in flight, whatever interval was chosen.
            Math.max(5, productSync.scheduleIntervalMinutes - 1) * 60,
          );
        }
      }
    }

    if (cadence === "nightly") {
      // Nightly rather than quarter-hourly: reading the payment types means
      // sending a document that fails validation on purpose (no endpoint lists
      // them, §8.7), and a register changes a few times a year. Doing that
      // every fifteen minutes would fill the merchant's own API log with
      // rejections that are not failures.
      await enqueueThrottled(
        QUEUES.reloadPaymentTypes,
        { shopDomain: domain },
        `payment-types:${domain}`,
        20 * 60 * 60,
      );

      // Same reasoning, and the same kind of probe: re-checking a profit
      // centre means sending a document that fails on purpose (§3 has no
      // endpoint to ask). What it catches is a centre renamed in the ERP long
      // after it was registered here, which otherwise surfaces as a rejected
      // order.
      await enqueueThrottled(
        QUEUES.reloadProfitCenters,
        { shopDomain: domain },
        `profit-centers:${domain}`,
        20 * 60 * 60,
      );

      // Which pricelists and VAT rates the company's own catalogue uses.
      // MetaKocka lists neither (3), so this reads them off priced products.
      // An ordinary read rather than a deliberate rejection, but several
      // MetaKocka calls all the same, and the answer changes about as often as
      // a payment register does.
      await enqueueThrottled(
        QUEUES.reloadPricelists,
        { shopDomain: domain },
        `pricelists:${domain}`,
        20 * 60 * 60,
      );

      // Section 2.4: the retention promise is kept by a job, not by intent.
      await enqueueThrottled(
        QUEUES.redactOldOrders,
        { shopDomain: domain },
        `redact:${domain}`,
        20 * 60 * 60,
      );
    }
  }

  log.info({ shops: shops.length, cadence }, "Scheduled tick fanned out");
}
