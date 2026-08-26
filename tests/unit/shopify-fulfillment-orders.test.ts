import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { describe, expect, it, vi } from "vitest";

import { fetchFulfillmentAssignments } from "~/adapters/shopify/fulfillment-orders";

/**
 * Reading where Shopify says each part of an order ships from (brief §2, §7).
 *
 * This is the input the connector was missing entirely, so the tests are about
 * what the adapter must never do with it:
 *
 *  - never count a cancelled fulfilment order, whose quantities have been
 *    superseded by whatever replaced it — counting both doubles every moved
 *    line, which is the exact duplication the connector exists to prevent;
 *  - never split one location into two entries, because MetaKocka's warehouse
 *    is document-level and two entries would race for one `count_code`;
 *  - never silently swallow a location it cannot resolve.
 */

function fakeAdmin(pages: unknown[]) {
  let call = 0;
  const graphql = vi.fn(async () => {
    const body = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { admin: { graphql } as unknown as AdminApiContext, graphql };
}

function page(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  },
) {
  return { data: { order: { fulfillmentOrders: { pageInfo, nodes } } } };
}

function fulfillmentOrder(input: {
  id: string;
  status?: string;
  locationId?: string | null;
  locationName?: string | null;
  lines: { lineItemId: string; quantity: number }[];
}) {
  return {
    id: `gid://shopify/FulfillmentOrder/${input.id}`,
    status: input.status ?? "OPEN",
    assignedLocation: {
      name: input.locationName ?? "Main warehouse",
      location:
        input.locationId === null
          ? null
          : { id: `gid://shopify/Location/${input.locationId ?? "1"}` },
    },
    lineItems: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: input.lines.map((line, index) => ({
        id: `gid://shopify/FulfillmentOrderLineItem/${input.id}-${index}`,
        totalQuantity: line.quantity,
        lineItem: { id: `gid://shopify/LineItem/${line.lineItemId}` },
      })),
    },
  };
}

