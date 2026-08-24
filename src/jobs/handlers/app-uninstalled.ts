import type { Job, PgBoss } from "pg-boss";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { markUninstalled } from "~/adapters/db/repositories/shop.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { webhookJobSchema } from "~/adapters/shopify/compliance-payloads";
import { serviceToken } from "~/domain/types";
import { cancelShopJobs } from "~/jobs/cancel-shop-jobs";

/**
 * CLAUDE.md section 2.7, clean uninstall: revoke tokens and cancel scheduled work.
 *
 * Business records are deliberately kept here rather than purged. Shopify sends
 * `shop/redact` 48 hours later and that handler deletes them; keeping them until
 * then is what lets a merchant reinstall within the window without losing their
 * configuration. If the merchant never comes back, `shop/redact` finishes the job.
 */
export function makeAppUninstalledHandler(boss: PgBoss) {
  return async function handleAppUninstalled(job: Job<unknown>): Promise<void> {
    const envelope = webhookJobSchema.parse(job.data);
    const principal = serviceToken(envelope.shopDomain, "app-uninstalled");

    await appendEvent(principal, {
      entityType: "shop",
      entityId: envelope.shopDomain,
      event: "app.uninstalled",
      detail: { webhookId: envelope.webhookId },
    });

    await markUninstalled(principal);

    // The offline token is useless to Shopify now, and useless to us. Drop it.
    const { count } = await prisma.session.deleteMany({
      where: { shop: envelope.shopDomain },
    });

    const cancelled = await cancelShopJobs(boss, envelope.shopDomain);

    getLogger().info(
      {
        shop: envelope.shopDomain,
        webhookId: envelope.webhookId,
        sessionsDeleted: count,
        jobsCancelled: cancelled,
      },
      "app/uninstalled processed",
    );
  };
}
