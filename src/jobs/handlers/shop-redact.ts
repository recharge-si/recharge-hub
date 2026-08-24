import type { Job } from "pg-boss";

import { purgeShop } from "~/adapters/db/repositories/shop.server";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  shopRedactSchema,
  webhookJobSchema,
} from "~/adapters/shopify/compliance-payloads";
import { serviceToken } from "~/domain/types";

/**
 * CLAUDE.md section 2.4: `shop/redact` must actually delete, not soft-delete.
 * Shopify sends it 48 hours after uninstall, which is also the window in which a
 * merchant can reinstall and keep their configuration.
 *
 * Note that the purge also removes this shop's idempotency keys, including the
 * one guarding this very job. That is the right trade: keeping the key would
 * retain the shop domain past the redaction, and a second delivery would simply
 * delete nothing.
 */
export async function handleShopRedact(job: Job<unknown>): Promise<void> {
  const envelope = webhookJobSchema.parse(job.data);
  const payload = shopRedactSchema.parse(envelope.payload);
  const principal = serviceToken(payload.shop_domain, "shop-redact");

  const deleted = await purgeShop(principal);

  getLogger().info(
    { shop: payload.shop_domain, webhookId: envelope.webhookId, deleted },
    "shop/redact processed",
  );
}
