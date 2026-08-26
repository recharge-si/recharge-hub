import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import type {
  MetafieldDefinition,
  VariantFacts,
} from "~/domain/products/template";

/**
 * Everything about a Shopify variant that a MetaKocka product name can be built
 * from (CLAUDE.md §8.9, `domain/products/template`).
 *
 * Separate from `listVariants` in inventory.ts on purpose: the stock path wants
 * the smallest possible query on every sync, and this one is only read when the
 * merchant syncs product names.
 *
 * GraphQL Admin API only (§2.1.5), paginated, never a query in a loop (§2.5).
 *
 * Metafields and the variant count are optional because they are not free. A
 * name pattern referencing no metafield should not pay to read every metafield
 * in the catalogue, and the variant count only feeds a lint rule that runs on
 * the settings screen over a handful of products. The sync job asks for them
 * only when a pattern actually uses one.
 */
const METAFIELD_PAGE = 50;

/**
 * The settings preview and the sync job read through one query with the
 * expensive parts switched off by default, so the two cannot drift in what a
 * name is built from.
 */
function variantDetailsQuery(withMetafields: boolean): string {
  const metafields = withMetafields
    ? `metafields(first: ${METAFIELD_PAGE}) { nodes { namespace key value } }`
    : "";
  const variantsCount = withMetafields ? "variantsCount { count }" : "";

  return `#graphql
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
          ${metafields}
          product {
            id
            title
            vendor
            productType
            handle
            ${variantsCount}
            ${metafields}
          }
        }
      }
    }
  `;
}

const metafieldsSchema = z.object({
  nodes: z.array(
    z.object({
      namespace: z.string(),
      key: z.string(),
      value: z.string().nullable(),
    }),
  ),
});

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
          metafields: metafieldsSchema.optional(),
          product: z
            .object({
              id: z.string(),
              title: z.string(),
              vendor: z.string().nullable(),
              productType: z.string().nullable(),
              handle: z.string().nullable(),
              variantsCount: z
                .object({ count: z.number() })
                .nullable()
                .optional(),
              metafields: metafieldsSchema.optional(),
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

/**
 * One flat `namespace.key` map, which is the shape a name pattern reads.
 *
 * The product's metafields go in first and the variant's over the top: where
 * both define the same key, the variant is the more specific answer, and it is
 * what a merchant naming a variant means.
 */
function metafieldMap(
  product: z.infer<typeof metafieldsSchema> | undefined,
  variant: z.infer<typeof metafieldsSchema> | undefined,
): Record<string, string> | undefined {
  if (!product && !variant) return undefined;

  const map: Record<string, string> = {};
  for (const source of [product, variant]) {
    for (const node of source?.nodes ?? []) {
      if (node.value === null) continue;
      map[`${node.namespace}.${node.key}`] = node.value;
    }
  }
  return map;
}

export interface VariantDetailOptions {
  /** Page size. The settings screen asks for a handful, the job for the lot. */
  first?: number;
  /** Stop after this many pages. One page is enough to preview a pattern. */
  maxPages?: number;
  /**
   * Read metafields and the product's variant count as well. Off by default:
   * both cost query points on every page, and most shops name products from
   * fields that are already free.
   */
  metafields?: boolean;
}

/**
 * A smaller page when metafields are on. The Admin API prices a query by what
 * one node costs times the page size, and the node selection roughly doubles.
 */
const PAGE_WITH_METAFIELDS = 100;
const PAGE_PLAIN = 250;

export async function listVariantDetails(
  admin: AdminApiContext,
  options: VariantDetailOptions = {},
): Promise<VariantDetail[]> {
  const withMetafields = options.metafields ?? false;
  const first =
    options.first ?? (withMetafields ? PAGE_WITH_METAFIELDS : PAGE_PLAIN);
  const maxPages = options.maxPages ?? 200;
  const query = variantDetailsQuery(withMetafields);
  const variants: VariantDetail[] = [];
  let cursor: string | null = null;

  // Bounded so a runaway cursor cannot spin forever.
  for (let page = 0; page < maxPages; page += 1) {
    const response = await admin.graphql(query, {
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
      const metafields = metafieldMap(
        node.product?.metafields,
        node.metafields,
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
        ...(metafields ? { metafields } : {}),
        ...(node.product?.id ? { productId: node.product.id } : {}),
        ...(node.product?.variantsCount
          ? { variantCount: node.product.variantsCount.count }
          : {}),
      });
    }

    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
  }

  return variants;
}

/**
 * The metafields this shop defines, so the picker can offer them by name.
 *
 * Definitions, not values: which metafields exist is the shop's business and is
 * never hardcoded (`domain/products/template/fields.ts`). A shop with none gets
 * an empty list and no Metafields group in the picker.
 */
const METAFIELD_DEFINITIONS_QUERY = `#graphql
  query OrchestratorMetafieldDefinitions($first: Int!) {
    productDefs: metafieldDefinitions(first: $first, ownerType: PRODUCT) {
      nodes { namespace key name }
    }
    variantDefs: metafieldDefinitions(first: $first, ownerType: PRODUCTVARIANT) {
      nodes { namespace key name }
    }
  }
`;

const definitionNodes = z.object({
  nodes: z.array(
    z.object({ namespace: z.string(), key: z.string(), name: z.string() }),
  ),
});

const definitionsSchema = z.object({
  data: z.object({
    productDefs: definitionNodes,
    variantDefs: definitionNodes,
  }),
});

const DEFINITION_PAGE = 250;

export async function listMetafieldDefinitions(
  admin: AdminApiContext,
): Promise<MetafieldDefinition[]> {
  const response = await admin.graphql(METAFIELD_DEFINITIONS_QUERY, {
    variables: { first: DEFINITION_PAGE },
  });
  const { data } = definitionsSchema.parse(await response.json());

  return [
    ...data.productDefs.nodes.map((node) => ({
      ...node,
      ownerType: "PRODUCT",
    })),
    ...data.variantDefs.nodes.map((node) => ({
      ...node,
      ownerType: "PRODUCTVARIANT",
    })),
  ];
}

/**
 * How many variants the shop has, so the settings screen can say what fraction
 * of the catalogue its preview covers.
 *
 * `precision` matters. The count stops at 10,000 by default and then reports
 * itself as an estimate rather than an exact figure, so a large catalogue must
 * be described as "more than" rather than given a number that is not one. The
 * limit is left at the default: an unbounded count on a large shop is a slow
 * query on a page load (CLAUDE.md 2.5), and "more than 10,000" answers the
 * question the merchant is actually asking.
 */
const VARIANT_COUNT_QUERY = `#graphql
  query OrchestratorVariantCount {
    productVariantsCount { count precision }
  }
`;

const variantCountSchema = z.object({
  data: z.object({
    productVariantsCount: z
      .object({ count: z.number(), precision: z.string() })
      .nullable(),
  }),
});

export interface VariantCount {
  count: number;
  /** False when the count stopped at its limit, so `count` is a floor. */
  exact: boolean;
}

export async function countVariants(
  admin: AdminApiContext,
): Promise<VariantCount | null> {
  const response = await admin.graphql(VARIANT_COUNT_QUERY);
  const { data } = variantCountSchema.parse(await response.json());
  if (!data.productVariantsCount) return null;

  return {
    count: data.productVariantsCount.count,
    exact: data.productVariantsCount.precision === "EXACT",
  };
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
