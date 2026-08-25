import type { Job } from "pg-boss";
import { z } from "zod";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getCredential } from "~/adapters/db/repositories/metakocka-credential.server";
import { recordObservation } from "~/adapters/db/repositories/pricelist.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import { MetakockaError } from "~/adapters/metakocka/errors";
import { observeCatalogue } from "~/adapters/metakocka/pricelists";
import { getLogger } from "~/adapters/observability/logger.server";
import { serviceToken } from "~/domain/types";

export const reloadPricelistsJobSchema = z.object({
  shopDomain: z.string().min(1),
});

/**
 * Refreshes which pricelists and VAT rates the company's own catalogue uses.
 *
 * MetaKocka lists neither (CLAUDE.md §3), so this reads them off priced
 * products (adapters/metakocka/pricelists.ts). It writes nothing to the ERP.
 *
 * Nightly, beside the payment type and profit centre reloads. Not for their
 * reason — this one is an ordinary read rather than a deliberate rejection —
 * but for the same practical one: it is several MetaKocka calls, MetaKocka
 * calls are slow (§3), and a pricelist register changes about as often as a
 * payment register does. The settings screen can also ask for it directly when
 * the merchant wants it now.
 */
export async function handleReloadPricelists(job: Job<unknown>): Promise<void> {
  const { shopDomain } = reloadPricelistsJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "reload-pricelists");
  const log = getLogger();

  const credential = await getCredential(principal);
  if (!credential) return;

  try {
    const client = new MetakockaClient(
      { companyId: credential.companyId, secretKey: credential.secretKey },
      { timeoutMs: 60_000 },
    );

    const observation = await observeCatalogue(client);
    const counts = await recordObservation(principal, observation);

    await appendEvent(principal, {
      entityType: "pricelist",
      event: "pricelists.observed",
      detail: counts,
    });

    log.info({ shop: shopDomain, ...counts }, "Read MetaKocka pricelists");
  } catch (error) {
    // Retryable, not a business exception (§11). Nothing is broken for the
    // merchant while this is stale: the settings screen falls back to typing
    // the code by hand, and the sync corrects a wrong basis from MetaKocka's
    // own rejection.
    log.warn(
      {
        shop: shopDomain,
        reason: error instanceof MetakockaError ? error.message : String(error),
      },
      "Scheduled pricelist read failed",
    );
    throw error;
  }
}
