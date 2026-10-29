import { prisma } from "~/adapters/db/client.server";
import { metafieldsFrom } from "~/adapters/db/repositories/catalogue.server";
import { assignmentsFor } from "~/adapters/db/repositories/product-type-assignment.server";
import type { AttributeSchema } from "~/domain/attributes/types";
import { filledKeys, type CoverageProduct } from "~/domain/attributes/coverage";
import type { FillProduct } from "~/domain/products/fill";
import type { MetafieldMap } from "~/domain/sales/types";
import { typeForProduct } from "~/domain/products/workspace";
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

const PAGE = 500;

/**
 * Every catalogue product with its plan type and the recharge keys it holds,
 * for the rig readiness numbers. Read a page at a time and reduced to keys at
 * once, so a large catalogue is not held whole.
 */
export async function catalogueForCoverage(
  principal: Principal,
  schema: AttributeSchema,
): Promise<CoverageProduct[]> {
  const where = { shop: { domain: shopDomainOf(principal) } };
  const out: CoverageProduct[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.catalogProduct.findMany({
      where,
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        shopifyProductId: true,
        categoryName: true,
        productType: true,
        metafields: true,
        variants: { select: { metafields: true } },
      },
    });
    if (page.length === 0) break;
    const chosen = await assignmentsFor(
      principal,
      page.map((row) => row.shopifyProductId),
    );
    for (const row of page) {
      const match = typeForProduct(schema, {
        categoryName: row.categoryName,
        categoryFullName: null,
        productType: row.productType,
        chosenTypeId: chosen.get(row.shopifyProductId)?.typeId ?? null,
      });
      out.push({
        productId: row.shopifyProductId,
        typeId: match.kind === "matched" ? match.typeId : null,
        filled: filledKeys(schema, {
          metafields: Object.keys(metafieldsFrom(row.metafields)),
          variants: row.variants.map((variant) => ({
            metafields: Object.keys(metafieldsFrom(variant.metafields)),
          })),
        }),
      });
    }
    cursor = page[page.length - 1]?.id;
    if (page.length < PAGE) break;
  }
  return out;
}
