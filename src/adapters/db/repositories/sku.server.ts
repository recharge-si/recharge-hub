import type { Sku } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import { shopDomainOf, type Principal } from "~/domain/types";

export type { Sku };

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
      update: {
        shopifyVariantId: variant.shopifyVariantId,
        shopifyInventoryItemId: variant.shopifyInventoryItemId,
        title: variant.title,
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

export async function listSkus(
  principal: Principal,
  status: "matched" | "unmatched" | "ignored" | "all",
  take = 50,
): Promise<Sku[]> {
  return prisma.sku.findMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      ...(status === "all" ? {} : { status }),
    },
    orderBy: { sku: "asc" },
    take,
  });
}

export async function setSkuStatus(
  principal: Principal,
  id: string,
  status: "unmatched" | "ignored",
): Promise<void> {
  await prisma.sku.updateMany({
    where: { id, shop: { domain: shopDomainOf(principal) } },
    data: { status },
  });
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
