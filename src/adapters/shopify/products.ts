import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import type { VariantFacts } from "~/domain/products/name-template";

/**
 * Everything about a Shopify variant that a MetaKocka product name can be built
 * from (CLAUDE.md §8.9, `domain/products/name-template.ts`).
 *
 * Separate from `listVariants` in inventory.ts on purpose: the stock path wants
 * the smallest possible query on every sync, and this one is only read when the
 * merchant syncs product names.
 *
 * GraphQL Admin API only (§2.1.5), paginated, never a query in a loop (§2.5).
 */
const VARIANT_DETAILS_QUERY = `#graphql
  query OrchestratorVariantDetails($first: Int!, $cursor: String) {
    productVariants(first: $first, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        sku
        title
        barcode
        price
        selectedOptions { name value }
        product {
          title
          vendor
          productType
          handle
        }
      }
    }
  }
`;

const detailsSchema = z.object({
  data: z.object({
    productVariants: z.object({
      pageInfo: z.object({
        hasNextPage: z.boolean(),
        endCursor: z.string().nullable(),
      }),
      nodes: z.array(
        z.object({
          id: z.string(),
          sku: z.string().nullable(),
          title: z.string().nullable(),
          barcode: z.string().nullable(),
          price: z.string().nullable(),
          selectedOptions: z.array(
            z.object({ name: z.string(), value: z.string() }),
          ),
          product: z
            .object({
              title: z.string(),
              vendor: z.string().nullable(),
              productType: z.string().nullable(),
              handle: z.string().nullable(),
            })
            .nullable(),
        }),
      ),
    }),
  }),
});

export interface VariantDetail extends VariantFacts {
  variantId: string;
}

/** Shopify's placeholder option on a product that has no real options. */
const PLACEHOLDER = "Default Title";

export interface VariantDetailOptions {
  /** Page size. The settings screen asks for a handful, the job for the lot. */
  first?: number;
  /** Stop after this many pages. One page is enough to preview a template. */
  maxPages?: number;
}

export async function listVariantDetails(
  admin: AdminApiContext,
  options: VariantDetailOptions = {},
): Promise<VariantDetail[]> {
  const first = options.first ?? 250;
  const maxPages = options.maxPages ?? 200;
  const variants: VariantDetail[] = [];
  let cursor: string | null = null;

  // Bounded so a runaway cursor cannot spin forever.
  for (let page = 0; page < maxPages; page += 1) {
    const response = await admin.graphql(VARIANT_DETAILS_QUERY, {
      variables: { first, cursor },
    });
    // §4: every external boundary is parsed, including Shopify's.
    const parsed = detailsSchema.parse(await response.json());
    const { nodes, pageInfo } = parsed.data.productVariants;

    for (const node of nodes) {
      const sku = node.sku?.trim();
      // A variant with no SKU has nothing to match a MetaKocka product by.
      if (!sku) continue;

      const options = node.selectedOptions.filter(
        (option) => option.value !== PLACEHOLDER,
      );

      variants.push({
        variantId: node.id,
        sku,
        productTitle: node.product?.title ?? "",
        variantTitle: node.title,
        optionValues: options.map((option) => option.value),
        optionNames: options.map((option) => option.name),
        barcode: node.barcode,
        vendor: node.product?.vendor ?? null,
        productType: node.product?.productType ?? null,
        handle: node.product?.handle ?? null,
        price: node.price,
      });
    }

    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
  }

  return variants;
}

const TAXES_QUERY = `#graphql
  query OrchestratorTaxSettings {
    shop {
      taxesIncluded
      currencyCode
    }
  }
`;

const taxesSchema = z.object({
  data: z.object({
    shop: z.object({
      taxesIncluded: z.boolean().nullable(),
      currencyCode: z.string(),
    }),
  }),
});

export interface ShopPricing {
  /** True when the prices entered in Shopify already include tax. */
  taxesIncluded: boolean;
  currencyCode: string;
}

/**
 * Whether Shopify prices include tax. A price sent to MetaKocka as `price` when
 * it is really `price_with_tax` is wrong by the whole VAT rate, so this is read
 * rather than assumed.
 */
export async function getShopPricing(
  admin: AdminApiContext,
): Promise<ShopPricing> {
  const response = await admin.graphql(TAXES_QUERY);
  const parsed = taxesSchema.parse(await response.json());

  return {
    taxesIncluded: parsed.data.shop.taxesIncluded ?? false,
    currencyCode: parsed.data.shop.currencyCode,
  };
}
