import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

/**
 * Markets price lists, as far as a sale needs to know
 * (docs/sale-campaigns.md § Markets and currencies).
 *
 * A market that prices by percentage adjustment or by currency conversion
 * follows the base price this app writes. A market with **fixed** prices on
 * a variant does not, and nothing here changes those: the preview names the
 * markets that hold fixed prices so the merchant knows which variants keep
 * their market price during the sale.
 */

const PRICE_LISTS_QUERY = `#graphql
  query OrchestratorPriceLists($cursor: String) {
    priceLists(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        currency
        fixedPricesCount
        parent { adjustment { type value } }
      }
    }
  }
`;

const priceListsSchema = z.object({
  data: z.object({
    priceLists: z.object({
      pageInfo: z.object({
        hasNextPage: z.boolean(),
        endCursor: z.string().nullable(),
      }),
      nodes: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          currency: z.string(),
          fixedPricesCount: z.number(),
          parent: z
            .object({
              adjustment: z.object({
                type: z.string(),
                value: z.number(),
              }),
            })
            .nullable(),
        }),
      ),
    }),
  }),
});

export interface PriceList {
  priceListId: string;
  name: string;
  currency: string;
  fixedPricesCount: number;
  adjustmentType: string | null;
  adjustmentValue: string | null;
}

export async function listPriceLists(
  admin: AdminApiContext,
): Promise<PriceList[]> {
  const lists: PriceList[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 20; page += 1) {
    const response = await admin.graphql(PRICE_LISTS_QUERY, {
      variables: { cursor },
      tries: 3,
    });
    const parsed = priceListsSchema.parse(await response.json());
    const { nodes, pageInfo } = parsed.data.priceLists;

    for (const node of nodes) {
      lists.push({
        priceListId: node.id,
        name: node.name,
        currency: node.currency,
        fixedPricesCount: node.fixedPricesCount,
        adjustmentType: node.parent?.adjustment.type ?? null,
        adjustmentValue:
          node.parent === null ? null : String(node.parent.adjustment.value),
      });
    }

    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
  }

  return lists;
}
