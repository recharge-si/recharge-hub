import type { Job } from "pg-boss";
import { z } from "zod";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getCredential } from "~/adapters/db/repositories/metakocka-credential.server";
import {
  listProfitCenters,
  recordValidations,
} from "~/adapters/db/repositories/profit-center.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import { MetakockaError } from "~/adapters/metakocka/errors";
import { validateProfitCenters } from "~/adapters/metakocka/profit-centers";
import { getLogger } from "~/adapters/observability/logger.server";
import { serviceToken } from "~/domain/types";

export const reloadProfitCentersJobSchema = z.object({
  shopDomain: z.string().min(1),
});

/**
 * Re-checks the profit centre register against MetaKocka.
 *
 * There is nothing to fetch — §3 says MetaKocka will not list profit centres —
 * so this does not refresh a list, it re-validates one. What it catches is a
 * profit centre renamed or retired in the ERP months after it was registered
 * here: the supply source pointing at it goes on looking configured, and every
 * order it files is refused by MetaKocka until somebody notices.
 *
 * Nightly, and for the same reason as the payment types it sits beside: each
 * check is a document sent to fail validation on purpose (probe.ts), so running
 * it on the quarter-hourly tick would fill the merchant's own MetaKocka API log
 * with rejections that are not failures.
 *
 * A newly rejected entry is an event on the timeline, not an exception. Nothing
 * is broken yet — no order has failed — and §11 reserves the exceptions queue
 * for a business condition that has actually occurred.
 */
export async function handleReloadProfitCenters(
  job: Job<unknown>,
): Promise<void> {
  const { shopDomain } = reloadProfitCentersJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "reload-profit-centers");
  const log = getLogger();

  const credential = await getCredential(principal);
  if (!credential) return;

  const registered = await listProfitCenters(principal);
  if (registered.length === 0) return;

  try {
    const client = new MetakockaClient(
      { companyId: credential.companyId, secretKey: credential.secretKey },
      { timeoutMs: 30_000 },
    );

    const verdicts = await validateProfitCenters(
      client,
      registered.map((entry) => entry.value),
    );
    const summary = await recordValidations(principal, verdicts);

    // Only a change is worth a line on the timeline. A nightly "still fine"
    // entry for every profit centre would bury the events that matter.
    const newlyRejected = summary.rejected.filter((value) =>
      registered.some((entry) => entry.value === value && entry.isValid),
    );
    if (newlyRejected.length > 0) {
      await appendEvent(principal, {
        entityType: "profit_center",
        event: "profit_centers.rejected",
        detail: { values: newlyRejected },
      });
    }

    log.info(
      {
        shop: shopDomain,
        confirmed: summary.confirmed.length,
        rejected: summary.rejected.length,
        unchecked: summary.unchecked.length,
      },
      "Re-checked MetaKocka profit centres",
    );
  } catch (error) {
    // Retryable, not a business exception (§11): the next run picks it up and
    // there is nothing for the merchant to do in the meantime.
    log.warn(
      {
        shop: shopDomain,
        reason: error instanceof MetakockaError ? error.message : String(error),
      },
      "Scheduled profit centre check failed",
    );
    throw error;
  }
}
