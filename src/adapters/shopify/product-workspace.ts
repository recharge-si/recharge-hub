import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import { toMinorUnits } from "~/adapters/metakocka/values";
import { fromMinorUnits } from "~/adapters/shopify/variant-prices";
import type {
  ProductChange,
  ProductStatus,
  VariantChange,
} from "~/domain/products/workspace";
import type { MetafieldMap } from "~/domain/sales/types";

/**
 * One product, read and edited from the product workspace
 * (docs/architecture.md § Product workspace).
 *
 * The workspace edits what a merchant would otherwise open Shopify's product
 * editor for, so it reads the product live rather than from the catalogue
 * snapshot: a description, SEO and media are not in the snapshot, and an
 * editor that starts from a copy saves over whatever changed since. The read
 * is sized to stay far inside the single-query cost limit — the product with
 * up to 100 variants and no inventory — and stock is a second read by variant
 * id, in pieces small enough for their levels (`readVariantInventory`).
 *
 * Writes are the merchant's own, one save at a time, and every one names
 * exactly the fields that changed: `productUpdate` for the product,
 * `tagsAdd` / `tagsRemove` for tags (never a whole list, which would drop
 * the export portal's review tags), and `productVariantsBulkUpdate` for
 * variants. The caller decides what may be written; this file only carries
 * it (a campaign's hold on a price is checked before a write gets here).
 */

const errorsSchema = z
  .array(z.object({ message: z.string() }).passthrough())
  .optional();

const userErrorsSchema = z.array(
  z.object({
    field: z.array(z.string()).nullable().optional(),
    message: z.string(),
  }),
);

/** How many variants the workspace reads. Past this the page says so. */
export const VARIANT_LIMIT = 100;
/** How many images the media section shows. */
export const MEDIA_LIMIT = 50;

const PRODUCT_QUERY = `#graphql
  query OrchestratorProductWorkspace($id: ID!) {
    product(id: $id) {
      id
      legacyResourceId
      title
      handle
      descriptionHtml
      vendor
      productType
      status
      tags
      updatedAt
      onlineStoreUrl
      onlineStorePreviewUrl
      hasOnlyDefaultVariant
      seo { title description }
      category { id name fullName }
      collections(first: 25) { nodes { id title } }
      featuredMedia { id }
      media(first: 50) {
        nodes {
          id
          alt
          mediaContentType
          preview { image { url(transform: { maxWidth: 400, maxHeight: 400 }) width height } }
        }
      }
      mediaCount { count }
      metafields(first: 100) { nodes { namespace key type value } }
      options { name }
      variantsCount { count }
      variants(first: 100) {
        nodes {
          id
          title
          sku
          barcode
          price
          compareAtPrice
          inventoryQuantity
          selectedOptions { name value }
        }
      }
    }
  }
`;

const metafieldNodes = z.object({
  nodes: z.array(
    z.object({
      namespace: z.string(),
      key: z.string(),
      type: z.string(),
      value: z.string(),
    }),
  ),
});

