import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import type { CatalogueProductRecord } from "~/adapters/shopify/catalogue";
import type { PriceList } from "~/adapters/shopify/price-lists";
import type { CatalogueVariantFacts, MetafieldMap } from "~/domain/sales/types";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * The catalogue snapshot (docs/sale-campaigns.md § Data model): what a sale
 * campaign's rules are evaluated against. Tenant-scoped at this boundary,
 * like every repository here.
 */

async function shopIdFor(principal: Principal): Promise<string> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: { id: true },
  });
  if (!shop) throw new Error(`Unknown shop ${shopDomainOf(principal)}`);
  return shop.id;
}

/** JSON in, `MetafieldMap` out, tolerating an old or malformed column. */
function metafieldsFrom(json: Prisma.JsonValue | null): MetafieldMap {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  const map: MetafieldMap = {};
  for (const [name, entry] of Object.entries(json)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { type, value } = entry as Record<string, unknown>;
    if (typeof type === "string" && typeof value === "string") {
      map[name] = { type, value };
    }
  }
  return map;
}

/** The other direction: a plain `{ name: { type, value } }` object is JSON. */
function toJson(map: MetafieldMap): Prisma.InputJsonValue {
  const json: Record<string, { type: string; value: string }> = {};
  for (const [name, entry] of Object.entries(map)) {
    json[name] = { type: entry.type, value: entry.value };
  }
  return json;
}

/* -------------------------------------------------------------------------- */
/* Snapshot state                                                             */
/* -------------------------------------------------------------------------- */

export interface CatalogueState {
  snapshotAt: Date | null;
  bulkOperationId: string | null;
  bulkStartedAt: Date | null;
  ianaTimezone: string | null;
  currencyCode: string | null;
  products: number;
  variants: number;
}

export async function getCatalogueState(
  principal: Principal,
): Promise<CatalogueState> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: {
      id: true,
      catalogueSnapshotAt: true,
      catalogueBulkOperationId: true,
      catalogueBulkStartedAt: true,
      ianaTimezone: true,
      currencyCode: true,
    },
  });
  if (!shop) throw new Error(`Unknown shop ${shopDomainOf(principal)}`);

  const [products, variants] = await Promise.all([
    prisma.catalogProduct.count({ where: { shopId: shop.id } }),
    prisma.catalogVariant.count({ where: { shopId: shop.id } }),
  ]);

  return {
    snapshotAt: shop.catalogueSnapshotAt,
    bulkOperationId: shop.catalogueBulkOperationId,
    bulkStartedAt: shop.catalogueBulkStartedAt,
    ianaTimezone: shop.ianaTimezone,
    currencyCode: shop.currencyCode,
    products,
    variants,
  };
}

/** Records the bulk operation reading the catalogue now, or clears it. */
export async function setCatalogueBulkOperation(
  principal: Principal,
  operation: { id: string; startedAt: Date } | null,
): Promise<void> {
  await prisma.shop.updateMany({
    where: { domain: shopDomainOf(principal) },
    data: {
      catalogueBulkOperationId: operation?.id ?? null,
      catalogueBulkStartedAt: operation?.startedAt ?? null,
    },
  });
}

export async function setShopContext(
  principal: Principal,
  context: { ianaTimezone: string; currencyCode: string },
): Promise<void> {
  await prisma.shop.updateMany({
    where: { domain: shopDomainOf(principal) },
    data: context,
  });
}

/* -------------------------------------------------------------------------- */
/* Replacing and updating                                                     */
/* -------------------------------------------------------------------------- */

/** How many rows one INSERT carries. */
const INSERT_CHUNK = 1000;

/**
 * Replaces the shop's catalogue with a fresh read, in one transaction, so a
 * reader never sees half a catalogue. Ids are minted here because `createMany`
 * cannot return them and the variants need their product's.
 */
