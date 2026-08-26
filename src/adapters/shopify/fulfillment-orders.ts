import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import { numericId } from "~/adapters/shopify/orders";

/**
 * Where Shopify says each part of an order is being fulfilled from
 * (CLAUDE.md §8.2, §8.3).
 *
 * This is the input the connector was missing. Allocation used to be decided
 * entirely from cached stock levels, which is correct for an order nobody has
 * touched and wrong the moment a merchant moves a line to another location in
 * the Shopify admin: the ERP went on describing the warehouse this app had
 * chosen, and no amount of reconciliation could notice, because nothing ever
 * asked Shopify where the goods were coming from.
 *
 * A fulfilment order is Shopify's own answer to that question. One order has
 * one per assigned location, each holding the line quantities that location is
 * responsible for, and Shopify re-splits them itself when a merchant moves
 * items about. Reading them turns "which warehouse" from a guess into a fact.
 *
 * Three things about the shape matter downstream:
 *
 *  - **`assignedLocation.location` can be null.** A fulfilment order held by a
 *    third-party service, or one this app's scopes cannot see, reports a
 *    location name without an id. Those are returned with a null id rather than
 *    dropped, so the caller can say "Shopify assigned this elsewhere" instead
 *    of quietly under-allocating.
 *  - **Cancelled fulfilment orders are excluded.** Their quantities have been
 *    superseded by whichever fulfilment order replaced them, and counting both
 *    would double every moved line — the exact duplication this app exists to
 *    prevent.
 *  - **`totalQuantity`, not `remainingQuantity`.** A fulfilled fulfilment order
 *    has nothing remaining and is still where those goods came from. Reading
 *    the remainder would make a shipped order look unallocated.
 *
 * Requires `read_merchant_managed_fulfillment_orders`, which the app already
 * holds. Assigned and third-party fulfilment orders need scopes it does not,
 * and that limitation is visible in the result rather than hidden.
 */

/**
 * One page of fulfilment orders, and one of line items inside each.
 *
 * The nested page is the expensive one: Shopify's calculated cost multiplies
 * the two, and an order with many locations and many lines is a query it
 * throttles rather than answers.
 */
const FULFILLMENT_ORDER_PAGE = 50;
const FULFILLMENT_LINE_PAGE = 100;

const FULFILLMENT_ORDER_FIELDS = `#graphql
  id
  status
  assignedLocation {
    name
    location { id }
  }
  lineItems(first: ${FULFILLMENT_LINE_PAGE}) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      totalQuantity
      lineItem { id }
    }
  }
`;

const FULFILLMENT_ORDERS_QUERY = `#graphql
  query OrchestratorFulfillmentOrders($id: ID!, $cursor: String) {
    order(id: $id) {
      fulfillmentOrders(first: ${FULFILLMENT_ORDER_PAGE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ${FULFILLMENT_ORDER_FIELDS} }
      }
    }
  }
`;

const FULFILLMENT_ORDER_LINES_QUERY = `#graphql
  query OrchestratorFulfillmentOrderLines($id: ID!, $cursor: String) {
    fulfillmentOrder(id: $id) {
      lineItems(first: ${FULFILLMENT_LINE_PAGE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          totalQuantity
          lineItem { id }
        }
      }
    }
  }
`;

const pageInfo = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullish(),
});

const fulfillmentLineNode = z.object({
  id: z.string(),
  totalQuantity: z.number(),
  lineItem: z.object({ id: z.string() }).nullish(),
});

const fulfillmentOrderNode = z.object({
  id: z.string(),
  status: z.string(),
  assignedLocation: z
    .object({
      name: z.string().nullish(),
      location: z.object({ id: z.string() }).nullish(),
    })
    .nullish(),
  lineItems: z.object({
    pageInfo: pageInfo.nullish(),
    nodes: z.array(fulfillmentLineNode),
  }),
});

const fulfillmentOrdersSchema = z.object({
  data: z.object({
    order: z
      .object({
        fulfillmentOrders: z.object({
          pageInfo,
          nodes: z.array(fulfillmentOrderNode),
        }),
      })
      .nullable(),
  }),
});

const fulfillmentLinesPageSchema = z.object({
  data: z.object({
    fulfillmentOrder: z
      .object({
        lineItems: z.object({
          pageInfo,
          nodes: z.array(fulfillmentLineNode),
        }),
      })
      .nullable(),
  }),
});

/**
 * The statuses whose quantities no longer describe the order.
 *
 * `CANCELLED` is superseded by whatever replaced it. `INCOMPLETE` is a
 * fulfilment order Shopify could not finish creating, and its quantities are
 * not a commitment to anything.
 */
const IGNORED_STATUSES = new Set(["CANCELLED", "INCOMPLETE"]);

export interface FulfillmentAssignmentLine {
  shopifyLineItemId: string;
  quantity: number;
}

