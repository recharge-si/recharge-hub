import type { PgBoss } from "pg-boss";

import { ALL_QUEUES } from "~/adapters/queue/queues";
import { getLogger } from "~/adapters/observability/logger.server";

/**
 * CLAUDE.md section 2.7: a clean uninstall cancels all scheduled jobs for that
 * shop. Every job this app sends carries `shopDomain` in its payload, which is
 * what makes the queue searchable per tenant.
 *
 * Only queued jobs are cancelled. A job that is already running finishes -- that
 * includes the uninstall job doing the cancelling.
 */
export async function cancelShopJobs(
  boss: PgBoss,
  shopDomain: string,
): Promise<number> {
  let cancelled = 0;

  for (const queue of ALL_QUEUES) {
    const jobs = await boss.findJobs(queue, {
      data: { shopDomain },
      queued: true,
    });

    if (jobs.length === 0) continue;

    await boss.cancel(
      queue,
      jobs.map((job) => job.id),
    );
    cancelled += jobs.length;
  }

  if (cancelled > 0) {
    getLogger().info({ shop: shopDomain, cancelled }, "Cancelled queued jobs");
  }

  return cancelled;
}
