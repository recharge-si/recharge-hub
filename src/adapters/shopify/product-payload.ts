import { z } from "zod";

import { toMinorUnits } from "~/adapters/metakocka/values";
import { plainDescription } from "~/adapters/shopify/catalogue";
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
  body_html: z.string().nullable().optional(),
  options: z
    .array(z.object({ name: z.string(), position: z.number().optional() }))
    .optional(),
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
        option1: z.string().nullable().optional(),
        option2: z.string().nullable().optional(),
        option3: z.string().nullable().optional(),
        inventory_quantity: z.number().int().nullable().optional(),
        inventory_management: z.string().nullable().optional(),
        inventory_policy: z.string().nullable().optional(),
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
    description: plainDescription(product.body_html),
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
      options: optionsFrom(product.options ?? [], [
        variant.option1,
        variant.option2,
        variant.option3,
      ]),
      ...stockFrom(variant),
    })),
  };
}

/** The variant's chosen values paired with the product's option names, in order. */
function optionsFrom(
  names: Array<{ name: string; position?: number | undefined }>,
  values: Array<string | null | undefined>,
): Array<{ name: string; value: string }> {
  const ordered = [...names].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0),
  );
  const out: Array<{ name: string; value: string }> = [];
  ordered.forEach((option, index) => {
    const value = values[index];
    if (value) out.push({ name: option.name, value });
  });
  return out;
}

/**
 * Stock as the snapshot holds it. The payload has no `availableForSale`, so
 * it is read the way Shopify sells: a variant that does not track inventory is
 * always available; a tracked one when units remain or overselling is allowed.
 * The quantity is only meaningful for a tracked variant.
 */
function stockFrom(variant: {
  inventory_quantity?: number | null | undefined;
  inventory_management?: string | null | undefined;
  inventory_policy?: string | null | undefined;
}): { inventoryQuantity: number | null; availableForSale: boolean } {
  const tracked = Boolean(variant.inventory_management);
  const quantity = tracked ? (variant.inventory_quantity ?? 0) : null;
  const available =
    !tracked || (quantity ?? 0) > 0 || variant.inventory_policy === "continue";
  return { inventoryQuantity: quantity, availableForSale: available };
}

export function parseProductDelete(payload: unknown): { productId: string } {
  const product = productDeleteSchema.parse(payload);
  return { productId: productGid(product.id, product.admin_graphql_api_id) };
}

/** `PRODUCTS_UPDATE` and `products/update` are the same topic. */
export function normaliseTopic(topic: string): string {
  return topic.toLowerCase().replace(/_/g, "/");
}
