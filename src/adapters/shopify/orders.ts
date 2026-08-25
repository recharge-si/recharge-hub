import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

/**
 * Reading orders back out of Shopify, for the reconciler (CLAUDE.md §8.10).
 *
 * Webhooks are the fast path and they are not a guarantee. Shopify retries a
 * failed delivery for a while and then stops; an app that is down for an
 * afternoon simply never hears what happened in it; and `orders/updated` is not
 * promised to arrive in the order the changes were made. §8.10 already requires
 * a nightly pass for exactly this reason, and this is the read half of it.
 *
 * **The mapper returns a webhook-shaped payload, not a parsed order.** That is
 * the whole design decision in this file. The Admin API and the webhook
 * describe the same order in two different vocabularies, and if each had its
 * own parser the two would drift — the reconciler would derive a tax factor one
 * way and the webhook another, and an order would change meaning depending on
 * which path last touched it. Instead this translates shapes only, and
 * `parseOrder` stays the single place that decides what a Shopify order means.
 *
 * It also keeps `order.raw_payload` in one shape. That column is re-parsed by
 * the document writer and the partner resolver long after intake, and storing
 * two different structures under it would break both.
 *
 * GraphQL Admin API only (§2.1.5), paginated, never a query in a loop (§2.5).
 * `customer` is deliberately not selected: `read_orders` covers the addresses
 * and contact details on the order itself, and reading the customer record
 * would mean asking for `read_customers` on top (§2.3, minimum necessary).
 */

const ORDER_FIELDS = `#graphql
  id
  name
  number
  createdAt
  updatedAt
  cancelledAt
  note
  email
  phone
  currencyCode
  presentmentCurrencyCode
  displayFinancialStatus
  displayFulfillmentStatus
  taxesIncluded
  paymentGatewayNames
  currentTotalPriceSet { presentmentMoney { amount } shopMoney { amount } }
  totalPriceSet { presentmentMoney { amount } shopMoney { amount } }
  totalDiscountsSet { presentmentMoney { amount } shopMoney { amount } }
  totalTaxSet { presentmentMoney { amount } shopMoney { amount } }
  totalShippingPriceSet { presentmentMoney { amount } shopMoney { amount } }
  billingAddress {
    firstName lastName name company address1 address2 zip city province country countryCodeV2 phone
  }
  shippingAddress {
    firstName lastName name company address1 address2 zip city province country countryCodeV2 phone
  }
  lineItems(first: 100) {
    nodes {
      id
      sku
      title
      name
      quantity
      taxable
      originalUnitPriceSet { presentmentMoney { amount } shopMoney { amount } }
      totalDiscountSet { presentmentMoney { amount } shopMoney { amount } }
      taxLines { rate ratePercentage priceSet { presentmentMoney { amount } } }
    }
  }
`;

const ORDERS_SINCE_QUERY = `#graphql
  query OrchestratorOrdersSince($first: Int!, $cursor: String, $query: String!) {
    orders(first: $first, after: $cursor, query: $query, sortKey: UPDATED_AT, reverse: false) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ORDER_FIELDS} }
    }
  }
`;

const ORDER_BY_ID_QUERY = `#graphql
  query OrchestratorOrder($id: ID!) {
    order(id: $id) { ${ORDER_FIELDS} }
  }
`;

const money = z.object({
  presentmentMoney: z.object({ amount: z.string() }).nullish(),
  shopMoney: z.object({ amount: z.string() }).nullish(),
});

const address = z
  .object({
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    name: z.string().nullish(),
    company: z.string().nullish(),
    address1: z.string().nullish(),
    address2: z.string().nullish(),
    zip: z.string().nullish(),
    city: z.string().nullish(),
    province: z.string().nullish(),
    country: z.string().nullish(),
    countryCodeV2: z.string().nullish(),
    phone: z.string().nullish(),
  })
  .nullish();

