import type { Job } from "pg-boss";
import { z } from "zod";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getCredential } from "~/adapters/db/repositories/metakocka-credential.server";
import {
  listCachedPaymentTypes,
  replaceCachedPaymentTypes,
} from "~/adapters/db/repositories/payment-type-map.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import { MetakockaError } from "~/adapters/metakocka/errors";
import { discoverPaymentTypes } from "~/adapters/metakocka/payment-types";
import { getLogger } from "~/adapters/observability/logger.server";
import { serviceToken } from "~/domain/types";

export const reloadPaymentTypesJobSchema = z.object({
  shopDomain: z.string().min(1),
});

/**
 * Refreshes the cached MetaKocka payment types.
 *
 * This used to happen only when the merchant pressed a button, which meant a
 * type added in MetaKocka was invisible here until somebody remembered — and
 * `payment_type` has to match the register exactly (§8.7), so an unmapped
 * gateway is the direct consequence of a stale list.
 *
 * The read is a probe rather than a list endpoint: no MetaKocka endpoint
 * returns the payment types, so `discoverPaymentTypes` sends a document that
 * fails validation on purpose and reads the valid set out of the error. Nothing
 * is created. That is also why this runs nightly rather than on the
 * quarter-hourly tick the warehouses use: a rejected request every fifteen
 * minutes would fill the merchant's own API log with failures that are not
 * failures, and a payment register changes a few times a year.
 *
 * Anything the merchant typed in by hand survives: the two sets are merged, so
 * a value MetaKocka's error string omits is not silently dropped from under a
 * mapping that depends on it.
 */
export async function handleReloadPaymentTypes(
  job: Job<unknown>,
): Promise<void> {
  const { shopDomain } = reloadPaymentTypesJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "reload-payment-types");
  const log = getLogger();

  const credential = await getCredential(principal);
  if (!credential) return;

  try {
    const client = new MetakockaClient(
      { companyId: credential.companyId, secretKey: credential.secretKey },
      { timeoutMs: 30_000 },
    );
    const discovered = await discoverPaymentTypes(client);

    // Null means the error string did not parse. Never overwrite a good list
    // with nothing: the merchant's mappings point at these values.
    if (!discovered) {
      log.warn(
        { shop: shopDomain },
        "MetaKocka did not return a readable payment type list",
      );
      return;
    }

    const existing = await listCachedPaymentTypes(principal);
    const known = existing.map((type) => type.value);
    const merged = [...new Set([...discovered, ...known])];

    await replaceCachedPaymentTypes(principal, merged);

    const added = discovered.filter((value) => !known.includes(value));
    if (added.length > 0) {
      await appendEvent(principal, {
        entityType: "payment_type",
        event: "payment_types.discovered",
        detail: { added },
      });
    }

    log.info(
      { shop: shopDomain, types: merged.length, added: added.length },
      "Reloaded MetaKocka payment types",
    );
  } catch (error) {
    // Retryable, not a business exception (§11): the next run picks it up and
    // there is nothing for the merchant to do in the meantime.
    log.warn(
      {
        shop: shopDomain,
        reason: error instanceof MetakockaError ? error.message : String(error),
      },
      "Scheduled payment type reload failed",
    );
    throw error;
  }
}
