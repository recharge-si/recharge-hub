import { createHash } from "node:crypto";

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import { toMinorUnits } from "~/adapters/metakocka/values";
import { getLogger } from "~/adapters/observability/logger.server";

/**
 * Reading Shopify variants and writing on-hand inventory.
 *
 * CLAUDE.md §7 is the whole design here: one writer per location, and this app
 * writes `on_hand` only for locations it owns. The ownership check is a throw,
 * not a convention.
 */

/*
 * Everything the registry keeps about a variant, in one pass.
 *
 * The image, price and vendor are not needed to match a SKU to a MetaKocka
 * product — they are needed so the product screen is a list of products rather
 * than a list of codes. They come from the walk that was happening anyway, so
 * the page never pays for them at load time (§2.5).
 *
 * `image` falls back to the product's featured image, which is what Shopify
 * shows for a variant that has none of its own.
 */
const VARIANTS_QUERY = `#graphql
  query OrchestratorVariants($cursor: String) {
    productVariants(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        sku
        title
        displayName
        price
        inventoryItem { id }
        image { url(transform: { maxWidth: 80, maxHeight: 80 }) }
        product {
          id
          title
          vendor
          productType
          featuredImage { url(transform: { maxWidth: 80, maxHeight: 80 }) }
        }
      }
    }
  }
`;

const variantsSchema = z.object({
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
          displayName: z.string().nullable(),
          price: z.string().nullable(),
          inventoryItem: z.object({ id: z.string() }).nullable(),
          image: z.object({ url: z.string() }).nullable(),
          product: z
            .object({
              id: z.string(),
              title: z.string().nullable(),
              vendor: z.string().nullable(),
              productType: z.string().nullable(),
              featuredImage: z.object({ url: z.string() }).nullable(),
            })
            .nullable(),
        }),
      ),
    }),
  }),
});

export interface ShopifyVariant {
  variantId: string;
  sku: string;
  inventoryItemId: string | null;
  /** The product's own title. */
  title: string | null;
  /** The variant's option values, as Shopify names them. */
  variantTitle: string | null;
  productId: string | null;
  imageUrl: string | null;
  /** Minor units (§15). Shopify sends a decimal string. */
  priceMinor: number | null;
  vendor: string | null;
  productType: string | null;
}

/**
 * Every variant that has a SKU. Paginated rather than looped per product
 * (§2.5: a query inside a loop is an automatic review comment).
 */
export async function listVariants(
  admin: AdminApiContext,
): Promise<ShopifyVariant[]> {
  const variants: ShopifyVariant[] = [];
  let cursor: string | null = null;

  // Bounded so a runaway cursor cannot spin forever.
  for (let page = 0; page < 200; page += 1) {
    const response = await admin.graphql(VARIANTS_QUERY, {
      variables: { cursor },
    });
    const parsed = variantsSchema.parse(await response.json());
    const { nodes, pageInfo } = parsed.data.productVariants;

    for (const node of nodes) {
      const sku = node.sku?.trim();
      // A variant with no SKU cannot be matched to a MetaKocka product.
      if (!sku) continue;

      variants.push({
        variantId: node.id,
        sku,
        inventoryItemId: node.inventoryItem?.id ?? null,
        /*
         * The product title, not `displayName`.
         *
         * `displayName` is "Product - Options" joined with a hyphen, which
         * cannot be taken apart again once a product title contains one. The
         * two fields are read separately and stay separate.
         */
        title: node.product?.title ?? node.displayName ?? null,
        // Shopify calls a variant with no options "Default Title", which is not
        // an option value and should not be shown as one.
        variantTitle:
          node.title && node.title !== "Default Title" ? node.title : null,
        productId: node.product?.id ?? null,
        // A variant with no image of its own shows the product's, which is what
        // the merchant sees in Shopify.
        imageUrl: node.image?.url ?? node.product?.featuredImage?.url ?? null,
        priceMinor: node.price === null ? null : toMinorUnits(node.price),
        vendor: node.product?.vendor ?? null,
        productType: node.product?.productType ?? null,
      });
    }

    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
  }

  return variants;
}

const ON_HAND_QUERY = `#graphql
  query OrchestratorOnHand($locationId: ID!, $cursor: String) {
    location(id: $locationId) {
      inventoryLevels(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          item { id }
          quantities(names: ["on_hand"]) { name quantity }
        }
      }
    }
  }
`;

