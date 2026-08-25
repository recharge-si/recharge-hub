import type { ProductNamePolicy, ProductSyncSetting } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import { DEFAULT_NAME_PATTERN } from "~/domain/products/template";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * Product sync settings (CLAUDE.md §8.9). Every query filters by shop here so
 * route code cannot forget (§9).
 *
 * There is no row until the merchant saves one. `getProductSyncSetting` returns
 * the defaults instead of null, and the defaults write nothing: syncing is off,
 * creating products is off, and prices are off.
 */
export type { ProductSyncSetting, ProductNamePolicy };

export interface ProductSyncSettings {
  enabled: boolean;
  nameTemplate: string;
  namePolicy: ProductNamePolicy;
  createMissing: boolean;
  sendPricing: boolean;
  updatePricing: boolean;
  pricelistCode: string | null;
  pricelistIncludesTax: boolean;
  taxPercent: string | null;
  unit: string;
  lastRunAt: Date | null;
}

export const PRODUCT_SYNC_DEFAULTS: ProductSyncSettings = {
  enabled: false,
  nameTemplate: DEFAULT_NAME_PATTERN,
  namePolicy: "always",
  createMissing: false,
  sendPricing: false,
  updatePricing: false,
  pricelistCode: null,
  pricelistIncludesTax: true,
  taxPercent: null,
  unit: "kos",
  lastRunAt: null,
};

async function shopIdFor(principal: Principal): Promise<string> {
  const domain = shopDomainOf(principal);
  const shop = await prisma.shop.findUnique({
    where: { domain },
    select: { id: true },
  });
  if (!shop) throw new Error(`No shop record for ${domain}`);
  return shop.id;
}

export async function getProductSyncSetting(
  principal: Principal,
): Promise<ProductSyncSettings> {
  const row = await prisma.productSyncSetting.findFirst({
    where: { shop: { domain: shopDomainOf(principal) } },
  });

  if (!row) return { ...PRODUCT_SYNC_DEFAULTS };

  return {
    enabled: row.enabled,
    nameTemplate: row.nameTemplate,
    namePolicy: row.namePolicy,
    createMissing: row.createMissing,
    sendPricing: row.sendPricing,
    updatePricing: row.updatePricing,
    pricelistCode: row.pricelistCode,
    pricelistIncludesTax: row.pricelistIncludesTax,
    taxPercent: row.taxPercent,
    unit: row.unit,
    lastRunAt: row.lastRunAt,
  };
}

export type ProductSyncInput = Omit<ProductSyncSettings, "lastRunAt">;

export async function saveProductSyncSetting(
  principal: Principal,
  input: ProductSyncInput,
): Promise<void> {
  const shopId = await shopIdFor(principal);

  await prisma.productSyncSetting.upsert({
    where: { shopId },
    create: { shopId, ...input },
    update: input,
  });
}

export async function markProductSyncRun(
  principal: Principal,
  at: Date,
): Promise<void> {
  await prisma.productSyncSetting.updateMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    data: { lastRunAt: at },
  });
}

/**
 * Records what MetaKocka said a pricelist's price type actually is.
 *
 * The merchant sets this, but MetaKocka is the authority and says so plainly
 * when the setting is wrong. Writing the correction down means the mistake
 * costs one rejected call once, rather than every run forever.
 */
export async function savePricelistBasis(
  principal: Principal,
  includesTax: boolean,
): Promise<void> {
  await prisma.productSyncSetting.updateMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    data: { pricelistIncludesTax: includesTax },
  });
}
