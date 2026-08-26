import type { Sku } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import { shopDomainOf, type Principal } from "~/domain/types";

async function shopIdFor(principal: Principal): Promise<string> {
  const domain = shopDomainOf(principal);
  const shop = await prisma.shop.findUnique({
    where: { domain },
    select: { id: true },
  });
  if (!shop) throw new Error(`No shop record for ${domain}`);
  return shop.id;
}

export interface VariantSnapshot {
  sku: string;
  shopifyVariantId: string;
  shopifyInventoryItemId: string | null;
  title: string | null;
  variantTitle?: string | null;
  shopifyProductId?: string | null;
  imageUrl?: string | null;
  priceMinor?: number | null;
  currency?: string | null;
  vendor?: string | null;
  productType?: string | null;
}

/**
 * Records the Shopify side of the SKU registry (CLAUDE.md §6).
 * Matching against MetaKocka is a separate step, so a catalogue read never
 * clears a match that is still good.
 */
export async function upsertVariants(
  principal: Principal,
  variants: VariantSnapshot[],
): Promise<{ created: number; updated: number }> {
  const shopId = await shopIdFor(principal);

  const existing = await prisma.sku.findMany({
    where: { shopId },
    select: { sku: true },
  });
  const known = new Set(existing.map((row) => row.sku));

  let created = 0;
  let updated = 0;

  // One upsert per SKU. Prisma has no bulk upsert, and a catalogue read is a
  // background job (§2.5), not a request path.
  for (const variant of variants) {
    await prisma.sku.upsert({
      where: { shopId_sku: { shopId, sku: variant.sku } },
      create: { shopId, ...variant },
      // Deliberately field by field rather than spreading the snapshot: the
      // MetaKocka columns on this row are owned by `applyMetakockaMatches`, and
      // a catalogue read must never clear a match that is still good.
      update: {
        shopifyVariantId: variant.shopifyVariantId,
        shopifyInventoryItemId: variant.shopifyInventoryItemId,
        title: variant.title,
        variantTitle: variant.variantTitle ?? null,
        shopifyProductId: variant.shopifyProductId ?? null,
        imageUrl: variant.imageUrl ?? null,
        priceMinor: variant.priceMinor ?? null,
        currency: variant.currency ?? null,
        vendor: variant.vendor ?? null,
        productType: variant.productType ?? null,
      },
    });

    if (known.has(variant.sku)) updated += 1;
    else created += 1;
  }

  return { created, updated };
}

export interface MatchSnapshot {
  code: string;
  mkId: string;
  /** The name MetaKocka holds, so the settings screen can show what changes. */
  name: string | null;
}

/**
 * Matches the registry against the MetaKocka catalogue by code.
 *
 * A SKU that no longer has a product is set back to `unmatched` rather than
 * left pointing at something that is gone. `ignored` is the merchant's decision
 * and is never overwritten.
 */
export async function applyMetakockaMatches(
  principal: Principal,
  products: MatchSnapshot[],
): Promise<{ matched: number; unmatched: number }> {
  const shopId = await shopIdFor(principal);
  const byCode = new Map(products.map((product) => [product.code, product]));

  const rows = await prisma.sku.findMany({
    where: { shopId, status: { not: "ignored" } },
  });

  let matched = 0;
  let unmatched = 0;

  for (const row of rows) {
    const product = byCode.get(row.sku);

    if (product) {
      matched += 1;
      if (
        row.metakockaCode !== product.code ||
        row.metakockaMkId !== product.mkId ||
        row.metakockaName !== product.name ||
        row.status !== "matched"
      ) {
        await prisma.sku.update({
          where: { id: row.id },
          data: {
            metakockaCode: product.code,
            metakockaMkId: product.mkId,
            metakockaName: product.name,
            status: "matched",
          },
        });
      }
    } else {
      unmatched += 1;
      if (row.status !== "unmatched" || row.metakockaCode !== null) {
        await prisma.sku.update({
          where: { id: row.id },
          data: {
            metakockaCode: null,
            metakockaMkId: null,
            metakockaName: null,
            status: "unmatched",
          },
        });
      }
    }
  }

  return { matched, unmatched };
}