const onHandSchema = z.object({
  data: z.object({
    location: z
      .object({
        inventoryLevels: z.object({
          pageInfo: z.object({
            hasNextPage: z.boolean(),
            endCursor: z.string().nullable(),
          }),
          nodes: z.array(
            z.object({
              item: z.object({ id: z.string() }),
              quantities: z.array(
                z.object({ name: z.string(), quantity: z.number() }),
              ),
            }),
          ),
        }),
      })
      .nullable(),
  }),
});

/**
 * Current on-hand at one location, keyed by inventory item id.
 *
 * Used to satisfy §7's "write only on change": a value that already matches is
 * not rewritten, which keeps our own `inventory_levels/update` webhooks rare.
 * An inventory item missing from this map is not stocked at the location at
 * all, and needs activating before any quantity can be set on it.
 */
export async function readOnHandAtLocation(
  admin: AdminApiContext,
  locationId: string,
): Promise<Map<string, number>> {
  const levels = new Map<string, number>();
  let cursor: string | null = null;

  for (let page = 0; page < 200; page += 1) {
    const response = await admin.graphql(ON_HAND_QUERY, {
      variables: { locationId, cursor },
    });
    const parsed = onHandSchema.parse(await response.json());
    const location = parsed.data.location;
    if (!location) break;

    for (const node of location.inventoryLevels.nodes) {
      const onHand = node.quantities.find((q) => q.name === "on_hand");
      if (onHand) levels.set(node.item.id, onHand.quantity);
    }

    const { hasNextPage, endCursor } = location.inventoryLevels.pageInfo;
    if (!hasNextPage || !endCursor) break;
    cursor = endCursor;
  }

  return levels;
}

const SET_QUANTITIES = `#graphql
  mutation OrchestratorSetOnHand($input: InventorySetQuantitiesInput!, $key: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $key) {
      userErrors { field message }
      inventoryAdjustmentGroup { createdAt reason }
    }
  }
`;

/**
 * The key `@idempotent` demands, which Shopify requires on this mutation.
 *
 * Derived from the run and from the batch's exact contents, so all three cases
 * come out right: a retry of the same job sending the same numbers is
 * recognised as the same write and not applied twice; a retry that re-read
 * different numbers gets a new key and is applied; and a later run that happens
 * to send an identical batch — stock going 10, 5, 10, 5 — is a different write
 * and is not swallowed by the cached result of the earlier one.
 */
function idempotencyKey(runId: string, batch: unknown): string {
  return createHash("sha256")
    .update(`${runId}:${JSON.stringify(batch)}`)
    .digest("hex");
}

