import {
  markVerified,
  saveCredential,
} from "~/adapters/db/repositories/metakocka-credential.server";
import {
  replaceCatalogue,
  setShopContext,
} from "~/adapters/db/repositories/catalogue.server";
import { markSetupComplete } from "~/adapters/db/repositories/shop.server";
import { replaceCachedWarehouses } from "~/adapters/db/repositories/supply-source.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import type { ShopSession } from "~/domain/types";
import { INHERIT } from "~/web/lib/locations";
import { saveLocationMapping } from "~/web/lib/locations.server";

import type { TestShop } from "./test";

/**
 * Shops in a known state, built with the same repository calls the app makes,
 * so a spec can start where a merchant would be after setup instead of
 * clicking through it again. Guided setup itself is covered by setup.spec.ts.
 */

export function ownerOf(shop: TestShop): ShopSession {
  return { kind: "shop", shopDomain: shop.domain, isShopOwner: true };
}

export interface ConnectedShopOptions {
  /** Shopify location id -> MetaKocka warehouse mark. */
  locations: Record<string, string>;
  /** Stock direction for every mapped location; the shop default otherwise. */
  direction?: "mk_to_shopify" | "shopify_to_mk" | "none";
  /**
   * Match the catalogue by running the real `sync-catalogue` job once. Off by
   * default: it waits on the worker, and only specs that touch SKUs need it.
   */
  matchCatalogue?: boolean;
}

/**
 * A shop that finished setup: MetaKocka connected and verified, the company's
 * warehouses cached, the given locations mapped and, when asked, the catalogue
 * matched. Seed the fake services first — this reads the warehouses and the
 * catalogue from them.
 */
export async function seedConnectedShop(
  shop: TestShop,
  options: ConnectedShopOptions,
): Promise<void> {
  const owner = ownerOf(shop);
  const { shopify, metakocka } = await shop.services();

  await saveCredential(owner, {
    companyId: shop.metakockaCompanyId,
    secretKey: "e2e-secret",
    apiUserEmail: "api@e2e.test",
  });
  await markVerified(owner);

  await replaceCachedWarehouses(
    owner,
    metakocka.warehouses.map((warehouse) => ({
      mkId: warehouse.mkId,
      mark: warehouse.mark,
      name: warehouse.name,
      isMain: warehouse.main,
      isActive: true,
      includeInStockInfo: true,
    })),
  );

  for (const [locationId, mark] of Object.entries(options.locations)) {
    const location = shopify.locations.find((entry) => entry.id === locationId);
    const outcome = await saveLocationMapping(owner, {
      shopifyLocationId: locationId,
      warehouseMark: mark,
      locationName: location?.name ?? locationId,
      direction: options.direction ?? INHERIT,
      profitCenter: INHERIT,
    });
    if (!outcome.ok)
      throw new Error(`seed: mapping ${locationId}: ${outcome.message}`);
  }

  await markSetupComplete(owner, new Date());

  if (options.matchCatalogue) {
    await enqueue(QUEUES.syncCatalogue, { shopDomain: shop.domain });
    await shop.settleJobs();
  }
}

/** Shopify's decimal string as minor units, the way the snapshot stores money. */
function minor(amount: string): number {
  return Math.round(Number(amount) * 100);
}

/**
 * The catalogue snapshot sale campaigns target (docs/sale-campaigns.md), as
 * the `catalogue-snapshot` job would have stored it from the fake store. The
 * job itself reads through a bulk operation and a JSONL download, which the
 * fake services do not model.
 */
export async function seedCatalogueSnapshot(shop: TestShop): Promise<void> {
  const owner = ownerOf(shop);
  const { shopify } = await shop.services();

  await setShopContext(owner, {
    ianaTimezone: shopify.ianaTimezone,
    currencyCode: shopify.currencyCode,
  });
  await replaceCatalogue(
    owner,
    shopify.products.map((product) => ({
      productId: product.id,
      title: product.title,
      handle: product.handle,
      vendor: product.vendor,
      productType: product.productType,
      status: product.status,
      tags: product.tags,
      collectionIds: [],
      categoryId: null,
      categoryName: null,
      imageUrl: null,
      shopifyUpdatedAt: new Date().toISOString(),
      metafields: product.metafields,
      variants: product.variants.map((variant) => ({
        variantId: variant.id,
        productId: product.id,
        sku: variant.sku,
        barcode: null,
        title: variant.title,
        priceMinor: minor(variant.price),
        compareAtMinor:
          variant.compareAtPrice === null
            ? null
            : minor(variant.compareAtPrice),
        metafields: variant.metafields,
      })),
    })),
    shopify.currencyCode,
    new Date(),
  );
}