describe("reading fulfilment assignments", () => {
  it("returns one entry per location with numeric ids", () => {
    return (async () => {
      const { admin } = fakeAdmin([
        page([
          fulfillmentOrder({
            id: "fo1",
            locationId: "10",
            lines: [
              { lineItemId: "l1", quantity: 2 },
              { lineItemId: "l2", quantity: 1 },
            ],
          }),
          fulfillmentOrder({
            id: "fo2",
            locationId: "20",
            locationName: "Shop floor",
            lines: [{ lineItemId: "l3", quantity: 3 }],
          }),
        ]),
      ]);

      const result = await fetchFulfillmentAssignments(admin, "5551234567890");

      expect(result.assignments).toEqual([
        {
          shopifyLocationId: "10",
          locationName: "Main warehouse",
          lines: [
            { shopifyLineItemId: "l1", quantity: 2 },
            { shopifyLineItemId: "l2", quantity: 1 },
          ],
        },
        {
          shopifyLocationId: "20",
          locationName: "Shop floor",
          lines: [{ shopifyLineItemId: "l3", quantity: 3 }],
        },
      ]);
      expect(result.hasUnreadableLocation).toBe(false);
    })();
  });

  it("folds several fulfilment orders for one location into one entry", async () => {
    /*
     * Shopify splits a location's work as things ship: half an order sent from
     * the main warehouse leaves one closed fulfilment order and one open one,
     * both for the same place. Two entries would become two MetaKocka
     * documents racing for the same count_code.
     */
    const { admin } = fakeAdmin([
      page([
        fulfillmentOrder({
          id: "fo1",
          status: "CLOSED",
          locationId: "10",
          lines: [{ lineItemId: "l1", quantity: 2 }],
        }),
        fulfillmentOrder({
          id: "fo2",
          status: "OPEN",
          locationId: "10",
          lines: [{ lineItemId: "l1", quantity: 3 }],
        }),
      ]),
    ]);

    const result = await fetchFulfillmentAssignments(admin, "1");

    expect(result.assignments).toHaveLength(1);
    // Five, not two: the shipped half is still where those goods came from.
    expect(result.assignments[0]?.lines).toEqual([
      { shopifyLineItemId: "l1", quantity: 5 },
    ]);
  });

  it("ignores a cancelled fulfilment order", async () => {
    const { admin } = fakeAdmin([
      page([
        fulfillmentOrder({
          id: "old",
          status: "CANCELLED",
          locationId: "10",
          lines: [{ lineItemId: "l1", quantity: 2 }],
        }),
        fulfillmentOrder({
          id: "new",
          status: "OPEN",
          locationId: "20",
          lines: [{ lineItemId: "l1", quantity: 2 }],
        }),
      ]),
    ]);

    const result = await fetchFulfillmentAssignments(admin, "1");

    // Exactly the move case: two units at location 20, none left at 10.
    expect(result.assignments).toEqual([
      {
        shopifyLocationId: "20",
        locationName: "Main warehouse",
        lines: [{ shopifyLineItemId: "l1", quantity: 2 }],
      },
    ]);
  });

  it("ignores an incomplete fulfilment order", async () => {
    const { admin } = fakeAdmin([
      page([
        fulfillmentOrder({
          id: "fo1",
          status: "INCOMPLETE",
          locationId: "10",
          lines: [{ lineItemId: "l1", quantity: 2 }],
        }),
      ]),
    ]);

    expect((await fetchFulfillmentAssignments(admin, "1")).assignments).toEqual(
      [],
    );
  });

  it("reports a location it cannot resolve instead of hiding it", async () => {
    // A third-party fulfilment service, which this app's scopes cannot read.
    const { admin } = fakeAdmin([
      page([
        fulfillmentOrder({
          id: "fo1",
          locationId: null,
          locationName: "Some 3PL",
          lines: [{ lineItemId: "l1", quantity: 1 }],
        }),
      ]),
    ]);

    const result = await fetchFulfillmentAssignments(admin, "1");

    expect(result.hasUnreadableLocation).toBe(true);
    expect(result.assignments[0]).toMatchObject({
      shopifyLocationId: null,
      locationName: "Some 3PL",
    });
  });

  it("skips a fulfilment line with no order line behind it", async () => {
    const { admin } = fakeAdmin([
      page([
        {
          id: "gid://shopify/FulfillmentOrder/fo1",
          status: "OPEN",
          assignedLocation: {
            name: "Main",
            location: { id: "gid://shopify/Location/10" },
          },
          lineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "gid://shopify/FulfillmentOrderLineItem/x",
                totalQuantity: 2,
                lineItem: null,
              },
            ],
          },
        },
      ]),
    ]);

    expect((await fetchFulfillmentAssignments(admin, "1")).assignments).toEqual(
      [],
    );
  });

  it("returns nothing for an order Shopify has no fulfilment orders for", async () => {
    // A fully digital order. Real, and not an error: the caller falls back to
    // stock rules for exactly those lines.
    const { admin } = fakeAdmin([{ data: { order: null } }]);
    const result = await fetchFulfillmentAssignments(admin, "1");
    expect(result.assignments).toEqual([]);
  });

  it("follows pagination across fulfilment-order pages", async () => {
    const { admin, graphql } = fakeAdmin([
      page(
        [
          fulfillmentOrder({
            id: "fo1",
            locationId: "10",
            lines: [{ lineItemId: "l1", quantity: 1 }],
          }),
        ],
        { hasNextPage: true, endCursor: "cursor-1" },
      ),
      page([
        fulfillmentOrder({
          id: "fo2",
          locationId: "20",
          lines: [{ lineItemId: "l2", quantity: 1 }],
        }),
      ]),
    ]);

    const result = await fetchFulfillmentAssignments(admin, "1");

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(result.assignments.map((a) => a.shopifyLocationId)).toEqual([
      "10",
      "20",
    ]);
  });
});
