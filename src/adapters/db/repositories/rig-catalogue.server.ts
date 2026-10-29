import { prisma } from "~/adapters/db/client.server";
import { metafieldsFrom } from "~/adapters/db/repositories/catalogue.server";
import type { FillProduct } from "~/domain/products/fill";
import type { MetafieldMap } from "~/domain/sales/types";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * Catalogue reads for the rig work (docs/attributes.md § Bulk filling with
 * claude-pool, § Rig readiness). Every query is scoped to the shop.
 */

/** A catalogue product as the bulk filler reads it (the snapshot holds no description or variant options). */
export interface FillCatalogueProduct {
  productId: string;
  product: FillProduct;
  metafields: MetafieldMap;
  variants: Array<{ variantId: string; metafields: MetafieldMap }>;
  categoryName: string | null;
  productType: string | null;
}

export async function catalogueForFill(
  principal: Principal,
  productIds: readonly string[],
): Promise<FillCatalogueProduct[]> {
  if (productIds.length === 0) return [];
  const rows = await prisma.catalogProduct.findMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      shopifyProductId: { in: [...productIds] },
    },
    include: { variants: true },
    orderBy: { shopifyProductId: "asc" },
  });
  return rows.map((row) => ({
    productId: row.shopifyProductId,
    categoryName: row.categoryName,
    productType: row.productType,
    metafields: metafieldsFrom(row.metafields),
    variants: row.variants.map((variant) => ({
      variantId: variant.shopifyVariantId,
      metafields: metafieldsFrom(variant.metafields),
    })),
    product: {
      title: row.title,
      vendor: row.vendor ?? "",
      productType: row.productType ?? "",
      category: row.categoryName,
      tags: row.tags,
      description: "",
      variants: row.variants.map((variant) => ({
        variantId: variant.shopifyVariantId,
        title: variant.title ?? "",
        options: [],
      })),
    },
  }));
}
