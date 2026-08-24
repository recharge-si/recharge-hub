import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import { getLogger } from "~/adapters/observability/logger.server";

/**
 * Reading Shopify variants and writing on-hand inventory.
 *
 * CLAUDE.md §7 is the whole design here: one writer per location, and this app
 * writes `on_hand` only for locations it owns. The ownership check is a throw,
 * not a convention.
 */

const VARIANTS_QUERY = `#graphql
  query OrchestratorVariants($cursor: String) {
    productVariants(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        sku
        displayName
        inventoryItem { id }
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
          displayName: z.string().nullable(),
          inventoryItem: z.object({ id: z.string() }).nullable(),
        }),
      ),
    }),
  }),
});

export interface ShopifyVariant {
  variantId: string;
  sku: string;
  inventoryItemId: string | null;
  title: string | null;
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
      // A variant with no SKU cannot be matched to a MetaKocka article.
      if (!sku) continue;

      variants.push({
        variantId: node.id,
        sku,
        inventoryItemId: node.inventoryItem?.id ?? null,
        title: node.displayName ?? null,
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
 * Needed because §7 asks for `ignoreCompareQuantity: false`, and that means
 * every write has to state the value it believes it is replacing. Without it a
 * concurrent change by the merchant would be silently clobbered.
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
  mutation OrchestratorSetOnHand($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      userErrors { field message }
      inventoryAdjustmentGroup { createdAt reason }
    }
  }
`;

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

export interface OnHandWrite {
  inventoryItemId: string;
  locationId: string;
  quantity: number;
  /** What Shopify currently holds. Required by `ignoreCompareQuantity: false`. */
  compareQuantity: number;
}

/** Shopify caps one mutation at 250 quantities. */
const WRITE_CHUNK = 250;

export interface WriteOnHandOptions {
  /** From `supply_source.inventory_writer`. Anything but "metakocka" throws. */
  inventoryWriter: string;
  locationId: string;
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
        input: {
          name: "on_hand",
          reason: "correction",
          // Fail rather than clobber a value that changed under us.
          ignoreCompareQuantity: false,
          quantities: chunk.map((write) => ({
            inventoryItemId: write.inventoryItemId,
            locationId: write.locationId,
            quantity: write.quantity,
            compareQuantity: write.compareQuantity,
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
