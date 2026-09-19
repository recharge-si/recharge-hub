import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import { toMinorUnits } from "~/adapters/metakocka/values";
import type { MetafieldMap } from "~/domain/sales/types";

/**
 * The catalogue snapshot read (docs/sale-campaigns.md § Data model).
 *
 * A Shopify bulk operation rather than pages of `products`: a product with
 * its variants, collections and metafields costs hundreds of query points,
 * and a ten-thousand-product catalogue read that way is hours of rate-limited
 * requests. The bulk operation runs on Shopify's side, and its JSONL result
 * is downloaded once and parsed here.
 *
 * Bulk-query limits, which the query below stays inside: five connections in
 * total, nested at most two deep, every connection on a `Node`.
 */

export const CATALOGUE_BULK_QUERY = `
  {
    products {
      edges {
        node {
          id
          title
          handle
          vendor
          productType
          status
          tags
          updatedAt
          category { id name }
          featuredMedia { preview { image { url(transform: { maxWidth: 80, maxHeight: 80 }) } } }
          collections {
            edges { node { id } }
          }
          metafields {
            edges { node { id namespace key type value } }
          }
          variants {
            edges {
              node {
                id
                sku
                barcode
                title
                price
                compareAtPrice
                metafields {
                  edges { node { id namespace key type value } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const RUN_MUTATION = `#graphql
  mutation OrchestratorStartCatalogueRead($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

const runSchema = z.object({
  data: z.object({
    bulkOperationRunQuery: z
      .object({
        bulkOperation: z
          .object({ id: z.string(), status: z.string() })
          .nullable(),
        userErrors: z.array(
          z.object({
            field: z.array(z.string()).nullable().optional(),
            message: z.string(),
          }),
        ),
      })
      .nullable(),
  }),
});

export type StartResult =
  | { kind: "started"; id: string }
  | { kind: "already_running" }
  | { kind: "rejected"; messages: string[] };

/**
 * Starts the read. Shopify allows one bulk query per app per shop at a time
 * and says so with a user error, which is reported as its own case so the
 * job can wait for the running one rather than fail.
 */
export async function startCatalogueRead(
  admin: AdminApiContext,
): Promise<StartResult> {
  const response = await admin.graphql(RUN_MUTATION, {
    variables: { query: CATALOGUE_BULK_QUERY },
    tries: 3,
  });
  const parsed = runSchema.parse(await response.json());
  const payload = parsed.data.bulkOperationRunQuery;

  const errors = payload?.userErrors ?? [];
  if (errors.some((error) => /already in progress/i.test(error.message))) {
    return { kind: "already_running" };
  }
  if (errors.length > 0 || !payload?.bulkOperation) {
    return { kind: "rejected", messages: errors.map((error) => error.message) };
  }
  return { kind: "started", id: payload.bulkOperation.id };
}

const STATUS_QUERY = `#graphql
  query OrchestratorCatalogueReadStatus($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id
        status
        errorCode
        objectCount
        url
        partialDataUrl
      }
    }
  }
`;

const RECENT_QUERY = `#graphql
  query OrchestratorRecentBulkOperations {
    bulkOperations(first: 5, query: "operation_type:query", sortKey: CREATED_AT, reverse: true) {
      nodes { id status errorCode objectCount url partialDataUrl }
    }
  }
`;

const operationSchema = z.object({
  id: z.string(),
  status: z.string(),
  errorCode: z.string().nullable(),
  objectCount: z.union([z.string(), z.number()]).nullable(),
  url: z.string().nullable(),
  partialDataUrl: z.string().nullable(),
});

const statusSchema = z.object({
  data: z.object({ node: operationSchema.nullable() }),
});

const recentSchema = z.object({
  data: z.object({
    bulkOperations: z.object({ nodes: z.array(operationSchema) }),
  }),
});

const IN_FLIGHT = new Set(["CREATED", "RUNNING", "CANCELING"]);

export interface BulkOperationState {
  id: string;
  /** CREATED, RUNNING, COMPLETED, CANCELING, CANCELED, FAILED, EXPIRED. */
  status: string;
  errorCode: string | null;
  objectCount: number;
  url: string | null;
}

function shape(op: z.infer<typeof operationSchema>): BulkOperationState {
  return {
    id: op.id,
    status: op.status,
    errorCode: op.errorCode,
    objectCount: Number(op.objectCount ?? 0),
    url: op.url,
  };
}

export async function readBulkOperation(
  admin: AdminApiContext,
  id: string,
): Promise<BulkOperationState | null> {
  const response = await admin.graphql(STATUS_QUERY, {
    variables: { id },
    tries: 3,
  });
  const parsed = statusSchema.parse(await response.json());
  return parsed.data.node ? shape(parsed.data.node) : null;
}

/**
 * The app's bulk query in flight on this shop, whoever started it, so a job
 * that was told "already in progress" can wait for that one instead of
 * failing.
 */
export async function readRunningBulkOperation(
  admin: AdminApiContext,
): Promise<BulkOperationState | null> {
  const response = await admin.graphql(RECENT_QUERY, { tries: 3 });
  const parsed = recentSchema.parse(await response.json());
  const running = parsed.data.bulkOperations.nodes.find((op) =>
    IN_FLIGHT.has(op.status),
  );
  return running ? shape(running) : null;
}

/** Downloads the JSONL result. The URL is pre-signed and short-lived. */
export async function downloadBulkResult(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Could not download the catalogue read: HTTP ${response.status}`,
    );
  }
  return response.text();
}

/* -------------------------------------------------------------------------- */
/* JSONL                                                                      */
/* -------------------------------------------------------------------------- */

const lineSchema = z
  .object({
    id: z.string(),
    __parentId: z.string().optional(),
  })
  .passthrough();

const productLineSchema = z.object({
  id: z.string(),
  title: z.string(),
  handle: z.string().nullable().optional(),
  vendor: z.string().nullable().optional(),
  productType: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  updatedAt: z.string().nullable().optional(),
  category: z
    .object({ id: z.string(), name: z.string() })
    .nullable()
    .optional(),
  featuredMedia: z
    .object({
      preview: z
        .object({ image: z.object({ url: z.string() }).nullable() })
        .nullable(),
    })
    .nullable()
    .optional(),
});

const variantLineSchema = z.object({
  id: z.string(),
  __parentId: z.string(),
  sku: z.string().nullable().optional(),
  barcode: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  price: z.string(),
  compareAtPrice: z.string().nullable().optional(),
});

const metafieldLineSchema = z.object({
  id: z.string(),
  __parentId: z.string(),
  namespace: z.string(),
  key: z.string(),
  type: z.string(),
  value: z.string().nullable(),
});

const collectionLineSchema = z.object({
  id: z.string(),
  __parentId: z.string(),
});

export interface CatalogueVariantRecord {
  variantId: string;
  productId: string;
  sku: string | null;
  barcode: string | null;
  title: string | null;
  priceMinor: number;
  compareAtMinor: number | null;
  metafields: MetafieldMap;
}

export interface CatalogueProductRecord {
  productId: string;
  title: string;
  handle: string | null;
  vendor: string | null;
  productType: string | null;
  status: string | null;
  tags: string[];
  collectionIds: string[];
  categoryId: string | null;
  categoryName: string | null;
  imageUrl: string | null;
  shopifyUpdatedAt: string | null;
  metafields: MetafieldMap;
  variants: CatalogueVariantRecord[];
}

const PRODUCT = "gid://shopify/Product/";
const VARIANT = "gid://shopify/ProductVariant/";
const METAFIELD = "gid://shopify/Metafield/";
const COLLECTION = "gid://shopify/Collection/";

/**
 * The JSONL, one product tree per root line.
 *
 * Each nested node is its own line with `__parentId`; which connection it
 * came from is told by the id's type — a metafield under a variant has the
 * variant as its parent, under a product the product. Lines that parse as
 * nothing this query asked for are skipped, and a line that is malformed is
 * a parse error rather than a silently shorter catalogue.
 */
export function parseCatalogueJsonl(text: string): CatalogueProductRecord[] {
  const products = new Map<string, CatalogueProductRecord>();
  const variants = new Map<string, CatalogueVariantRecord>();

  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const line = lineSchema.parse(JSON.parse(trimmed));

    if (line.id.startsWith(PRODUCT)) {
      const product = productLineSchema.parse(line);
      products.set(product.id, {
        productId: product.id,
        title: product.title,
        handle: product.handle ?? null,
        vendor: product.vendor ?? null,
        productType: product.productType ?? null,
        status: product.status ?? null,
        tags: product.tags ?? [],
        collectionIds: [],
        categoryId: product.category?.id ?? null,
        categoryName: product.category?.name ?? null,
        imageUrl: product.featuredMedia?.preview?.image?.url ?? null,
        shopifyUpdatedAt: product.updatedAt ?? null,
        metafields: {},
        variants: [],
      });
      continue;
    }

    if (line.id.startsWith(VARIANT)) {
      const variant = variantLineSchema.parse(line);
      const record: CatalogueVariantRecord = {
        variantId: variant.id,
        productId: variant.__parentId,
        sku: variant.sku?.trim() || null,
        barcode: variant.barcode?.trim() || null,
        title: variant.title ?? null,
        priceMinor: toMinorUnits(variant.price),
        compareAtMinor:
          variant.compareAtPrice === null ||
          variant.compareAtPrice === undefined
            ? null
            : toMinorUnits(variant.compareAtPrice),
        metafields: {},
      };
      variants.set(variant.id, record);
      products.get(variant.__parentId)?.variants.push(record);
      continue;
    }

    if (line.id.startsWith(METAFIELD)) {
      const metafield = metafieldLineSchema.parse(line);
      if (metafield.value === null) continue;
      const entry = { type: metafield.type, value: metafield.value };
      const name = `${metafield.namespace}.${metafield.key}`;
      const owner = metafield.__parentId.startsWith(VARIANT)
        ? variants.get(metafield.__parentId)
        : products.get(metafield.__parentId);
      if (owner) owner.metafields[name] = entry;
      continue;
    }

    if (line.id.startsWith(COLLECTION)) {
      const collection = collectionLineSchema.parse(line);
      products.get(collection.__parentId)?.collectionIds.push(collection.id);
      continue;
    }
  }

  return [...products.values()];
}

/* -------------------------------------------------------------------------- */
/* Shop context                                                               */
/* -------------------------------------------------------------------------- */

const SHOP_CONTEXT_QUERY = `#graphql
  query OrchestratorShopContext {
    shop { ianaTimezone currencyCode }
  }
`;

const shopContextSchema = z.object({
  data: z.object({
    shop: z.object({ ianaTimezone: z.string(), currencyCode: z.string() }),
  }),
});

export interface ShopContext {
  ianaTimezone: string;
  currencyCode: string;
}

/** The shop's timezone and currency, for showing schedules and naming amounts. */
export async function readShopContext(
  admin: AdminApiContext,
): Promise<ShopContext> {
  const response = await admin.graphql(SHOP_CONTEXT_QUERY, { tries: 3 });
  const parsed = shopContextSchema.parse(await response.json());
  return parsed.data.shop;
}
