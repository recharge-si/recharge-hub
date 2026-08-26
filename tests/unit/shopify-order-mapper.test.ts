import { describe, expect, it, vi } from "vitest";

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { parseOrder, toSnapshot } from "~/adapters/shopify/order-payload";
import {
  fetchOrdersUpdatedSince,
  numericId,
  toWebhookShape,
} from "~/adapters/shopify/orders";

/**
 * The Admin API's view of an order, translated into the webhook's shape.
 *
 * The reconciler reads orders back from GraphQL because webhooks are
 * best-effort, and the two describe the same order in different vocabularies.
 * This mapper is the only place that knows the difference — `parseOrder` stays
 * the single place that decides what a Shopify order *means* — so the whole
 * risk of the reconciler is concentrated here and pinned by these tests.
 */

const NODE = {
  id: "gid://shopify/Order/5001",
  name: "#1042",
  number: 1042,
  createdAt: "2026-08-24T10:00:00Z",
  updatedAt: "2026-08-25T09:30:00Z",
  cancelledAt: null,
  note: "Leave at the door",
  email: "buyer@example.test",
  phone: null,
  currencyCode: "EUR",
  presentmentCurrencyCode: "EUR",
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "UNFULFILLED",
  taxesIncluded: true,
  paymentGatewayNames: ["bank_deposit"],
  currentTotalPriceSet: { presentmentMoney: { amount: "119.98" } },
  totalPriceSet: { presentmentMoney: { amount: "119.98" } },
  totalDiscountsSet: { presentmentMoney: { amount: "10.00" } },
  totalTaxSet: { presentmentMoney: { amount: "21.63" } },
  totalShippingPriceSet: {
    presentmentMoney: { amount: "4.99" },
    shopMoney: { amount: "4.99" },
  },
  billingAddress: {
    firstName: "Grega",
    lastName: "Rotar",
    name: "Grega Rotar",
    company: null,
    address1: "Cesta 1",
    address2: null,
    zip: "1000",
    city: "Ljubljana",
    province: null,
    country: "Slovenia",
    countryCodeV2: "SI",
    phone: null,
  },
  shippingAddress: null,
  lineItems: {
    nodes: [
      {
        id: "gid://shopify/LineItem/9001",
        sku: "MAST-490",
        title: "Carbon mast",
        name: "Carbon mast - 490",
        quantity: 2,
        taxable: true,
        originalUnitPriceSet: { presentmentMoney: { amount: "59.99" } },
        totalDiscountSet: { presentmentMoney: { amount: "5.00" } },
        taxLines: [
          {
            rate: 0.22,
            ratePercentage: 22,
            priceSet: { presentmentMoney: { amount: "10.82" } },
          },
        ],
      },
    ],
  },
};

describe("numericId", () => {
  it("takes the numeric id out of a GID", () => {
    // The webhook stores 5001; the Admin API says gid://shopify/Order/5001.
    // Matching one against the other without this finds nothing, and the
    // reconciler would ingest a second copy of every order it looked at.
    expect(numericId("gid://shopify/Order/5001")).toBe("5001");
    expect(numericId("5001")).toBe("5001");
  });
});

describe("toWebhookShape", () => {
  it("produces a payload the webhook parser understands", () => {
    const parsed = parseOrder(toWebhookShape(NODE));

    expect(parsed.shopifyOrderId).toBe("5001");
    expect(parsed.orderNumber).toBe("1042");
    expect(parsed.currency).toBe("EUR");
    expect(parsed.financialStatus).toBe("paid");
    expect(parsed.fulfillmentState).toBe("unfulfilled");
    expect(parsed.gateway).toBe("bank_deposit");
    expect(parsed.taxesIncluded).toBe(true);
    expect(parsed.totalMinor).toBe(11998);
    expect(parsed.shippingMinor).toBe(499);
    expect(parsed.discountMinor).toBe(1000);
    expect(parsed.updatedAt?.toISOString()).toBe("2026-08-25T09:30:00.000Z");
    expect(parsed.cancelledAt).toBeNull();
  });

  it("reads the tax rate as a decimal, never as a percentage", () => {
    // TaxLine offers `rate` (0.22) and `ratePercentage` (22) and they differ by
    // a factor of a hundred. A percentage read as a decimal produces a
    // MetaKocka line taxed at 2200%.
    const parsed = parseOrder(toWebhookShape(NODE));
    expect(parsed.lines[0]?.taxFactor).toBe("0.22");
  });

  it("falls back to ratePercentage when rate is absent", () => {
    const node = structuredClone(NODE);
    node.lineItems.nodes[0]!.taxLines[0]! = {
      rate: null as unknown as number,
      ratePercentage: 9.5,
      priceSet: { presentmentMoney: { amount: "1.00" } },
    };

    const parsed = parseOrder(toWebhookShape(node));
    expect(parsed.lines[0]?.taxFactor).toBe("0.095");
  });

  it("keeps the original unit price and the line discount apart", () => {
    // The webhook's `price` is the price before the line discount, with the
    // discount in `total_discount`. Mapping the discounted price here would
    // subtract the same money twice.
    const parsed = parseOrder(toWebhookShape(NODE));
    expect(parsed.lines[0]?.unitPriceWithTaxMinor).toBe(5999);
    expect(parsed.lines[0]?.discountMinor).toBe(500);
  });

  it("carries the billing address through as the MetaKocka partner", () => {
    const parsed = parseOrder(toWebhookShape(NODE));
    expect(parsed.partner?.customer).toBe("Grega Rotar");
    expect(parsed.partner?.street).toBe("Cesta 1");
    expect(parsed.partner?.place).toBe("Ljubljana");
    expect(parsed.partner?.email).toBe("buyer@example.test");
    expect(parsed.receiver).toBeNull();
  });

  it("normalises the wider Admin fulfilment enum", () => {
    for (const [display, expected] of [
      ["FULFILLED", "fulfilled"],
      ["PARTIALLY_FULFILLED", "partial"],
      ["RESTOCKED", "restocked"],
      ["UNFULFILLED", "unfulfilled"],
      // Members with no webhook equivalent are states this app does not act on.
      ["ON_HOLD", "other"],
      ["IN_PROGRESS", "other"],
    ] as const) {
      const node = structuredClone(NODE);
      node.displayFulfillmentStatus = display;
      expect(parseOrder(toWebhookShape(node)).fulfillmentState).toBe(expected);
    }
  });

  it("reads a cancellation", () => {
    const node = structuredClone(NODE);
    node.cancelledAt = "2026-08-25T12:00:00Z" as unknown as null;

    const snapshot = toSnapshot(parseOrder(toWebhookShape(node)));
    expect(snapshot.cancelled).toBe(true);
  });

  it("maps an unknown financial status to unknown rather than guessing", () => {
    const node = structuredClone(NODE);
    node.displayFinancialStatus = "EXPIRED";

    expect(parseOrder(toWebhookShape(node)).financialStatus).toBe("unknown");
  });
});

