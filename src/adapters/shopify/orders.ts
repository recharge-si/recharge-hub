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

/**
 * How many line items one page carries.
 *
 * Shopify allows more, but this is nested inside a page of fifty orders and
 * the query's calculated cost multiplies out — fifty orders of two hundred and
 * fifty lines is a document Shopify throttles rather than answers.
 */
const LINE_ITEM_PAGE = 100;

const TAX_LINE_FIELDS = `#graphql
  title
  rate
  ratePercentage
  priceSet { presentmentMoney { amount } shopMoney { amount } }
`;

const LINE_ITEM_FIELDS = `#graphql
  id
  sku
  title
  name
  quantity
  taxable
  originalUnitPriceSet { presentmentMoney { amount } shopMoney { amount } }
  totalDiscountSet { presentmentMoney { amount } shopMoney { amount } }
  taxLines { ${TAX_LINE_FIELDS} }
`;

/**
 * How many shipping lines and refunds one order read carries. An order has one
 * or two shipping lines and a handful of refunds; the caps keep the query's
 * calculated cost bounded inside a page of fifty orders.
 */
const SHIPPING_LINE_PAGE = 10;
const REFUND_PAGE = 20;
const REFUND_LINE_PAGE = 50;

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
  taxExempt
  paymentGatewayNames
  currentTotalPriceSet { presentmentMoney { amount } shopMoney { amount } }
  totalPriceSet { presentmentMoney { amount } shopMoney { amount } }
  totalDiscountsSet { presentmentMoney { amount } shopMoney { amount } }
  totalTaxSet { presentmentMoney { amount } shopMoney { amount } }
  currentTotalTaxSet { presentmentMoney { amount } shopMoney { amount } }
  totalShippingPriceSet { presentmentMoney { amount } shopMoney { amount } }
  taxLines { ${TAX_LINE_FIELDS} }
  customAttributes { key value }
  shippingLines(first: ${SHIPPING_LINE_PAGE}) {
    nodes {
      title
      originalPriceSet { presentmentMoney { amount } shopMoney { amount } }
      discountedPriceSet { presentmentMoney { amount } shopMoney { amount } }
      taxLines { ${TAX_LINE_FIELDS} }
    }
  }
  refunds(first: ${REFUND_PAGE}) {
    id
    createdAt
    refundLineItems(first: ${REFUND_LINE_PAGE}) {
      nodes {
        quantity
        subtotalSet { presentmentMoney { amount } shopMoney { amount } }
        totalTaxSet { presentmentMoney { amount } shopMoney { amount } }
        lineItem { id }
      }
    }
    refundShippingLines(first: ${SHIPPING_LINE_PAGE}) {
      nodes {
        subtotalAmountSet { presentmentMoney { amount } shopMoney { amount } }
        taxAmountSet { presentmentMoney { amount } shopMoney { amount } }
      }
    }
  }
  billingAddress {
    firstName lastName name company address1 address2 zip city province provinceCode country countryCodeV2 phone
  }
  shippingAddress {
    firstName lastName name company address1 address2 zip city province provinceCode country countryCodeV2 phone
  }
  lineItems(first: ${LINE_ITEM_PAGE}) {
    pageInfo { hasNextPage endCursor }
    nodes { ${LINE_ITEM_FIELDS} }
  }
`;

/**
 * The rest of the lines, for an order with more than one page of them.
 *
 * Only ever issued for an order that reported `hasNextPage`, which is a
 * handful of B2B orders in a catalogue's lifetime — not a query in a loop
 * (§2.5), which is what asking for every order's lines separately would be.
 */
const ORDER_LINE_ITEMS_QUERY = `#graphql
  query OrchestratorOrderLineItems($id: ID!, $cursor: String) {
    order(id: $id) {
      lineItems(first: ${LINE_ITEM_PAGE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ${LINE_ITEM_FIELDS} }
      }
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
    provinceCode: z.string().nullish(),
    country: z.string().nullish(),
    countryCodeV2: z.string().nullish(),
    phone: z.string().nullish(),
  })
  .nullish();

const taxLine = z.object({
  title: z.string().nullish(),
  rate: z.number().nullish(),
  ratePercentage: z.number().nullish(),
  priceSet: money.nullish(),
});