export async function countByStatus(
  principal: Principal,
): Promise<{ matched: number; unmatched: number; ignored: number }> {
  const grouped = await prisma.sku.groupBy({
    by: ["status"],
    where: { shop: { domain: shopDomainOf(principal) } },
    _count: { _all: true },
  });

  const counts = { matched: 0, unmatched: 0, ignored: 0 };
  for (const row of grouped) counts[row.status] = row._count._all;
  return counts;
}

/**
 * What MetaKocka currently calls these SKUs, for the "Now" column on the
 * settings screen.
 *
 * Read from our own registry rather than from MetaKocka: no page load may wait
 * on an ERP call (CLAUDE.md 2.5), and the catalogue read already has this.
 *
 * The three states of the result are the three the preview needs. A SKU that is
 * matched but whose name predates this column comes back as null, meaning "we
 * do not know", and is reported as unknown rather than as a rename.
 */
export async function metakockaNamesFor(
  principal: Principal,
  skus: string[],
): Promise<Map<string, string | null>> {
  if (skus.length === 0) return new Map();
  const shopId = await shopIdFor(principal);

  const rows = await prisma.sku.findMany({
    where: { shopId, sku: { in: skus }, status: "matched" },
    select: { sku: true, metakockaName: true },
  });

  return new Map(rows.map((row) => [row.sku, row.metakockaName]));
}

export interface SkuPageOptions {
  status: "matched" | "unmatched" | "ignored" | "all";
  /** Matches the SKU, the Shopify title, or the name MetaKocka holds. */
  search?: string;
  skip?: number;
  take?: number;
}

export interface SkuRow {
  id: string;
  sku: string;
  title: string | null;
  variantTitle: string | null;
  imageUrl: string | null;
  priceMinor: number | null;
  currency: string | null;
  vendor: string | null;
  status: Sku["status"];
  metakockaName: string | null;
  metakockaMkId: string | null;
  /** Free to sell across every enabled source, or null when nothing is mapped. */
  stock: number | null;
}

/**
 * One page of the product list.
 *
 * The list used to be ten unmatched codes and nothing else, which is a
 * diagnostic, not a product list — a merchant looking for "the blue one"
 * recognises it by its picture and its price, not by P04200014440. So the row
 * carries what makes a product recognisable, and every field of it comes from
 * the catalogue read that was already walking every variant. Nothing here
 * queries Shopify or MetaKocka at page load (CLAUDE.md §2.5).
 *
 * Stock is joined in because it is the other question anyone opens this page
 * with, and it is the figure that decides whether an order can be allocated at
 * all. Null means no warehouse is mapped to a source yet, which reads
 * differently from zero and should.
 */
export async function listSkuPage(
  principal: Principal,
  options: SkuPageOptions,
): Promise<SkuRow[]> {
  const search = options.search?.trim();

  const rows = await prisma.sku.findMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      ...(options.status === "all" ? {} : { status: options.status }),
      ...(search
        ? {
            OR: [
              { sku: { contains: search, mode: "insensitive" } },
              { title: { contains: search, mode: "insensitive" } },
              { metakockaName: { contains: search, mode: "insensitive" } },
              { vendor: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      sku: true,
      title: true,
      variantTitle: true,
      imageUrl: true,
      priceMinor: true,
      currency: true,
      vendor: true,
      status: true,
      metakockaName: true,
      metakockaMkId: true,
      supplyLevels: {
        where: { supplySource: { enabled: true } },
        select: { quantity: true, reserved: true },
      },
    },
    orderBy: [{ status: "asc" }, { sku: "asc" }],
    skip: options.skip ?? 0,
    take: options.take ?? 25,
  });

  return rows.map((row) => ({
    id: row.id,
    sku: row.sku,
    title: row.title,
    variantTitle: row.variantTitle,
    imageUrl: row.imageUrl,
    priceMinor: row.priceMinor,
    currency: row.currency,
    vendor: row.vendor,
    status: row.status,
    metakockaName: row.metakockaName,
    metakockaMkId: row.metakockaMkId,
    stock:
      row.supplyLevels.length === 0
        ? null
        : row.supplyLevels.reduce(
            // What is free to sell, not what is physically there — the same
            // figure the allocator works from (§8.2).
            (sum, level) => sum + Math.max(0, level.quantity - level.reserved),
            0,
          ),
  }));
}
