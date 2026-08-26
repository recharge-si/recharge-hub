import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

/**
 * Shopify locations, for mapping onto supply sources (CLAUDE.md §6).
 *
 * GraphQL Admin API only (§2.1.5), one batched query, never a query in a loop
 * (§2.5). Needs the `read_locations` scope.
 */
const LOCATIONS_QUERY = `#graphql
  query OrchestratorLocations($first: Int!) {
    locations(first: $first, includeInactive: true) {
      nodes {
        id
        name
        isActive
        fulfillmentService {
          handle
          serviceName
        }
        address {
          city
          country
        }
      }
    }
  }
`;

const responseSchema = z.object({
  data: z.object({
    locations: z.object({
      nodes: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          isActive: z.boolean(),
          fulfillmentService: z
            .object({
              handle: z.string().nullable().optional(),
              serviceName: z.string().nullable().optional(),
            })
            .nullable()
            .optional(),
          address: z
            .object({
              city: z.string().nullable().optional(),
              country: z.string().nullable().optional(),
            })
            .nullable()
            .optional(),
        }),
      ),
    }),
  }),
});

export interface ShopifyLocation {
  id: string;
  name: string;
  isActive: boolean;
  /** Set when the location belongs to a third-party fulfillment service. */
  fulfillmentServiceName: string | null;
  where: string | null;
}

export async function listLocations(
  admin: AdminApiContext,
  first = 100,
): Promise<ShopifyLocation[]> {
  const response = await admin.graphql(LOCATIONS_QUERY, {
    variables: { first },
  });

  // §4: every external boundary is parsed, including Shopify's.
  const parsed = responseSchema.parse(await response.json());

  return parsed.data.locations.nodes.map((node) => {
    const city = node.address?.city ?? null;
    const country = node.address?.country ?? null;

    return {
      id: node.id,
      name: node.name,
      isActive: node.isActive,
      fulfillmentServiceName: node.fulfillmentService?.serviceName ?? null,
      where: [city, country].filter(Boolean).join(", ") || null,
    };
  });
}

/**
 * One Shopify location id, in a form both sides of a comparison can agree on.
 *
 * **The two sides did not agree, and it was invisible until a real order ran
 * through.** `supply_source.shopify_location_id` holds what the settings screen
 * saved, which is the full GID — `gid://shopify/Location/120913232136`. The
 * fulfilment-order reader emits the numeric tail, because that is the form the
 * rest of the order pipeline uses (`order.shopify_order_id` is `5001`, not a
 * GID). Looking one up by the other misses every time.
 *
 * The consequence was total rather than partial: under Shopify-driven
 * allocation *no* location could ever resolve to a supply source, so every
 * assignment fell through as unresolved and no order could be filed against the
 * warehouse Shopify had chosen. Every unit test passed, because a test that
 * invents both sides invents them in the same shape.
 *
 * Normalising rather than migrating the column: the stored GID is what the
 * Shopify pickers and the supply-source screen round-trip, and rewriting it
 * would be a data migration to fix a comparison.
 */
export function locationKey(id: string | null | undefined): string | null {
  if (!id) return null;
  const trimmed = id.trim();
  if (trimmed === "") return null;
  const tail = trimmed.split("/").pop() ?? trimmed;
  return tail.split("?")[0] || null;
}

/** Whether two Shopify location references mean the same location. */
export function sameLocation(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = locationKey(a);
  const right = locationKey(b);
  return left !== null && left === right;
}