const orderNode = z.object({
  id: z.string(),
  name: z.string(),
  number: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  cancelledAt: z.string().nullish(),
  note: z.string().nullish(),
  email: z.string().nullish(),
  phone: z.string().nullish(),
  currencyCode: z.string(),
  presentmentCurrencyCode: z.string(),
  displayFinancialStatus: z.string().nullish(),
  displayFulfillmentStatus: z.string().nullish(),
  taxesIncluded: z.boolean(),
  paymentGatewayNames: z.array(z.string()).default([]),
  currentTotalPriceSet: money,
  totalPriceSet: money,
  totalDiscountsSet: money,
  totalTaxSet: money,
  totalShippingPriceSet: money,
  billingAddress: address,
  shippingAddress: address,
  lineItems: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        sku: z.string().nullish(),
        title: z.string().nullish(),
        name: z.string().nullish(),
        quantity: z.number(),
        taxable: z.boolean().nullish(),
        originalUnitPriceSet: money,
        totalDiscountSet: money,
        taxLines: z
          .array(
            z.object({
              rate: z.number().nullish(),
              ratePercentage: z.number().nullish(),
              priceSet: z
                .object({
                  presentmentMoney: z
                    .object({ amount: z.string() })
                    .nullish(),
                })
                .nullish(),
            }),
          )
          .default([]),
      }),
    ),
  }),
});

type OrderNode = z.infer<typeof orderNode>;

const ordersSinceSchema = z.object({
  data: z.object({
    orders: z.object({
      pageInfo: z.object({
        hasNextPage: z.boolean(),
        endCursor: z.string().nullish(),
      }),
      nodes: z.array(orderNode),
    }),
  }),
});

const orderByIdSchema = z.object({
  data: z.object({ order: orderNode.nullable() }),
});

/**
 * The numeric id out of a GID.
 *
 * `order.shopify_order_id` holds what the webhook sends — `5001` — and the
 * Admin API says `gid://shopify/Order/5001`. Matching one against the other
 * without this finds nothing, which would make the reconciler ingest a second
 * copy of every order it looked at.
 */
export function numericId(gid: string): string {
  const tail = gid.split("/").pop() ?? gid;
  return tail.split("?")[0] ?? tail;
}

/** Presentment first: §8.6 files the currency the customer was charged in. */
function amountOf(set: z.infer<typeof money> | null | undefined): string {
  return set?.presentmentMoney?.amount ?? set?.shopMoney?.amount ?? "0";
}

/**
 * `displayFulfillmentStatus` in the webhook's vocabulary.
 *
 * The Admin enum is wider than the webhook's field, so the members without a
 * webhook equivalent pass through lower-cased and `toFulfillmentState` files
 * them under "other". They are all states this app does not act on in v1.
 */
function fulfillmentStatus(raw: string | null | undefined): string | null {
  const value = (raw ?? "").toUpperCase();
  if (value === "" || value === "UNFULFILLED") return null;
  if (value === "FULFILLED") return "fulfilled";
  if (value === "PARTIALLY_FULFILLED") return "partial";
  if (value === "RESTOCKED") return "restocked";
  return value.toLowerCase();
}

/**
 * An Admin API order in the shape `parseOrder` reads.
 *
 * Every field here has a webhook counterpart with the same meaning, which is
 * what makes one parser correct for both. The two places that need care:
 *
 *  - **`price` is the *original* unit price**, matching the webhook's
 *    `line_items[].price`, with the line discount kept separately in
 *    `total_discount`. Sending the discounted price and the discount would
 *    subtract the same money twice.
 *  - **`rate` is a decimal, not a percentage.** `TaxLine` offers both and they
 *    differ by a factor of a hundred; a percentage read as a decimal would put
 *    22 where 0.22 belongs and produce a document taxed at 2200%.
 */
