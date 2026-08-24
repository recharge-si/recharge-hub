import type { Job, WorkHandler } from "pg-boss";

import {
  claimKey,
  recordKeyResult,
  releaseKey,
} from "~/adapters/db/repositories/idempotency.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { webhookJobSchema } from "~/adapters/shopify/compliance-payloads";

export type WebhookJobHandler = (job: Job<unknown>) => Promise<void>;

/**
 * Wraps a webhook-triggered handler so it runs once per Shopify `webhookId`,
 * however many times the event is delivered or the job retried.
 *
 * A failure releases the claim before rethrowing, so pg-boss's retry is allowed
 * to run. Suppressing the retry would be worse than doing the work twice.
 */
export function withIdempotency(
  scope: string,
  handler: WebhookJobHandler,
): WorkHandler<unknown> {
  return async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      const { shopDomain, webhookId } = webhookJobSchema.parse(job.data);

      const claimed = await claimKey(shopDomain, scope, webhookId);

      if (!claimed) {
        getLogger().info(
          { shop: shopDomain, scope, webhookId },
          "Duplicate delivery ignored",
        );
        continue;
      }

      try {
        await handler(job);
        await recordKeyResult(shopDomain, scope, webhookId, {
          status: "completed",
        });
      } catch (error) {
        await releaseKey(shopDomain, scope, webhookId);
        throw error;
      }
    }
  };
}