/*
 * An order with more line items than one page holds.
 *
 * This is not a display problem. `syncOrderState` compares the payload against
 * the stored order line by line, so a truncated read makes every line past the
 * page boundary look **removed**: the order is rewritten without them,
 * allocated again, and the MetaKocka document diverges from an order nobody
 * touched.
 */
describe("an order with more lines than one page", () => {
  function line(id: number) {
    return {
      id: `gid://shopify/LineItem/${id}`,
      sku: `SKU-${id}`,
      title: `Item ${id}`,
      name: `Item ${id}`,
      quantity: 1,
      taxable: true,
      originalUnitPriceSet: { presentmentMoney: { amount: "1.00" } },
      totalDiscountSet: { presentmentMoney: { amount: "0.00" } },
      taxLines: [],
    };
  }

  /** An order whose first page of lines says there is another. */
  const TRUNCATED = {
    ...NODE,
    lineItems: {
      pageInfo: { hasNextPage: true, endCursor: "cursor-0" },
      nodes: [line(1), line(2)],
    },
  };

  /**
   * An admin that answers the order listing once and then serves line-item
   * follow-ups, chosen by which query it was handed.
   */
  function fakeAdmin(followUps: { nodes: unknown[]; next: boolean }[]) {
    let followUp = 0;

    const graphql = vi.fn(async (query: string) => {
      const body = query.includes("OrchestratorOrderLineItems")
        ? {
            data: {
              order: {
                lineItems: {
                  pageInfo: {
                    hasNextPage: followUps[followUp]?.next ?? false,
                    endCursor: `cursor-${followUp + 1}`,
                  },
                  nodes: followUps[followUp++]?.nodes ?? [],
                },
              },
            },
          }
        : {
            data: {
              orders: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [TRUNCATED],
              },
            },
          };

      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    return { admin: { graphql } as unknown as AdminApiContext, graphql };
  }

  it("reads the rest rather than treating them as removed", async () => {
    const { admin } = fakeAdmin([{ nodes: [line(3), line(4)], next: false }]);

    const page = await fetchOrdersUpdatedSince(admin, new Date(0));

    expect(page.oversized).toEqual([]);
    expect(
      (page.orders[0] as { line_items: unknown[] }).line_items,
    ).toHaveLength(4);
  });

  it("asks for no follow-up when the first page is all of them", async () => {
    const { admin, graphql } = fakeAdmin([]);
    // The listing itself reports one complete page.
    graphql.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              orders: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    ...NODE,
                    lineItems: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [line(1)],
                    },
                  },
                ],
              },
            },
          }),
          { status: 200 },
        ),
    );

    await fetchOrdersUpdatedSince(admin, new Date(0));

    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("skips an order it cannot read whole rather than truncating it", async () => {
    // Every follow-up still says there is more, so the page cap is reached.
    const { admin } = fakeAdmin(
      Array.from({ length: 40 }, () => ({ nodes: [line(9)], next: true })),
    );

    const page = await fetchOrdersUpdatedSince(admin, new Date(0));

    expect(page.orders).toHaveLength(0);
    expect(page.oversized).toEqual([
      { shopifyOrderId: "5001", linesRead: 27, updatedAt: NODE.updatedAt },
    ]);
  });
});
