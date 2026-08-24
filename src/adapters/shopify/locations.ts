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