export async function replaceCatalogue(
  principal: Principal,
  products: readonly CatalogueProductRecord[],
  currency: string,
  now: Date,
): Promise<{ products: number; variants: number }> {
  const shopId = await shopIdFor(principal);

  const productRows: Prisma.CatalogProductCreateManyInput[] = [];
  const variantRows: Prisma.CatalogVariantCreateManyInput[] = [];

  for (const product of products) {
    const id = randomUUID();
    productRows.push({
      id,
      shopId,
      shopifyProductId: product.productId,
      title: product.title,
      handle: product.handle,
      vendor: product.vendor,
      productType: product.productType,
      status: product.status,
      tags: [...product.tags],
      collectionIds: [...product.collectionIds],
      categoryId: product.categoryId,
      categoryName: product.categoryName,
      metafields: toJson(product.metafields),
      imageUrl: product.imageUrl,
      shopifyUpdatedAt: product.shopifyUpdatedAt
        ? new Date(product.shopifyUpdatedAt)
        : null,
      observedAt: now,
    });
    for (const variant of product.variants) {
      variantRows.push({
        id: randomUUID(),
        shopId,
        productId: id,
        shopifyVariantId: variant.variantId,
        sku: variant.sku,
        barcode: variant.barcode,
        title: variant.title,
        priceMinor: variant.priceMinor,
        compareAtMinor: variant.compareAtMinor,
        currency,
        metafields: toJson(variant.metafields),
        observedAt: now,
      });
    }
  }

  await prisma.$transaction(
    async (tx) => {
      await tx.catalogProduct.deleteMany({ where: { shopId } });
      for (let start = 0; start < productRows.length; start += INSERT_CHUNK) {
        await tx.catalogProduct.createMany({
          data: productRows.slice(start, start + INSERT_CHUNK),
        });
      }
      for (let start = 0; start < variantRows.length; start += INSERT_CHUNK) {
        await tx.catalogVariant.createMany({
          data: variantRows.slice(start, start + INSERT_CHUNK),
        });
      }
      await tx.shop.update({
        where: { id: shopId },
        data: {
          catalogueSnapshotAt: now,
          catalogueBulkOperationId: null,
          catalogueBulkStartedAt: null,
        },
      });
    },
    { timeout: 120_000 },
  );

  return { products: productRows.length, variants: variantRows.length };
}

/** What a `products/update` payload can tell us. Collections and metafields are not in it. */
export interface ProductUpdate {
  productId: string;
  title: string;
  handle: string | null;
  vendor: string | null;
  productType: string | null;
  status: string | null;
  tags: string[];
  imageUrl: string | null;
  shopifyUpdatedAt: string | null;
  variants: Array<{
    variantId: string;
    sku: string | null;
    barcode: string | null;
    title: string | null;
    priceMinor: number;
    compareAtMinor: number | null;
  }>;
}

/**
 * Keeps a product current between snapshots. A product the snapshot has
 * never seen is inserted (a new product joins a dynamic campaign this way);
 * a variant the payload no longer lists is removed.
 */
export async function applyProductUpdate(
  principal: Principal,
  update: ProductUpdate,
  now: Date,
): Promise<{ changed: boolean }> {
  const shopId = await shopIdFor(principal);

  /*
   * `products/update` fires for things a sale does not read — an inventory
   * quantity moving, an image — and the stock sync moves quantities every
   * five minutes. A write per delivery would be most of the table's writes,
   * so the row is compared first and left alone when nothing here moved.
   */
  const existing = await prisma.catalogProduct.findUnique({
    where: {
      shopId_shopifyProductId: { shopId, shopifyProductId: update.productId },
    },
    select: {
      title: true,
      handle: true,
      vendor: true,
      productType: true,
      status: true,
      tags: true,
      imageUrl: true,
      variants: {
        select: {
          shopifyVariantId: true,
          sku: true,
          barcode: true,
          title: true,
          priceMinor: true,
          compareAtMinor: true,
        },
      },
    },
  });
  if (existing && sameProduct(existing, update)) return { changed: false };

  const currency =
    (
      await prisma.shop.findUnique({
        where: { id: shopId },
        select: { currencyCode: true },
      })
    )?.currencyCode ?? "";

  await prisma.$transaction(async (tx) => {
    const product = await tx.catalogProduct.upsert({
      where: {
        shopId_shopifyProductId: {
          shopId,
          shopifyProductId: update.productId,
        },
      },
      create: {
        shopId,
        shopifyProductId: update.productId,
        title: update.title,
        handle: update.handle,
        vendor: update.vendor,
        productType: update.productType,
        status: update.status,
        tags: update.tags,
        collectionIds: [],
        imageUrl: update.imageUrl,
        shopifyUpdatedAt: update.shopifyUpdatedAt
          ? new Date(update.shopifyUpdatedAt)
          : null,
        observedAt: now,
      },
      update: {
        title: update.title,
        handle: update.handle,
        vendor: update.vendor,
        productType: update.productType,
        status: update.status,
        tags: update.tags,
        imageUrl: update.imageUrl,
        shopifyUpdatedAt: update.shopifyUpdatedAt
          ? new Date(update.shopifyUpdatedAt)
          : null,
        observedAt: now,
      },
      select: { id: true },
    });

    const keep = update.variants.map((variant) => variant.variantId);
    await tx.catalogVariant.deleteMany({
      where: { productId: product.id, shopifyVariantId: { notIn: keep } },
    });

    for (const variant of update.variants) {
      await tx.catalogVariant.upsert({
        where: {
          shopId_shopifyVariantId: {
            shopId,
            shopifyVariantId: variant.variantId,
          },
        },
        create: {
          shopId,
          productId: product.id,
          shopifyVariantId: variant.variantId,
          sku: variant.sku,
          barcode: variant.barcode,
          title: variant.title,
          priceMinor: variant.priceMinor,
          compareAtMinor: variant.compareAtMinor,
          currency,
          observedAt: now,
        },
        update: {
          productId: product.id,
          sku: variant.sku,
          barcode: variant.barcode,
          title: variant.title,
          priceMinor: variant.priceMinor,
          compareAtMinor: variant.compareAtMinor,
          observedAt: now,
        },
      });
    }
  });
  return { changed: true };
}

