import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

/**
 * The payment gateways this shop actually uses (CLAUDE.md §8.7).
 *
 * Shopify has no endpoint that lists a shop's gateway names as they appear on
 * an order, and the mapping keys on exactly that string. So we read it from the
 * orders themselves: whatever `paymentGatewayNames` has carried recently is
 * what an incoming order will carry.
 *
 * GraphQL Admin API only (§2.1.5), one query, no query in a loop (§2.5). Needs
 * the `read_orders` scope, which the app already holds for order intake. No
 * customer field is requested here.
 */
const GATEWAYS_QUERY = `#graphql
  query OrchestratorPaymentGateways($first: Int!) {
    orders(first: $first, sortKey: CREATED_AT, reverse: true) {
      nodes {
        paymentGatewayNames
      }
    }
  }
`;

const responseSchema = z.object({
  data: z.object({
    orders: z.object({
      nodes: z.array(
        z.object({
          paymentGatewayNames: z.array(z.string()),
        }),
      ),
    }),
  }),
});

/**
 * Gateways every Shopify store can produce, so the list is never empty on a
 * store that has not taken an order yet. `manual` covers bank transfer, cash
 * and any other manual method the merchant has named.
 */
export const COMMON_GATEWAYS = [
  "shopify_payments",
  "manual",
  "cash_on_delivery",
  "bank_deposit",
  "paypal",
  "gift_card",
  "exchange-credit",
];

export async function listPaymentGateways(
  admin: AdminApiContext,
  first = 50,
): Promise<string[]> {
  const response = await admin.graphql(GATEWAYS_QUERY, {
    variables: { first },
  });

  // §4: every external boundary is parsed, including Shopify's.
  const parsed = responseSchema.parse(await response.json());

  const seen = new Set<string>();
  for (const order of parsed.data.orders.nodes) {
    for (const gateway of order.paymentGatewayNames) {
      const trimmed = gateway.trim();
      if (trimmed) seen.add(trimmed);
    }
  }

  return [...seen].sort((a, b) => a.localeCompare(b));
}