type TaxLineNode = z.infer<typeof taxLine>;

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
  taxExempt: z.boolean().nullish(),
  paymentGatewayNames: z.array(z.string()).default([]),
  currentTotalPriceSet: money,
  totalPriceSet: money,
  totalDiscountsSet: money,
  totalTaxSet: money,
  // Optional so a fixture recorded before these existed still parses.
  currentTotalTaxSet: money.nullish(),
  totalShippingPriceSet: money,
  // Nullish rather than defaulted, so a node built or recorded before these
  // fields were read still passes through the mapper unchanged.
  taxLines: z.array(taxLine).nullish(),
  customAttributes: z
    .array(z.object({ key: z.string(), value: z.string().nullish() }))
    .nullish(),
  shippingLines: z
    .object({
      nodes: z.array(
        z.object({
          title: z.string().nullish(),
          originalPriceSet: money.nullish(),
          discountedPriceSet: money.nullish(),
          taxLines: z.array(taxLine).nullish(),
        }),
      ),
    })
    .nullish(),
  refunds: z
    .array(
      z.object({
        id: z.string(),
        createdAt: z.string().nullish(),
        refundLineItems: z
          .object({
            nodes: z.array(
              z.object({
                quantity: z.number(),
                subtotalSet: money.nullish(),
                totalTaxSet: money.nullish(),
                lineItem: z.object({ id: z.string() }).nullish(),
              }),
            ),
          })
          .nullish(),
        refundShippingLines: z
          .object({
            nodes: z.array(
              z.object({
                subtotalAmountSet: money.nullish(),
                taxAmountSet: money.nullish(),
              }),
            ),
          })
          .nullish(),
      }),
    )
    .nullish(),
  billingAddress: address,
  shippingAddress: address,
  lineItems: z.object({
    // Optional so a fixture recorded before this existed still parses; absent
    // reads as "there is only one page", which is what it was.
    pageInfo: z
      .object({
        hasNextPage: z.boolean(),
        endCursor: z.string().nullish(),
      })
      .nullish(),
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
        taxLines: z.array(taxLine).nullish(),
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

/** A money bag in the webhook's `*_set` shape. */
function setOf(set: z.infer<typeof money> | null | undefined) {
  return {
    presentment_money: { amount: set?.presentmentMoney?.amount ?? "0" },
    shop_money: { amount: set?.shopMoney?.amount ?? "0" },
  };
}

/**
 * Tax lines in the webhook's vocabulary.
 *
 * `rate` is a decimal, not a percentage. `TaxLine` offers both and they differ
 * by a factor of a hundred; a percentage read as a decimal would put 22 where
 * 0.22 belongs and produce a document taxed at 2200%.
 */
function taxLinesOf(lines: TaxLineNode[] | null | undefined) {
  return (lines ?? []).map((tax) => ({
    title: tax.title ?? null,
    rate:
      tax.rate ??
      (tax.ratePercentage === null || tax.ratePercentage === undefined
        ? null
        : tax.ratePercentage / 100),
    price: amountOf(tax.priceSet),
    price_set: setOf(tax.priceSet),
  }));
}

/**
 * A refund in the webhook's vocabulary. A refunded shipping charge is a
 * negative `shipping_refund` adjustment there, so the GraphQL shipping lines
 * are summed into one.
 */
function refundsOf(refunds: OrderNode["refunds"]) {
  return (refunds ?? []).map((refund) => {
    const shipping = refund.refundShippingLines?.nodes ?? [];
    const shippingMinor = shipping.reduce(
      (sum, line) => sum + Number(amountOf(line.subtotalAmountSet)),
      0,
    );
    const shippingTax = shipping.reduce(
      (sum, line) => sum + Number(amountOf(line.taxAmountSet)),
      0,
    );

    return {
      id: numericId(refund.id),
      created_at: refund.createdAt ?? null,
      refund_line_items: (refund.refundLineItems?.nodes ?? [])
        .filter((line) => line.lineItem)
        .map((line) => ({
          line_item_id: numericId(line.lineItem!.id),
          quantity: line.quantity,
          subtotal: amountOf(line.subtotalSet),
          subtotal_set: setOf(line.subtotalSet),
          total_tax: amountOf(line.totalTaxSet),
          total_tax_set: setOf(line.totalTaxSet),
        })),
      order_adjustments:
        shipping.length > 0
          ? [
              {
                kind: "shipping_refund",
                amount: (-shippingMinor).toFixed(2),
                tax_amount: (-shippingTax).toFixed(2),
              },
            ]
          : [],
    };
  });
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
    ...(node.currentTotalTaxSet
      ? { current_total_tax: amountOf(node.currentTotalTaxSet) }
      : {}),
    taxes_included: node.taxesIncluded,
    tax_exempt: node.taxExempt ?? null,
    tax_lines: taxLinesOf(node.taxLines),
    total_shipping_price_set: setOf(node.totalShippingPriceSet),
    ...(node.shippingLines
      ? {
          shipping_lines: node.shippingLines.nodes.map((line) => ({
            title: line.title ?? null,
            price: amountOf(line.originalPriceSet),
            price_set: setOf(line.originalPriceSet),
            discounted_price: amountOf(line.discountedPriceSet ?? line.originalPriceSet),
            discounted_price_set: setOf(line.discountedPriceSet ?? line.originalPriceSet),
            tax_lines: taxLinesOf(line.taxLines),
          })),
        }
      : {}),
    note_attributes: (node.customAttributes ?? []).map((attribute) => ({
      name: attribute.key,
      value: attribute.value ?? null,
    })),
    refunds: refundsOf(node.refunds),
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
          province_code: node.billingAddress.provinceCode ?? null,
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
          province_code: node.shippingAddress.provinceCode ?? null,
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
      tax_lines: taxLinesOf(line.taxLines),
    })),
  };
}