/** Whether a payload says anything the snapshot does not already hold. */
function sameProduct(
  existing: {
    title: string;
    handle: string | null;
    vendor: string | null;
    productType: string | null;
    status: string | null;
    tags: string[];
    imageUrl: string | null;
    variants: Array<{
      shopifyVariantId: string;
      sku: string | null;
      barcode: string | null;
      title: string | null;
      priceMinor: number;
      compareAtMinor: number | null;
    }>;
  },
  update: ProductUpdate,
): boolean {
  if (
    existing.title !== update.title ||
    existing.handle !== update.handle ||
    existing.vendor !== update.vendor ||
    existing.productType !== update.productType ||
    existing.status !== update.status ||
    existing.imageUrl !== update.imageUrl ||
    existing.tags.length !== update.tags.length ||
    existing.tags.some((tag, index) => tag !== update.tags[index]) ||
    existing.variants.length !== update.variants.length
  ) {
    return false;
  }
  const byId = new Map(existing.variants.map((v) => [v.shopifyVariantId, v]));
  return update.variants.every((variant) => {
    const have = byId.get(variant.variantId);
    return (
      have !== undefined &&
      have.sku === variant.sku &&
      have.barcode === variant.barcode &&
      have.title === variant.title &&
      have.priceMinor === variant.priceMinor &&
      have.compareAtMinor === variant.compareAtMinor
    );
  });
}