const productSchema = z.object({
  data: z
    .object({
      product: z
        .object({
          id: z.string(),
          legacyResourceId: z.string(),
          title: z.string(),
          handle: z.string(),
          descriptionHtml: z.string(),
          vendor: z.string(),
          productType: z.string(),
          status: z.string(),
          tags: z.array(z.string()),
          updatedAt: z.string(),
          onlineStoreUrl: z.string().nullable(),
          onlineStorePreviewUrl: z.string().nullable(),
          hasOnlyDefaultVariant: z.boolean(),
          seo: z.object({
            title: z.string().nullable(),
            description: z.string().nullable(),
          }),
          category: z
            .object({ id: z.string(), name: z.string(), fullName: z.string() })
            .nullable(),
          collections: z.object({
            nodes: z.array(z.object({ id: z.string(), title: z.string() })),
          }),
          featuredMedia: z.object({ id: z.string() }).nullable(),
          media: z.object({
            nodes: z.array(
              z.object({
                id: z.string(),
                alt: z.string().nullable(),
                mediaContentType: z.string(),
                preview: z
                  .object({
                    image: z
                      .object({
                        url: z.string(),
                        width: z.number().nullable(),
                        height: z.number().nullable(),
                      })
                      .nullable(),
                  })
                  .nullable(),
              }),
            ),
          }),
          mediaCount: z.object({ count: z.number() }).nullable(),
          metafields: metafieldNodes,
          options: z.array(z.object({ name: z.string() })),
          variantsCount: z.object({ count: z.number() }).nullable(),
          variants: z.object({
            nodes: z.array(
              z.object({
                id: z.string(),
                title: z.string(),
                sku: z.string().nullable(),
                barcode: z.string().nullable(),
                price: z.string(),
                compareAtPrice: z.string().nullable(),
                inventoryQuantity: z.number().nullable(),
                selectedOptions: z.array(
                  z.object({ name: z.string(), value: z.string() }),
                ),
              }),
            ),
          }),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: errorsSchema,
});

export interface WorkspaceMedia {
  id: string;
  alt: string | null;
  kind: string;
  url: string | null;
  width: number | null;
  height: number | null;
  featured: boolean;
}

export interface WorkspaceVariant {
  variantId: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  priceMinor: number;
  compareAtMinor: number | null;
  /** Shopify's total available across locations; null when not tracked. */
  inventoryQuantity: number | null;
  options: Array<{ name: string; value: string }>;
}

export interface WorkspaceProduct {
  productId: string;
  legacyId: string;
  title: string;
  handle: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  status: ProductStatus;
  tags: string[];
  updatedAt: string;
  onlineStoreUrl: string | null;
  onlineStorePreviewUrl: string | null;
  hasOnlyDefaultVariant: boolean;
  seoTitle: string;
  seoDescription: string;
  category: { id: string; name: string; fullName: string } | null;
  collections: Array<{ id: string; title: string }>;
  media: WorkspaceMedia[];
  mediaCount: number;
  metafields: MetafieldMap;
  options: string[];
  variantsCount: number;
  variants: WorkspaceVariant[];
}

function metafieldMap(nodes: z.infer<typeof metafieldNodes>): MetafieldMap {
  const map: MetafieldMap = {};
  for (const node of nodes.nodes)
    map[`${node.namespace}.${node.key}`] = {
      type: node.type,
      value: node.value,
    };
  return map;
}

function statusOf(raw: string): ProductStatus {
  return raw === "ACTIVE" || raw === "DRAFT" || raw === "ARCHIVED"
    ? raw
    : "DRAFT";
}

function graphqlErrors(errors: z.infer<typeof errorsSchema>): void {
  if (errors && errors.length > 0)
    throw new Error(errors.map((error) => error.message).join("; "));
}

/** The product as the workspace shows it, or null when Shopify has no such product. */
export async function readWorkspaceProduct(
  admin: AdminApiContext,
  productId: string,
): Promise<WorkspaceProduct | null> {
  const response = await admin.graphql(PRODUCT_QUERY, {
    variables: { id: productId },
    tries: 2,
  });
  const parsed = productSchema.parse(await response.json());
  graphqlErrors(parsed.errors);
  const product = parsed.data?.product;
  if (!product) return null;

  return {
    productId: product.id,
    legacyId: product.legacyResourceId,
    title: product.title,
    handle: product.handle,
    descriptionHtml: product.descriptionHtml,
    vendor: product.vendor,
    productType: product.productType,
    status: statusOf(product.status),
    tags: product.tags,
    updatedAt: product.updatedAt,
    onlineStoreUrl: product.onlineStoreUrl,
    onlineStorePreviewUrl: product.onlineStorePreviewUrl,
    hasOnlyDefaultVariant: product.hasOnlyDefaultVariant,
    seoTitle: product.seo.title ?? "",
    seoDescription: product.seo.description ?? "",
    category: product.category,
    collections: product.collections.nodes,
    media: product.media.nodes.map((node) => ({
      id: node.id,
      alt: node.alt,
      kind: node.mediaContentType,
      url: node.preview?.image?.url ?? null,
      width: node.preview?.image?.width ?? null,
      height: node.preview?.image?.height ?? null,
      featured: node.id === product.featuredMedia?.id,
    })),
    mediaCount: product.mediaCount?.count ?? product.media.nodes.length,
    metafields: metafieldMap(product.metafields),
    options: product.options.map((option) => option.name),
    variantsCount:
      product.variantsCount?.count ?? product.variants.nodes.length,
    variants: product.variants.nodes.map((variant) => ({
      variantId: variant.id,
      title: variant.title,
      sku: variant.sku?.trim() || null,
      barcode: variant.barcode?.trim() || null,
      priceMinor: toMinorUnits(variant.price),
      compareAtMinor:
        variant.compareAtPrice === null
          ? null
          : toMinorUnits(variant.compareAtPrice),
      inventoryQuantity: variant.inventoryQuantity,
      options: variant.selectedOptions,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Inventory                                                                  */
/* -------------------------------------------------------------------------- */

const INVENTORY_QUERY = `#graphql
  query OrchestratorVariantInventory($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        inventoryItem {
          tracked
          inventoryLevels(first: 20) {
            nodes {
              location { id name }
              quantities(names: ["available", "on_hand"]) { name quantity }
            }
          }
        }
      }
    }
  }
`;

const inventorySchema = z.object({
  data: z
    .object({
      nodes: z.array(
        z
          .object({
            id: z.string().optional(),
            inventoryItem: z
              .object({
                tracked: z.boolean(),
                inventoryLevels: z.object({
                  nodes: z.array(
                    z.object({
                      location: z.object({ id: z.string(), name: z.string() }),
                      quantities: z.array(
                        z.object({ name: z.string(), quantity: z.number() }),
                      ),
                    }),
                  ),
                }),
              })
              .nullable()
              .optional(),
          })
          .nullable(),
      ),
    })
    .nullable()
    .optional(),
  errors: errorsSchema,
});

export interface VariantInventory {
  variantId: string;
  tracked: boolean;
  levels: Array<{
    locationId: string;
    locationName: string;
    available: number;
    onHand: number;
  }>;
}

/**
 * Twenty variants a request: twenty levels each keeps one request inside
 * the query cost limit, and the pieces are read side by side.
 */
const INVENTORY_CHUNK = 20;

/** Stock per location for these variants, read live. */
export async function readVariantInventory(
  admin: AdminApiContext,
  variantIds: readonly string[],
): Promise<Map<string, VariantInventory>> {
  const chunks: string[][] = [];
  for (let start = 0; start < variantIds.length; start += INVENTORY_CHUNK)
    chunks.push(variantIds.slice(start, start + INVENTORY_CHUNK));

  const pages = await Promise.all(
    chunks.map(async (ids) => {
      const response = await admin.graphql(INVENTORY_QUERY, {
        variables: { ids },
        tries: 2,
      });
      const parsed = inventorySchema.parse(await response.json());
      graphqlErrors(parsed.errors);
      return parsed.data?.nodes ?? [];
    }),
  );

  const result = new Map<string, VariantInventory>();
  for (const node of pages.flat()) {
    if (!node?.id || !node.inventoryItem) continue;
    result.set(node.id, {
      variantId: node.id,
      tracked: node.inventoryItem.tracked,
      levels: node.inventoryItem.inventoryLevels.nodes.map((level) => {
        const quantity = (name: string) =>
          level.quantities.find((q) => q.name === name)?.quantity ?? 0;
        return {
          locationId: level.location.id,
          locationName: level.location.name,
          available: quantity("available"),
          onHand: quantity("on_hand"),
        };
      }),
    });
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Variant metafields                                                         */
/* -------------------------------------------------------------------------- */

const VARIANT_METAFIELDS_QUERY = `#graphql
  query OrchestratorVariantMetafields($ids: [ID!]!, $keys: [String!]!, $first: Int!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        metafields(first: $first, keys: $keys) { nodes { namespace key type value } }
      }
    }
  }
`;

const variantMetafieldsSchema = z.object({
  data: z
    .object({
      nodes: z.array(
        z
          .object({
            id: z.string().optional(),
            metafields: metafieldNodes.optional(),
          })
          .nullable(),
      ),
    })
    .nullable()
    .optional(),
  errors: errorsSchema,
});

/**
 * The named metafields of these variants, read only when the product's
 * type has variant-level attributes. Separate from the product read because
 * a metafield connection under every variant is what would take that read
 * past the cost limit; asked for by key it is a few points a variant.
 */
export async function readVariantMetafields(
  admin: AdminApiContext,
  variantIds: readonly string[],
  keys: readonly string[],
): Promise<Map<string, MetafieldMap>> {
  const result = new Map<string, MetafieldMap>();
  if (variantIds.length === 0 || keys.length === 0) return result;
  const wanted = keys.slice(0, 25);
  const chunks: string[][] = [];
  for (let start = 0; start < variantIds.length; start += 50)
    chunks.push(variantIds.slice(start, start + 50));
  const pages = await Promise.all(
    chunks.map(async (ids) => {
      const response = await admin.graphql(VARIANT_METAFIELDS_QUERY, {
        variables: { ids, keys: wanted, first: wanted.length },
        tries: 2,
      });
      const parsed = variantMetafieldsSchema.parse(await response.json());
      graphqlErrors(parsed.errors);
      return parsed.data?.nodes ?? [];
    }),
  );
  for (const node of pages.flat())
    if (node?.id && node.metafields)
      result.set(node.id, metafieldMap(node.metafields));
  return result;
}

/* -------------------------------------------------------------------------- */
/* Writing the product                                                        */
/* -------------------------------------------------------------------------- */

const UPDATE_MUTATION = `#graphql
  mutation OrchestratorWorkspaceProductUpdate(
    $product: ProductUpdateInput!
    $id: ID!
    $add: [String!]!
    $remove: [String!]!
    $withProduct: Boolean!
    $withAdd: Boolean!
    $withRemove: Boolean!
  ) {
    productUpdate(product: $product) @include(if: $withProduct) {
      product { id updatedAt }
      userErrors { field message }
    }
    tagsAdd(id: $id, tags: $add) @include(if: $withAdd) {
      userErrors { field message }
    }
    tagsRemove(id: $id, tags: $remove) @include(if: $withRemove) {
      userErrors { field message }
    }
  }
`;

const updateSchema = z.object({
  data: z
    .object({
      productUpdate: z
        .object({
          product: z.object({ id: z.string() }).nullable(),
          userErrors: userErrorsSchema,
        })
        .nullable()
        .optional(),
      tagsAdd: z.object({ userErrors: userErrorsSchema }).nullable().optional(),
      tagsRemove: z
        .object({ userErrors: userErrorsSchema })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  errors: errorsSchema,
});

export interface WriteOutcome {
  ok: boolean;
  /** Shopify's own objections, verbatim, each with the field it named. */
  errors: Array<{
    field: string | null;
    message: string;
    /** For a metafield write: the position of the write the error names, if it said. */
    index?: number | null;
  }>;
}

/** The `ProductUpdateInput` for exactly the fields that changed. */
export function productUpdateInput(
  productId: string,
  change: ProductChange,
): Record<string, unknown> {
  const input: Record<string, unknown> = { id: productId };
  if (change.title !== undefined) input.title = change.title;
  if (change.descriptionHtml !== undefined)
    input.descriptionHtml = change.descriptionHtml;
  if (change.vendor !== undefined) input.vendor = change.vendor;
  if (change.productType !== undefined) input.productType = change.productType;
  if (change.status !== undefined) input.status = change.status;
  if (change.seoTitle !== undefined || change.seoDescription !== undefined) {
    const seo: Record<string, string> = {};
    if (change.seoTitle !== undefined) seo.title = change.seoTitle;
    if (change.seoDescription !== undefined)
      seo.description = change.seoDescription;
    input.seo = seo;
  }
  return input;
}

/** `["metafields", "3", "value"]` → 3: which write of the call the error names. */
function indexOf(path: string[] | null | undefined): number | null {
  if (!path || path[0] !== "metafields") return null;
  const index = Number(path[1]);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/** The last element of a user error's field path: `["product", "title"]` → `title`. */
function fieldOf(path: string[] | null | undefined): string | null {
  return path && path.length > 0 ? (path[path.length - 1] ?? null) : null;
}

/**
 * Writes one save of the product: the changed fields in one `productUpdate`,
 * and tag additions and removals beside it, in one request.
 */
export async function writeProduct(
  admin: AdminApiContext,
  productId: string,
  change: ProductChange,
  tags: { add: readonly string[]; remove: readonly string[] },
): Promise<WriteOutcome> {
  const input = productUpdateInput(productId, change);
  const withProduct = Object.keys(input).length > 1;
  const response = await admin.graphql(UPDATE_MUTATION, {
    variables: {
      product: input,
      id: productId,
      add: [...tags.add],
      remove: [...tags.remove],
      withProduct,
      withAdd: tags.add.length > 0,
      withRemove: tags.remove.length > 0,
    },
  });
  const parsed = updateSchema.parse(await response.json());
  if (!parsed.data && parsed.errors && parsed.errors.length > 0)
    return {
      ok: false,
      errors: parsed.errors.map((error) => ({
        field: null,
        message: error.message,
      })),
    };

  const errors = [
    ...(parsed.data?.productUpdate?.userErrors ?? []),
    ...(parsed.data?.tagsAdd?.userErrors ?? []).map((e) => ({
      ...e,
      field: ["tags"],
    })),
    ...(parsed.data?.tagsRemove?.userErrors ?? []).map((e) => ({
      ...e,
      field: ["tags"],
    })),
  ].map((error) => ({ field: fieldOf(error.field), message: error.message }));
  return { ok: errors.length === 0, errors };
}

/* -------------------------------------------------------------------------- */
/* Writing variants                                                           */
/* -------------------------------------------------------------------------- */

const VARIANTS_MUTATION = `#graphql
  mutation OrchestratorWorkspaceVariantsUpdate(
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

const variantsSchema = z.object({
  data: z
    .object({
      productVariantsBulkUpdate: z
        .object({
          productVariants: z.array(z.object({ id: z.string() })).nullable(),
          userErrors: userErrorsSchema,
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: errorsSchema,
});

/** One `ProductVariantsBulkInput`, carrying only what changed on that variant. */
export function variantInput(change: VariantChange): Record<string, unknown> {
  const input: Record<string, unknown> = { id: change.variantId };
  if (change.priceMinor !== undefined)
    input.price = fromMinorUnits(change.priceMinor);
  if (change.compareAtMinor !== undefined)
    input.compareAtPrice =
      change.compareAtMinor === null
        ? null
        : fromMinorUnits(change.compareAtMinor);
  if (change.barcode !== undefined) input.barcode = change.barcode;
  if (change.sku !== undefined) input.inventoryItem = { sku: change.sku };
  return input;
}

/**
 * Writes variant edits of one product in one mutation. The workspace reads
 * at most `VARIANT_LIMIT` variants, well inside the mutation's 250.
 */
export async function writeVariants(
  admin: AdminApiContext,
  productId: string,
  changes: readonly VariantChange[],
): Promise<WriteOutcome> {
  if (changes.length === 0) return { ok: true, errors: [] };
  const response = await admin.graphql(VARIANTS_MUTATION, {
    variables: { productId, variants: changes.map(variantInput) },
  });
  const parsed = variantsSchema.parse(await response.json());
  if (parsed.errors && parsed.errors.length > 0)
    return {
      ok: false,
      errors: parsed.errors.map((error) => ({
        field: null,
        message: error.message,
      })),
    };
  const errors = (parsed.data?.productVariantsBulkUpdate?.userErrors ?? []).map(
    (error) => ({ field: fieldOf(error.field), message: error.message }),
  );
  return { ok: errors.length === 0, errors };
}

/* -------------------------------------------------------------------------- */
/* Writing attribute values                                                   */
/* -------------------------------------------------------------------------- */

/** One metafield a save writes, on the product or one of its variants. */
export interface MetafieldWrite {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}

/** One metafield a save clears. */
export interface MetafieldClear {
  ownerId: string;
  namespace: string;
  key: string;
}

const METAFIELDS_SET_MUTATION = `#graphql
  mutation OrchestratorWorkspaceMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

const METAFIELDS_DELETE_MUTATION = `#graphql
  mutation OrchestratorWorkspaceMetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { key }
      userErrors { field message }
    }
  }
`;

const metafieldsSetSchema = z.object({
  data: z
    .object({
      metafieldsSet: z.object({ userErrors: userErrorsSchema }).nullable(),
    })
    .nullable()
    .optional(),
  errors: errorsSchema,
});

const metafieldsDeleteSchema = z.object({
  data: z
    .object({
      metafieldsDelete: z.object({ userErrors: userErrorsSchema }).nullable(),
    })
    .nullable()
    .optional(),
  errors: errorsSchema,
});

/** `metafieldsSet` takes at most 25 metafields a call. */
const METAFIELDS_PER_CALL = 25;

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    chunks.push(items.slice(start, start + size));
  return chunks;
}

/**
 * Writes and clears attribute values. `metafieldsSet` is atomic per call,
 * so a save of more than 25 values can stop part way; the first refusal
 * stops the rest and is returned, and a reload shows what was written.
 */
export async function writeMetafields(
  admin: AdminApiContext,
  writes: readonly MetafieldWrite[],
  clears: readonly MetafieldClear[],
): Promise<WriteOutcome> {
  let offset = 0;
  for (const batch of chunked(writes, METAFIELDS_PER_CALL)) {
    const response = await admin.graphql(METAFIELDS_SET_MUTATION, {
      variables: { metafields: batch },
    });
    const parsed = metafieldsSetSchema.parse(await response.json());
    const errors = [
      ...(parsed.errors ?? []).map((error) => ({
        field: null,
        message: error.message,
      })),
      ...(parsed.data?.metafieldsSet?.userErrors ?? []).map((error) => {
        const at = indexOf(error.field);
        return {
          field: fieldOf(error.field),
          message: error.message,
          index: at === null ? null : offset + at,
        };
      }),
    ];
    offset += batch.length;
    if (errors.length > 0) return { ok: false, errors };
  }
  for (const batch of chunked(clears, METAFIELDS_PER_CALL)) {
    const response = await admin.graphql(METAFIELDS_DELETE_MUTATION, {
      variables: { metafields: batch },
    });
    const parsed = metafieldsDeleteSchema.parse(await response.json());
    const errors = [
      ...(parsed.errors ?? []).map((error) => ({
        field: null,
        message: error.message,
      })),
      ...(parsed.data?.metafieldsDelete?.userErrors ?? []).map((error) => ({
        field: fieldOf(error.field),
        message: error.message,
      })),
    ];
    if (errors.length > 0) return { ok: false, errors };
  }
  return { ok: true, errors: [] };
}