const setQuantitiesSchema = z.object({
  data: z.object({
    inventorySetQuantities: z
      .object({
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

export class InventoryOwnershipError extends Error {
  constructor(locationId: string, writer: string) {
    super(
      `Refusing to write inventory for location ${locationId}: it is owned by "${writer}", not by this app. See CLAUDE.md section 7.`,
    );
    this.name = "InventoryOwnershipError";
  }
}

export interface OnHandActivation {
  inventoryItemId: string;
  locationId: string;
  quantity: number;
}

export interface OnHandWrite extends OnHandActivation {
  /**
   * What Shopify held when we read the location. `InventoryQuantityInput`
   * rejects a quantity without it — the schema marks it optional but the API
   * requires it — so there is no unconditional set. A value that moved under us
   * fails the batch, and the next run corrects it from a fresh read.
   */
  changeFromQuantity: number;
}

/** Shopify caps one mutation at 250 quantities. */
const WRITE_CHUNK = 250;

export interface WriteOnHandOptions {
  /** From `supply_source.inventory_writer`. Anything but "metakocka" throws. */
  inventoryWriter: string;
  locationId: string;
  /** Stable for one job and its retries. Feeds the `@idempotent` key. */
  runId: string;
}

/**
 * Sets on-hand for a batch of inventory items at one location.
 *
 * `available` is never written (§7): Shopify computes it as on hand minus
 * committed, and writing MetaKocka's `free_amount` into it would subtract the
 * same open order twice and silently undersell the store.
 */
export async function writeOnHand(
  admin: AdminApiContext,
  writes: OnHandWrite[],
  options: WriteOnHandOptions,
): Promise<void> {
  // §7: ownership, enforced as a throw. A partner or manual location is never
  // written, however the caller was configured.
  if (options.inventoryWriter !== "metakocka") {
    throw new InventoryOwnershipError(
      options.locationId,
      options.inventoryWriter,
    );
  }

  if (writes.length === 0) return;

  for (let start = 0; start < writes.length; start += WRITE_CHUNK) {
    const chunk = writes.slice(start, start + WRITE_CHUNK);

    const response = await admin.graphql(SET_QUANTITIES, {
      variables: {
        key: idempotencyKey(options.runId, ["set-on-hand", chunk]),
        input: {
          name: "on_hand",
          reason: "correction",
          quantities: chunk.map((write) => ({
            inventoryItemId: write.inventoryItemId,
            locationId: write.locationId,
            quantity: write.quantity,
            changeFromQuantity: write.changeFromQuantity,
          })),
        },
      },
    });

    const parsed = setQuantitiesSchema.parse(await response.json());
    const userErrors = parsed.data.inventorySetQuantities?.userErrors ?? [];

    if (userErrors.length > 0) {
      getLogger().error(
        { locationId: options.locationId, userErrors },
        "inventorySetQuantities reported user errors",
      );
      throw new Error(
        `Shopify rejected the inventory write: ${userErrors
          .map((error) => error.message)
          .join("; ")}`,
      );
    }
  }
}

/**
 * Stocks inventory items at a location for the first time, at a given on-hand.
 *
 * `inventorySetQuantities` only speaks about items that already have a level at
 * the location. A product that exists in MetaKocka but has never been stocked at
 * the mapped Shopify location has no level, so without this it would be skipped
 * on every run and its stock would never appear in Shopify.
 *
 * `inventoryActivate` takes one item per field, so several are aliased into a
 * single document rather than sent as a query in a loop (§2.5).
 */
export async function activateOnHand(
  admin: AdminApiContext,
  writes: OnHandActivation[],
  options: WriteOnHandOptions,
): Promise<void> {
  // §7: same ownership rule as writeOnHand. Activating is a write.
  if (options.inventoryWriter !== "metakocka") {
    throw new InventoryOwnershipError(
      options.locationId,
      options.inventoryWriter,
    );
  }

  if (writes.length === 0) return;

  for (let start = 0; start < writes.length; start += ACTIVATE_CHUNK) {
    const chunk = writes.slice(start, start + ACTIVATE_CHUNK);

    const declarations = chunk
      .map(
        (_, index) =>
          `$item${index}: ID!, $qty${index}: Int, $key${index}: String!`,
      )
      .join(", ");
    // Each alias is its own mutation execution, so each carries its own
    // `@idempotent` key. Shopify requires the directive on this mutation too.
    const fields = chunk
      .map(
        (_, index) =>
          `a${index}: inventoryActivate(inventoryItemId: $item${index}, locationId: $locationId, onHand: $qty${index}) @idempotent(key: $key${index}) { userErrors { field message } }`,
      )
      .join("\n    ");

    const variables: Record<string, unknown> = {
      locationId: options.locationId,
    };
    for (const [index, write] of chunk.entries()) {
      variables[`item${index}`] = write.inventoryItemId;
      variables[`qty${index}`] = write.quantity;
      variables[`key${index}`] = idempotencyKey(options.runId, [
        "activate",
        write,
      ]);
    }

    const response = await admin.graphql(
      `mutation OrchestratorActivateOnHand($locationId: ID!, ${declarations}) {\n    ${fields}\n  }`,
      { variables },
    );

    const parsed = activateSchema.parse(await response.json());
    const userErrors = Object.values(parsed.data).flatMap(
      (result) => result?.userErrors ?? [],
    );

    if (userErrors.length > 0) {
      getLogger().error(
        { locationId: options.locationId, userErrors },
        "inventoryActivate reported user errors",
      );
      throw new Error(
        `Shopify rejected stocking these items at the location: ${userErrors
          .map((error) => error.message)
          .join("; ")}`,
      );
    }
  }
}

/** Kept well under the cost ceiling: each alias is a separate mutation. */
const ACTIVATE_CHUNK = 25;

const activateSchema = z.object({
  data: z.record(
    z.string(),
    z
      .object({
        userErrors: z.array(
          z.object({
            field: z.array(z.string()).nullable().optional(),
            message: z.string(),
          }),
        ),
      })
      .nullable(),
  ),
});