/**
 * The most line-item pages this will read for one order.
 *
 * Twenty-five pages is two and a half thousand lines, which is far past any
 * real order and still bounded — an unbounded follow-up loop on a pathological
 * order would hold the worker for the rest of the day.
 */
const MAX_LINE_ITEM_PAGES = 25;

/** An order with more lines than this app is willing to read in one pass. */
export class OrderTooManyLinesError extends Error {
  constructor(
    readonly orderId: string,
    readonly readSoFar: number,
  ) {
    super(
      `Order ${orderId} has more than ${readSoFar} line items, which is more than one reconciliation pass will read. Nothing was changed.`,
    );
    this.name = "OrderTooManyLinesError";
  }
}

const lineItemsPageSchema = z.object({
  data: z.object({
    order: z
      .object({
        lineItems: z.object({
          pageInfo: z.object({
            hasNextPage: z.boolean(),
            endCursor: z.string().nullish(),
          }),
          nodes: z.array(orderNode.shape.lineItems.shape.nodes.element),
        }),
      })
      .nullable(),
  }),
});

/**
 * An order node whose `lineItems.nodes` really are all of them.
 *
 * The list query asks for one page of lines per order, and an order with more
 * used to arrive silently truncated. That is not a display problem: the
 * reconciler compares the payload against the stored order line by line, so
 * every line past the first page read as **removed** — the order was rewritten
 * without them, allocated again, and the MetaKocka document diverged from an
 * order nobody had edited.
 *
 * Orders that need this are rare, so the follow-up is issued only for the ones
 * that say they have more, and never for the rest.
 */
async function withAllLineItems(
  admin: AdminApiContext,
  node: OrderNode,
): Promise<OrderNode> {
  if (!node.lineItems.pageInfo?.hasNextPage) return node;

  const nodes = [...node.lineItems.nodes];
  let cursor = node.lineItems.pageInfo.endCursor ?? null;

  for (let page = 0; page < MAX_LINE_ITEM_PAGES; page += 1) {
    const response = await admin.graphql(ORDER_LINE_ITEMS_QUERY, {
      variables: { id: node.id, cursor },
    });

    const parsed = lineItemsPageSchema.parse(await response.json());
    const lineItems = parsed.data.order?.lineItems;
    // The order disappeared between the two reads. What was read is what
    // there is; the next pass will find it gone and say so.
    if (!lineItems) break;

    nodes.push(...lineItems.nodes);

    if (!lineItems.pageInfo.hasNextPage) {
      return {
        ...node,
        lineItems: { pageInfo: lineItems.pageInfo, nodes },
      };
    }
    cursor = lineItems.pageInfo.endCursor ?? null;
  }

  /*
   * Past the cap, refusing is the only safe answer.
   *
   * Returning what was read would hand the reconciler a truncated order and it
   * would delete the rest — the exact failure this function exists to prevent,
   * arrived at by a different route. The caller catches this per order, holds
   * its watermark, and leaves the order alone.
   */
  throw new OrderTooManyLinesError(numericId(node.id), nodes.length);
}

export interface OrdersPage {
  /** Webhook-shaped payloads, ready for `parseOrder`. */
  orders: Record<string, unknown>[];
  /**
   * Orders in this page that could not be read whole, and so were not read at
   * all. Reported rather than thrown: one pathological order must not stop the
   * sweep, and it must not be skipped quietly either.
   */
  oversized: {
    shopifyOrderId: string;
    linesRead: number;
    /** Shopify's `updatedAt`, so the caller can hold its watermark behind it. */
    updatedAt: string;
  }[];
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

  const orders: Record<string, unknown>[] = [];
  const oversized: OrdersPage["oversized"] = [];

  for (const node of nodes) {
    // Sequential on purpose: only the rare over-long order does any work here,
    // and firing its follow-ups alongside everything else would spend the
    // shop's leaky bucket on the one order that needs it least urgently.
    try {
      orders.push(toWebhookShape(await withAllLineItems(admin, node)));
    } catch (error) {
      if (error instanceof OrderTooManyLinesError) {
        oversized.push({
          shopifyOrderId: error.orderId,
          linesRead: error.readSoFar,
          updatedAt: node.updatedAt,
        });
        continue;
      }
      throw error;
    }
  }

  return {
    orders,
    oversized,
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
  if (!parsed.data.order) return null;
  return toWebhookShape(await withAllLineItems(admin, parsed.data.order));
}
