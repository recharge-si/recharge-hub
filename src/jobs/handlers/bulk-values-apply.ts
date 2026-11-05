import type { Job } from "pg-boss";
import { z } from "zod";

import { getLogger } from "~/adapters/observability/logger.server";
import { runBulkApply } from "~/adapters/products/bulk-values.server";
import { unauthenticated } from "~/adapters/shopify/shopify.server";

export const bulkValuesApplyJobSchema = z.object({
  shopDomain: z.string().min(1),
  importId: z.string().min(1),
});

/**
 * Applies a stored preview of attribute values (docs/attributes.md § Bulk
 * values). The work and its rules are in `runBulkApply`; the import's row
 * is what the page watches. Not retried by the queue: a failure leaves the
 * import `failed` with what was written kept, and a person continues it.
 */
export async function handleBulkValuesApply(job: Job<unknown>): Promise<void> {
  const { shopDomain, importId } = bulkValuesApplyJobSchema.parse(job.data);
  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    await runBulkApply(admin, shopDomain, importId);
  } catch (error) {
    // The run recorded its own failure; this keeps the cause in the log.
    getLogger().error(
      { err: error, shop: shopDomain, importId },
      "Bulk values apply stopped",
    );
  }
}