export async function removeCatalogueProduct(
  principal: Principal,
  productId: string,
): Promise<void> {
  const shopId = await shopIdFor(principal);
  await prisma.catalogProduct.deleteMany({
    where: { shopId, shopifyProductId: productId },
  });
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

type ProductRow = Prisma.CatalogProductGetPayload<{
  select: {
    shopifyProductId: true;
    title: true;
    handle: true;
    vendor: true;
    productType: true;
    status: true;
    tags: true;
    collectionIds: true;
    categoryId: true;
    metafields: true;
  };
}>;

type VariantRow = Prisma.CatalogVariantGetPayload<{
  select: {
    shopifyVariantId: true;
    sku: true;
    barcode: true;
    title: true;
    priceMinor: true;
    compareAtMinor: true;
    metafields: true;
  };
}>;

const PRODUCT_SELECT = {
  shopifyProductId: true,
  title: true,
  handle: true,
  vendor: true,
  productType: true,
  status: true,
  tags: true,
  collectionIds: true,
  categoryId: true,
  metafields: true,
} as const;

const VARIANT_SELECT = {
  shopifyVariantId: true,
  sku: true,
  barcode: true,
  title: true,
  priceMinor: true,
  compareAtMinor: true,
  metafields: true,
} as const;

function factsFrom(
  product: ProductRow,
  variant: VariantRow,
): CatalogueVariantFacts {
  return {
    variantId: variant.shopifyVariantId,
    productId: product.shopifyProductId,
    sku: variant.sku,
    barcode: variant.barcode,
    variantTitle: variant.title,
    priceMinor: variant.priceMinor,
    compareAtMinor: variant.compareAtMinor,
    variantMetafields: metafieldsFrom(variant.metafields),
    productTitle: product.title,
    handle: product.handle,
    vendor: product.vendor,
    productType: product.productType,
    status: product.status,
    tags: product.tags,
    collectionIds: product.collectionIds,
    categoryId: product.categoryId,
    productMetafields: metafieldsFrom(product.metafields),
  };
}

/**
 * Every variant with its product, as rule facts. The whole catalogue in
 * memory: a preview is one pass over it, and the biggest catalogue this app
 * is built for fits comfortably.
 */
export async function loadCatalogueFacts(
  principal: Principal,
  filter: { productIds?: readonly string[] } = {},
): Promise<CatalogueVariantFacts[]> {
  const shopId = await shopIdFor(principal);
  const products = await prisma.catalogProduct.findMany({
    where: {
      shopId,
      ...(filter.productIds
        ? { shopifyProductId: { in: [...filter.productIds] } }
        : {}),
    },
    select: { ...PRODUCT_SELECT, variants: { select: VARIANT_SELECT } },
  });

  const facts: CatalogueVariantFacts[] = [];
  for (const product of products) {
    for (const variant of product.variants) {
      facts.push(factsFrom(product, variant));
    }
  }
  return facts;
}

export interface CatalogueFacets {
  vendors: string[];
  productTypes: string[];
  tags: string[];
  statuses: string[];
  categories: Array<{ id: string; name: string }>;
}

/** The distinct values the rule builder offers instead of free text. */
export async function catalogueFacets(
  principal: Principal,
): Promise<CatalogueFacets> {
  const shopId = await shopIdFor(principal);
  const rows = await prisma.catalogProduct.findMany({
    where: { shopId },
    select: {
      vendor: true,
      productType: true,
      tags: true,
      status: true,
      categoryId: true,
      categoryName: true,
    },
  });

  const vendors = new Set<string>();
  const productTypes = new Set<string>();
  const tags = new Set<string>();
  const statuses = new Set<string>();
  const categories = new Map<string, string>();
  for (const row of rows) {
    if (row.vendor) vendors.add(row.vendor);
    if (row.productType) productTypes.add(row.productType);
    if (row.status) statuses.add(row.status);
    if (row.categoryId)
      categories.set(row.categoryId, row.categoryName ?? row.categoryId);
    for (const tag of row.tags) tags.add(tag);
  }
  const sorted = (set: Set<string>) =>
    [...set].sort((a, b) => a.localeCompare(b));
  return {
    vendors: sorted(vendors),
    productTypes: sorted(productTypes),
    tags: sorted(tags),
    statuses: sorted(statuses),
    categories: [...categories]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export interface CatalogueProductView {
  productId: string;
  title: string;
  handle: string | null;
  vendor: string | null;
  productType: string | null;
  status: string | null;
  imageUrl: string | null;
  observedAt: Date;
  variants: Array<{
    variantId: string;
    sku: string | null;
    title: string | null;
    priceMinor: number;
    compareAtMinor: number | null;
    currency: string;
  }>;
}

/** One product as the product page shows it, from the snapshot. */
export async function getCatalogueProduct(
  principal: Principal,
  productId: string,
): Promise<CatalogueProductView | null> {
  const shopId = await shopIdFor(principal);
  const product = await prisma.catalogProduct.findUnique({
    where: { shopId_shopifyProductId: { shopId, shopifyProductId: productId } },
    select: {
      shopifyProductId: true,
      title: true,
      handle: true,
      vendor: true,
      productType: true,
      status: true,
      imageUrl: true,
      observedAt: true,
      variants: {
        select: {
          shopifyVariantId: true,
          sku: true,
          title: true,
          priceMinor: true,
          compareAtMinor: true,
          currency: true,
        },
        orderBy: { shopifyVariantId: "asc" },
      },
    },
  });
  if (!product) return null;
  return {
    productId: product.shopifyProductId,
    title: product.title,
    handle: product.handle,
    vendor: product.vendor,
    productType: product.productType,
    status: product.status,
    imageUrl: product.imageUrl,
    observedAt: product.observedAt,
    variants: product.variants.map((variant) => ({
      variantId: variant.shopifyVariantId,
      sku: variant.sku,
      title: variant.title,
      priceMinor: variant.priceMinor,
      compareAtMinor: variant.compareAtMinor,
      currency: variant.currency,
    })),
  };
}

/** Titles and images for a set of products, for preview and variant lists. */
export async function describeProducts(
  principal: Principal,
  productIds: readonly string[],
): Promise<
  Map<string, { title: string; imageUrl: string | null; handle: string | null }>
> {
  if (productIds.length === 0) return new Map();
  const shopId = await shopIdFor(principal);
  const rows = await prisma.catalogProduct.findMany({
    where: { shopId, shopifyProductId: { in: [...productIds] } },
    select: {
      shopifyProductId: true,
      title: true,
      imageUrl: true,
      handle: true,
    },
  });
  return new Map(
    rows.map((row) => [
      row.shopifyProductId,
      { title: row.title, imageUrl: row.imageUrl, handle: row.handle },
    ]),
  );
}

/* -------------------------------------------------------------------------- */
/* Price lists                                                                */
/* -------------------------------------------------------------------------- */

export async function replacePriceLists(
  principal: Principal,
  lists: readonly PriceList[],
  now: Date,
): Promise<void> {
  const shopId = await shopIdFor(principal);
  await prisma.$transaction([
    prisma.catalogPriceList.deleteMany({ where: { shopId } }),
    prisma.catalogPriceList.createMany({
      data: lists.map((list) => ({
        shopId,
        shopifyPriceListId: list.priceListId,
        name: list.name,
        currency: list.currency,
        fixedPricesCount: list.fixedPricesCount,
        adjustmentType: list.adjustmentType,
        adjustmentValue: list.adjustmentValue,
        observedAt: now,
      })),
    }),
  ]);
}

export async function listCachedPriceLists(principal: Principal) {
  const shopId = await shopIdFor(principal);
  return prisma.catalogPriceList.findMany({
    where: { shopId },
    orderBy: { name: "asc" },
  });
}
