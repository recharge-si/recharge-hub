import type { Job } from "pg-boss";
import { z } from "zod";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getCredential } from "~/adapters/db/repositories/metakocka-credential.server";
import { replaceCachedWarehouses } from "~/adapters/db/repositories/supply-source.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import { MetakockaError } from "~/adapters/metakocka/errors";
import { listWarehouses } from "~/adapters/metakocka/warehouses";
import { getLogger } from "~/adapters/observability/logger.server";
import { serviceToken } from "~/domain/types";

export const reloadWarehousesJobSchema = z.object({
  shopDomain: z.string().min(1),
});

/**
 * Refreshes the cached MetaKocka warehouse list.
 *
 * This used to happen only when the merchant pressed a button, which meant the
 * app's idea of the warehouses drifted from MetaKocka's the moment anybody
 * renamed one — and a stale mark does not fail loudly, it files documents
 * against the company default (§3). Running it on a schedule keeps the two in
 * step without anyone having to remember.
 *
 * Renames and removals are written to the event log rather than applied
 * silently. Turning off a merchant's stock sync is not something that should
 * happen with no trace, even when it is the correct thing to do.
 */
export async function handleReloadWarehouses(job: Job<unknown>): Promise<void> {
  const { shopDomain } = reloadWarehousesJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "reload-warehouses");
  const log = getLogger();

  const credential = await getCredential(principal);
  if (!credential) return;

  try {
    const client = new MetakockaClient(
      { companyId: credential.companyId, secretKey: credential.secretKey },
      { timeoutMs: 30_000 },
    );
    const warehouses = await listWarehouses(client);

    const { retired, renamed } = await replaceCachedWarehouses(
      principal,
      warehouses.map((w) => ({
        mkId: w.mkId,
        mark: w.mark,
        name: w.name,
        isMain: w.isMain,
        isActive: w.isActive,
        includeInStockInfo: w.includeInStockInfo,
      })),
    );

    if (renamed.length > 0) {
      await appendEvent(principal, {
        entityType: "supply_source",
        event: "warehouse_mapping.renamed",
        detail: { changes: renamed },
      });
    }

    if (retired.length > 0) {
      await appendEvent(principal, {
        entityType: "supply_source",
        event: "warehouse_mapping.retired",
        detail: { names: retired },
      });
    }

    log.info(
      {
        shop: shopDomain,
        warehouses: warehouses.length,
        renamed: renamed.length,
        retired: retired.length,
      },
      "Reloaded MetaKocka warehouses",
    );
  } catch (error) {
    // A scheduled refresh that cannot reach MetaKocka is a retryable failure,
    // not a business exception (§11): the next run will pick it up, and the
    // merchant has nothing to do about it in the meantime.
    log.warn(
      {
        shop: shopDomain,
        reason: error instanceof MetakockaError ? error.message : String(error),
      },
      "Scheduled warehouse reload failed",
    );
    throw error;
  }
}
