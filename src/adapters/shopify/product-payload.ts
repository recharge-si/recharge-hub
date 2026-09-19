import { z } from "zod";

import { toMinorUnits } from "~/adapters/metakocka/values";
import type { ProductUpdate } from "~/adapters/db/repositories/catalogue.server";

/**
 * The `products/update` and `products/delete` webhook payloads, parsed at
 * the boundary (docs/BUILD_SPEC.md §4). REST-shaped: numeric ids beside
 * `admin_graphql_api_id`, tags as one comma-separated string, prices as
 * decimal strings.
 */

const productUpdateSchema = z.object({
  id: z.union([z.number(), z.string()]),
  admin_graphql_api_id: z.string().optional(),
  title: z.string(),
  handle: z.string().nullable().optional(),
  vendor: z.string().nullable().optional(),
  product_type: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  tags: z
    .union([z.string(), z.array(z.string())])
    .nullable()
    .optional(),
  updated_at: z.string().nullable().optional(),
  image: z.object({ src: z.string() }).nullable().optional(),
  variants: z
    .array(
      z.object({
        id: z.union([z.number(), z.string()]),
        admin_graphql_api_id: z.string().optional(),
        sku: z.string().nullable().optional(),
        barcode: z.string().nullable().optional(),
        title: z.string().nullable().optional(),
        price: z.union([z.string(), z.number()]),
        compare_at_price: z
          .union([z.string(), z.number()])
          .nullable()
          .optional(),
      }),
    )
    .optional(),
});

const productDeleteSchema = z.object({
  id: z.union([z.number(), z.string()]),
  admin_graphql_api_id: z.string().optional(),
});

function productGid(id: number | string, gid: string | undefined): string {
  return gid ?? `gid://shopify/Product/${id}`;
}

function variantGid(id: number | string, gid: string | undefined): string {
  return gid ?? `gid://shopify/ProductVariant/${id}`;
}

function tagsFrom(raw: string | string[] | null | undefined): string[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : raw.split(",");
  return list.map((tag) => tag.trim()).filter((tag) => tag !== "");
}

export function parseProductUpdate(payload: unknown): ProductUpdate {
  const product = productUpdateSchema.parse(payload);
  return {
    productId: productGid(product.id, product.admin_graphql_api_id),
    title: product.title,
    handle: product.handle ?? null,
    vendor: product.vendor ?? null,
    productType: product.product_type ?? null,
    // Shopify's webhook says "active"; the GraphQL read says "ACTIVE".
    status: product.status ? product.status.toUpperCase() : null,
    tags: tagsFrom(product.tags),
    imageUrl: product.image?.src ?? null,
    shopifyUpdatedAt: product.updated_at ?? null,
    variants: (product.variants ?? []).map((variant) => ({
      variantId: variantGid(variant.id, variant.admin_graphql_api_id),
      sku: variant.sku?.trim() || null,
      barcode: variant.barcode?.trim() || null,
      title: variant.title ?? null,
      priceMinor: toMinorUnits(variant.price),
      compareAtMinor:
        variant.compare_at_price === null ||
        variant.compare_at_price === undefined
          ? null
          : toMinorUnits(variant.compare_at_price),
    })),
  };
}

export function parseProductDelete(payload: unknown): { productId: string } {
  const product = productDeleteSchema.parse(payload);
  return { productId: productGid(product.id, product.admin_graphql_api_id) };
}

/** `PRODUCTS_UPDATE` and `products/update` are the same topic. */
export function normaliseTopic(topic: string): string {
  return topic.toLowerCase().replace(/_/g, "/");
}
