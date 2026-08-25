import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { enqueueThrottled } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { getLogger } from "~/adapters/observability/logger.server";

export const scheduledTickJobSchema = z.object({
  /** Which cadence fired, so one handler can serve several schedules. */
  cadence: z.enum(["quarter_hourly", "nightly"]).default("quarter_hourly"),
});

/**
 * Fans a cron tick out to one job per shop.
 *
 * pg-boss schedules a queue, not a tenant, so a single cron entry cannot carry
 * "for every shop". This handler is that missing step: it reads the installed
 * shops and enqueues the per-shop work, which keeps exactly one cron entry in
 * the worker however many shops are installed.
 *
 * Everything it sends is throttled. A tick that fires while the previous run is
 * still going adds nothing rather than stacking a second copy of a job that can
 * take minutes (§2.5), and the throttle window is deliberately a little longer
 * than the cadence so a slow run cannot be lapped.
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
    select: { domain: true },
  });

  for (const { domain } of shops) {
    if (cadence === "quarter_hourly") {
      // The warehouse list is small and cheap, and a stale mark is dangerous
      // (§3), so it refreshes on every tick.
      await enqueueThrottled(
        QUEUES.reloadWarehouses,
        { shopDomain: domain },
        `warehouses:${domain}`,
        14 * 60,
      );

      // Stock is the expensive one. MetaKocka's own webhook gives up after two
      // retries (§3), so a scheduled pass is not an optimisation — it is the
      // only thing that guarantees the two sides converge.
      await enqueueThrottled(
        QUEUES.syncInventory,
        { shopDomain: domain },
        `inventory:${domain}`,
        14 * 60,
      );
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