export interface FulfillmentAssignment {
  /** Null when Shopify names a location this app is not allowed to resolve. */
  shopifyLocationId: string | null;
  locationName: string | null;
  lines: FulfillmentAssignmentLine[];
}

export interface FulfillmentAssignmentResult {
  assignments: FulfillmentAssignment[];
  /**
   * True when at least one fulfilment order named a location without an id.
   *
   * The caller reports this rather than treating the gap as "no location":
   * telling a merchant "Shopify is fulfilling part of this order from a service
   * this app cannot see" is useful, and silently allocating those lines from
   * stock rules is how the ERP ends up describing the wrong warehouse.
   */
  hasUnreadableLocation: boolean;
}

/** Guards a pathological order from holding the worker indefinitely. */
const MAX_PAGES = 20;

async function allLineItems(
  admin: AdminApiContext,
  node: z.infer<typeof fulfillmentOrderNode>,
): Promise<z.infer<typeof fulfillmentLineNode>[]> {
  const nodes = [...node.lineItems.nodes];
  if (!node.lineItems.pageInfo?.hasNextPage) return nodes;

  let cursor = node.lineItems.pageInfo.endCursor ?? null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await admin.graphql(FULFILLMENT_ORDER_LINES_QUERY, {
      variables: { id: node.id, cursor },
    });
    const parsed = fulfillmentLinesPageSchema.parse(await response.json());
    const lineItems = parsed.data.fulfillmentOrder?.lineItems;
    if (!lineItems) break;

    nodes.push(...lineItems.nodes);
    if (!lineItems.pageInfo.hasNextPage) break;
    cursor = lineItems.pageInfo.endCursor ?? null;
  }

  return nodes;
}

/**
 * Every location assignment on one order, folded to one entry per location.
 *
 * Folded because Shopify splits a location's work into several fulfilment
 * orders as things are shipped — an order half sent from the main warehouse has
 * one closed fulfilment order and one open one, both for the same place — and
 * the ERP has one document per warehouse (§3). Two entries for one location
 * would race for the same `count_code`.
 *
 * Returns an empty list when the order has no fulfilment orders at all, which
 * is a real state (a fully digital order) and not an error.
 */
export async function fetchFulfillmentAssignments(
  admin: AdminApiContext,
  shopifyOrderId: string,
): Promise<FulfillmentAssignmentResult> {
  const byLocation = new Map<string, FulfillmentAssignment>();
  let hasUnreadableLocation = false;
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await admin.graphql(FULFILLMENT_ORDERS_QUERY, {
      variables: { id: `gid://shopify/Order/${shopifyOrderId}`, cursor },
    });

    const parsed = fulfillmentOrdersSchema.parse(await response.json());
    const orders = parsed.data.order?.fulfillmentOrders;
    if (!orders) break;

    for (const node of orders.nodes) {
      if (IGNORED_STATUSES.has(node.status.toUpperCase())) continue;

      const locationGid = node.assignedLocation?.location?.id ?? null;
      const shopifyLocationId = locationGid ? numericId(locationGid) : null;
      if (!shopifyLocationId) hasUnreadableLocation = true;

      // Keyed by id where there is one, by name otherwise, so two unreadable
      // services do not collapse into each other.
      const key =
        shopifyLocationId ?? `name:${node.assignedLocation?.name ?? "unknown"}`;

      const assignment = byLocation.get(key) ?? {
        shopifyLocationId,
        locationName: node.assignedLocation?.name ?? null,
        lines: [],
      };

      for (const line of await allLineItems(admin, node)) {
        const lineItemGid = line.lineItem?.id;
        // A fulfilment order line with no order line behind it is not something
        // this app can reconcile against an order line, so it is skipped rather
        // than guessed at.
        if (!lineItemGid) continue;
        if (line.totalQuantity <= 0) continue;

        const shopifyLineItemId = numericId(lineItemGid);
        const existing = assignment.lines.find(
          (entry) => entry.shopifyLineItemId === shopifyLineItemId,
        );
        if (existing) existing.quantity += line.totalQuantity;
        else
          assignment.lines.push({
            shopifyLineItemId,
            quantity: line.totalQuantity,
          });
      }

      byLocation.set(key, assignment);
    }

    if (!orders.pageInfo.hasNextPage) break;
    cursor = orders.pageInfo.endCursor ?? null;
  }

  return {
    // Sorted so a plan built from this is deterministic run to run.
    assignments: [...byLocation.values()]
      .filter((assignment) => assignment.lines.length > 0)
      .sort((a, b) =>
        (a.shopifyLocationId ?? "") < (b.shopifyLocationId ?? "")
          ? -1
          : (a.shopifyLocationId ?? "") > (b.shopifyLocationId ?? "")
            ? 1
            : 0,
      ),
    hasUnreadableLocation,
  };
}
