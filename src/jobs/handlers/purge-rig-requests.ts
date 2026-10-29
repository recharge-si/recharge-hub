import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { purgeRigRequests } from "~/adapters/db/repositories/rig.server";
import { getLogger } from "~/adapters/observability/logger.server";

export const purgeRigRequestsJobSchema = z.object({
  shopDomain: z.string().min(1),
  /** Injected so a test can age a row without waiting ninety days. */
  olderThanDays: z.number().int().positive().default(90),
});

/**
 * The rig builder's retention promise (docs/rig-builder.md § Storage and
 * privacy): a `rig_request` row is kept 90 days and then deleted. The row
 * holds no buyer text and no customer id, only the profile the engine ran on
 * and a salted IP hash, but a hash is still personal data under GDPR, so it
 * does not live forever.
 */
export async function handlePurgeRigRequests(job: Job<unknown>): Promise<void> {
  const { shopDomain, olderThanDays } = purgeRigRequestsJobSchema.parse(
    job.data ?? {},
  );
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });
  if (!shop) return;

  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60_000);
  const removed = await purgeRigRequests(shop.id, cutoff);
  if (removed > 0) {
    getLogger().info(
      { shop: shopDomain, removed, olderThanDays },
      "Purged old rig requests",
    );
  }
}