export function toWebhookShape(node: OrderNode): Record<string, unknown> {
  return {
    id: numericId(node.id),
    order_number: node.number,
    name: node.name,
    currency: node.currencyCode,
    presentment_currency: node.presentmentCurrencyCode,
    financial_status: (node.displayFinancialStatus ?? "").toLowerCase() || null,
    fulfillment_status: fulfillmentStatus(node.displayFulfillmentStatus),
    cancelled_at: node.cancelledAt ?? null,
    total_price: amountOf(node.totalPriceSet),
    current_total_price: amountOf(node.currentTotalPriceSet),
    total_discounts: amountOf(node.totalDiscountsSet),
    total_tax: amountOf(node.totalTaxSet),
    taxes_included: node.taxesIncluded,
    total_shipping_price_set: {
      presentment_money: {
        amount: node.totalShippingPriceSet.presentmentMoney?.amount ?? "0",
      },
      shop_money: {
        amount: node.totalShippingPriceSet.shopMoney?.amount ?? "0",
      },
    },
    payment_gateway_names: node.paymentGatewayNames,
    note: node.note ?? null,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    email: node.email ?? null,
    phone: node.phone ?? null,
    billing_address: node.billingAddress
      ? {
          first_name: node.billingAddress.firstName ?? null,
          last_name: node.billingAddress.lastName ?? null,
          name: node.billingAddress.name ?? null,
          company: node.billingAddress.company ?? null,
          address1: node.billingAddress.address1 ?? null,
          address2: node.billingAddress.address2 ?? null,
          zip: node.billingAddress.zip ?? null,
          city: node.billingAddress.city ?? null,
          province: node.billingAddress.province ?? null,
          country: node.billingAddress.country ?? null,
          country_code: node.billingAddress.countryCodeV2 ?? null,
          phone: node.billingAddress.phone ?? null,
        }
      : null,
    shipping_address: node.shippingAddress
      ? {
          first_name: node.shippingAddress.firstName ?? null,
          last_name: node.shippingAddress.lastName ?? null,
          name: node.shippingAddress.name ?? null,
          company: node.shippingAddress.company ?? null,
          address1: node.shippingAddress.address1 ?? null,
          address2: node.shippingAddress.address2 ?? null,
          zip: node.shippingAddress.zip ?? null,
          city: node.shippingAddress.city ?? null,
          province: node.shippingAddress.province ?? null,
          country: node.shippingAddress.country ?? null,
          country_code: node.shippingAddress.countryCodeV2 ?? null,
          phone: node.shippingAddress.phone ?? null,
        }
      : null,
    line_items: node.lineItems.nodes.map((line) => ({
      id: numericId(line.id),
      sku: line.sku ?? null,
      title: line.title ?? null,
      name: line.name ?? null,
      quantity: line.quantity,
      price: amountOf(line.originalUnitPriceSet),
      total_discount: amountOf(line.totalDiscountSet),
      taxable: line.taxable ?? null,
      tax_lines: line.taxLines.map((tax) => ({
        rate:
          tax.rate ??
          (tax.ratePercentage === null || tax.ratePercentage === undefined
            ? null
            : tax.ratePercentage / 100),
        price: tax.priceSet?.presentmentMoney?.amount ?? null,
      })),
    })),
  };
}

export interface OrdersPage {
  /** Webhook-shaped payloads, ready for `parseOrder`. */
  orders: Record<string, unknown>[];
  cursor: string | null;
  hasNextPage: boolean;
}

/**
 * One page of orders Shopify has touched since `since`.
 *
 * Sorted by `updated_at` ascending so the caller can advance its watermark
 * safely: a run that stops halfway has still fully covered everything before
 * the last order it saw.
 *
 * Note `updated_at:>=`, not `>`. Two orders can share a timestamp to the
 * second, and an exclusive bound would step over the second one for good. A
 * repeated order costs one diff that finds nothing; a skipped one is silent
 * data loss.
 */
export async function fetchOrdersUpdatedSince(
  admin: AdminApiContext,
  since: Date,
  options: { cursor?: string | null; pageSize?: number } = {},
): Promise<OrdersPage> {
  const response = await admin.graphql(ORDERS_SINCE_QUERY, {
    variables: {
      first: options.pageSize ?? 50,
      cursor: options.cursor ?? null,
      query: `updated_at:>='${since.toISOString()}'`,
    },
  });

  const parsed = ordersSinceSchema.parse(await response.json());
  const { nodes, pageInfo } = parsed.data.orders;

  return {
    orders: nodes.map(toWebhookShape),
    cursor: pageInfo.endCursor ?? null,
    hasNextPage: pageInfo.hasNextPage,
  };
}

/** One order, by the numeric id this app stores. Null when Shopify has none. */
export async function fetchOrderById(
  admin: AdminApiContext,
  shopifyOrderId: string,
): Promise<Record<string, unknown> | null> {
  const response = await admin.graphql(ORDER_BY_ID_QUERY, {
    variables: { id: `gid://shopify/Order/${shopifyOrderId}` },
  });

  const parsed = orderByIdSchema.parse(await response.json());
  return parsed.data.order ? toWebhookShape(parsed.data.order) : null;
}
