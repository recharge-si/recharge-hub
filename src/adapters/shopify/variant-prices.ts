import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import { toMinorUnits } from "~/adapters/metakocka/values";
import { getLogger } from "~/adapters/observability/logger.server";
import type { PricePair } from "~/domain/sales/types";

/**
 * Reading and writing variant prices (docs/sale-campaigns.md § Shopify API
 * operations).
 *
 * The one place this app writes a price. Every write is preceded by a live
 * read of the same variants, so a retry sees what the previous attempt did;
 * that is done by the caller (the run handler), which is why the two are
 * separate functions rather than a read-then-write.
 *
 * Prices cross this boundary as Shopify's decimal strings and are integer
 * minor units on our side (docs/BUILD_SPEC.md §15).
 */

/** Minor units back to the decimal string Shopify takes: 175920 → "1759.20". */
export function fromMinorUnits(minor: number, decimals = 2): string {
  const sign = minor < 0 ? "-" : "";
  const magnitude = Math.abs(minor);
  const whole = Math.floor(magnitude / 10 ** decimals);
  const fraction = String(magnitude % 10 ** decimals).padStart(decimals, "0");
  return `${sign}${whole}.${fraction}`;
}

const VARIANTS_BY_ID_QUERY = `#graphql
  query OrchestratorVariantPrices($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        sku
        title
        price
        compareAtPrice
        product { id title }
      }
    }
  }
`;

const variantsByIdSchema = z.object({
  data: z.object({
    nodes: z.array(
      z
        .object({
          id: z.string(),
          sku: z.string().nullable(),
          title: z.string().nullable(),
          price: z.string(),
          compareAtPrice: z.string().nullable(),
          product: z.object({ id: z.string(), title: z.string() }).nullable(),
        })
        .nullable(),
    ),
  }),
});

export interface LiveVariant extends PricePair {
  variantId: string;
  productId: string;
  sku: string | null;
  variantTitle: string | null;
  productTitle: string | null;
}

/** `nodes(ids:)` takes up to 250 ids. */
const READ_CHUNK = 250;

/**
 * What Shopify holds right now for these variants. A variant Shopify no
 * longer has is simply absent from the map: the caller decides what that
 * means (a deleted product cannot be restored and is released).
 */
export async function readVariantPrices(
  admin: AdminApiContext,
  variantIds: readonly string[],
): Promise<Map<string, LiveVariant>> {
  const live = new Map<string, LiveVariant>();

  for (let start = 0; start < variantIds.length; start += READ_CHUNK) {
    const ids = variantIds.slice(start, start + READ_CHUNK);
    const response = await admin.graphql(VARIANTS_BY_ID_QUERY, {
      variables: { ids },
      tries: 3,
    });
    const parsed = variantsByIdSchema.parse(await response.json());

    for (const node of parsed.data.nodes) {
      if (!node || !node.product) continue;
      live.set(node.id, {
        variantId: node.id,
        productId: node.product.id,
        sku: node.sku?.trim() || null,
        variantTitle: node.title,
        productTitle: node.product.title,
        priceMinor: toMinorUnits(node.price),
        compareAtMinor:
          node.compareAtPrice === null
            ? null
            : toMinorUnits(node.compareAtPrice),
      });
    }
  }

  return live;
}

const BULK_UPDATE_MUTATION = `#graphql
  mutation OrchestratorWriteVariantPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price compareAtPrice }
      userErrors { field message code }
    }
  }
`;

const bulkUpdateSchema = z.object({
  data: z
    .object({
      productVariantsBulkUpdate: z
        .object({
          productVariants: z
            .array(
              z.object({
                id: z.string(),
                price: z.string(),
                compareAtPrice: z.string().nullable(),
              }),
            )
            .nullable(),
          userErrors: z.array(
            z.object({
              field: z.array(z.string()).nullable().optional(),
              message: z.string(),
              code: z.string().nullable().optional(),
            }),
          ),
        })
        .nullable(),
    })
    .nullable(),
  errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
});

export interface PriceWrite extends PricePair {
  variantId: string;
}

export interface PriceWriteResult {
  /** What Shopify reports holding after the write, per variant written. */
  written: Map<string, PricePair>;
  /** Shopify's own objections, verbatim. Empty when the write went through. */
  userErrors: string[];
}

/** `productVariantsBulkUpdate` takes up to 250 variants of one product. */
const WRITE_CHUNK = 250;

export class VariantPriceWriteError extends Error {
  constructor(
    public readonly productId: string,
    public readonly messages: string[],
  ) {
    super(`Shopify rejected the price write: ${messages.join("; ")}`);
    this.name = "VariantPriceWriteError";
  }
}

/**
 * Writes `price` and `compareAtPrice` for variants of one product.
 *
 * One product per call because that is the mutation's shape; the caller
 * groups its batch by product. A user error is thrown as
 * `VariantPriceWriteError` so the run can record it per row rather than
 * fail the job: "compare at price must be greater than price" on one
 * variant must not stop the other four thousand.
 */
export async function writeVariantPrices(
  admin: AdminApiContext,
  productId: string,
  writes: readonly PriceWrite[],
): Promise<PriceWriteResult> {
  const written = new Map<string, PricePair>();
  const userErrors: string[] = [];

  for (let start = 0; start < writes.length; start += WRITE_CHUNK) {
    const chunk = writes.slice(start, start + WRITE_CHUNK);
    const response = await admin.graphql(BULK_UPDATE_MUTATION, {
      variables: {
        productId,
        variants: chunk.map((write) => ({
          id: write.variantId,
          price: fromMinorUnits(write.priceMinor),
          compareAtPrice:
            write.compareAtMinor === null
              ? null
              : fromMinorUnits(write.compareAtMinor),
        })),
      },
      tries: 3,
    });
    const parsed = bulkUpdateSchema.parse(await response.json());

    if (parsed.errors && parsed.errors.length > 0) {
      const messages = parsed.errors.map((error) => error.message);
      getLogger().error({ productId, messages }, "Price write failed");
      throw new VariantPriceWriteError(productId, messages);
    }

    const payload = parsed.data?.productVariantsBulkUpdate;
    for (const error of payload?.userErrors ?? []) {
      userErrors.push(error.message);
    }
    for (const variant of payload?.productVariants ?? []) {
      written.set(variant.id, {
        priceMinor: toMinorUnits(variant.price),
        compareAtMinor:
          variant.compareAtPrice === null
            ? null
            : toMinorUnits(variant.compareAtPrice),
      });
    }
  }

  return { written, userErrors };
}
