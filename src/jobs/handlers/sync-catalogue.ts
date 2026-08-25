import type { Job } from "pg-boss";
import { z } from "zod";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getCredential } from "~/adapters/db/repositories/metakocka-credential.server";
import {
  applyMetakockaMatches,
  upsertVariants,
} from "~/adapters/db/repositories/sku.server";
import { getProductSyncSetting } from "~/adapters/db/repositories/product-sync-setting.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import { listProducts } from "~/adapters/metakocka/stock";
import { enqueueThrottled } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { listVariants } from "~/adapters/shopify/inventory";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { serviceToken } from "~/domain/types";

export const syncCatalogueJobSchema = z.object({
  shopDomain: z.string().min(1),
});

/**
 * Builds the SKU registry (CLAUDE.md §6, M3): read every Shopify variant that
 * has a SKU, then match it against the MetaKocka catalogue by code.
 *
 * A background job, not a request: MetaKocka has no bulk endpoint and a full
 * catalogue read is slow (§2.5, §8.9).
 */
export async function handleSyncCatalogue(job: Job<unknown>): Promise<void> {
  const { shopDomain } = syncCatalogueJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "sync-catalogue");
  const log = getLogger();

  const { admin } = await unauthenticated.admin(shopDomain);
  const variants = await listVariants(admin);
  const { created, updated } = await upsertVariants(
    principal,
    variants.map((variant) => ({
      sku: variant.sku,
      shopifyVariantId: variant.variantId,
      shopifyInventoryItemId: variant.inventoryItemId,
      title: variant.title,
    })),
  );

  const credential = await getCredential(principal);
  let matched = 0;
  let unmatched = variants.length;

  if (credential) {
    const client = new MetakockaClient({
      companyId: credential.companyId,
      secretKey: credential.secretKey,
    });
    const products = await listProducts(client);
    const result = await applyMetakockaMatches(
      principal,
      products.map((product) => ({
        code: product.code,
        mkId: product.mkId,
        name: product.name,
      })),
    );
    matched = result.matched;
    unmatched = result.unmatched;
  }

  await appendEvent(principal, {
    entityType: "sku",
    event: "catalogue.synced",
    detail: {
      variants: variants.length,
      created,
      updated,
      matched,
      unmatched,
      metakockaRead: credential !== null,
    },
  });

  // Matching first, then writing. Sending names for a SKU whose product was
  // only just matched needs the registry to be current, which it now is, and it
  // keeps the merchant to one button rather than two they must press in order.
  const productSync = await getProductSyncSetting(principal);
  if (productSync.enabled) {
    await enqueueThrottled(
      QUEUES.syncProducts,
      { shopDomain },
      `products:${shopDomain}`,
      30,
    );
  }

  log.info(
    { shop: shopDomain, variants: variants.length, matched, unmatched },
    "Catalogue synced",
  );
}
