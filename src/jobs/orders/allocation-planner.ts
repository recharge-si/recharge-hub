import { prisma } from "~/adapters/db/client.server";
import type { AllocationRecord } from "~/adapters/db/repositories/order.server";
import type { FulfillmentAssignment } from "~/adapters/shopify/fulfillment-orders";
import { locationKey } from "~/adapters/shopify/locations";
import { allocate } from "~/domain/allocation/allocate";
import {
  DEFAULT_RULE,
  type AllocationLine,
  type SupplyLevel,
} from "~/domain/allocation/types";
import type {
  CanonicalAllocation,
  CanonicalLine,
  QuantityClassification,
  QuantityDisposition,
} from "~/domain/orders/canonical";
import {
  allocationShortfalls,
  classifyQuantities,
} from "~/domain/orders/canonical";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * Deciding which MetaKocka warehouse each part of an order comes from
 * (CLAUDE.md §8.2, and the order-reconciliation brief §2, §7, §8).
 *
 * There are two possible authorities and the app now uses both, in a fixed
 * order of precedence:
 *
 *  1. **Shopify's fulfilment orders.** When a merchant assigns a line to a
 *     location — by editing the order, by moving a fulfilment order, by letting
 *     Shopify route it — they have said where it ships from. The ERP should
 *     agree, and before this it could not: allocation read cached stock and
 *     nothing else, so a line moved in the Shopify admin never reached
 *     MetaKocka at all.
 *  2. **This app's stock rules**, for whatever Shopify has not assigned. That
 *     is a real and common remainder — a digital line has no fulfilment order,
 *     and a third-party one is invisible to this app's scopes — and leaving it
 *     unallocated would send MetaKocka a document short of goods the customer
 *     bought.
 *
 * The mapping between the two worlds is the existing
 * `supply_source.shopify_location_id`, unchanged and reused. This module does
 * not redesign warehouse mapping; it reads it.
 */

export interface AllocationPlan {
  /** The rows to persist, one per line-and-source pair. */
  records: AllocationRecord[];
  /** The canonical view of the same decision, for the audit trail. */
  allocations: CanonicalAllocation[];
  /** Lines Shopify assigned to a location with no supply source. */
  unmappedLocations: { shopifyLocationId: string; locationName: string | null }[];
  /**
   * Fulfilment services this app is not allowed to resolve.
   *
   * Named rather than counted, because "Shopify is shipping part of this order
   * through Acme 3PL" is something a merchant can act on and "part of this
   * order could not be allocated" is not.
   */
  externalLocations: { locationName: string | null }[];
  /** What the stock rules could not satisfy either. */
  shortfalls: { sku: string; quantity: number }[];
  /** True when at least one line's warehouse came from Shopify. */
  usedShopifyAssignment: boolean;
  /**
   * Every Shopify quantity, sorted into managed / external / unresolved.
   *
   * The answer to "for every unit the customer bought, where is it?" — which
   * the verification pass consumes so that an order can never report itself
   * clean because a line fell out of the allocation logic.
   */
  classification: QuantityClassification;
}

interface LineRef {
  orderLineId: string;
  shopifyLineItemId: string;
  sku: string;
  title: string;
  quantity: number;
}

/**
 * Builds the whole plan.
 *
 * `mode` is the merchant's setting. `stock_rules` skips step 1 entirely and
 * reproduces exactly what this app did before fulfilment orders were read,
 * which is the escape hatch for a shop whose Shopify locations do not
 * correspond to how they actually warehouse things.
 */
export async function planAllocations(
  principal: Principal,
  input: {
    orderId: string;
    lines: LineRef[];
    canonicalLines: CanonicalLine[];
    assignments: FulfillmentAssignment[];
    mode: "shopify_locations" | "stock_rules";
  },
): Promise<AllocationPlan> {
  const byShopifyLineId = new Map(
    input.lines.map((line) => [line.shopifyLineItemId, line] as const),
  );

  const sources = await prisma.supplySource.findMany({
    where: { shop: { domain: shopDomainOf(principal) }, enabled: true },
    select: {
      id: true,
      code: true,
      kind: true,
      priority: true,
      canSplit: true,
      enabled: true,
      shopifyLocationId: true,
    },
  });
  /*
   * Keyed by the normalised location, not by the stored string.
   *
   * The settings screen saves a full GID and the fulfilment reader emits the
   * numeric tail, so a direct lookup misses every time — see `locationKey`.
   */
  const sourceByLocation = new Map(
    sources
      .flatMap((source) => {
        const key = locationKey(source.shopifyLocationId);
        return key ? [[key, source] as const] : [];
      }),
  );

  const records: AllocationRecord[] = [];
  const allocations: CanonicalAllocation[] = [];
  const unmappedLocations: AllocationPlan["unmappedLocations"] = [];
  const externalLocations: AllocationPlan["externalLocations"] = [];

  /* ---------------------------------------------------------------------- */
  /* 1. What Shopify has already decided                                    */
  /* ---------------------------------------------------------------------- */

  /** How much of each line Shopify's assignment has accounted for. */
  const assignedByLine = new Map<string, number>();

  if (input.mode === "shopify_locations") {
    for (const assignment of input.assignments) {
      const source = assignment.shopifyLocationId
        ? (sourceByLocation.get(locationKey(assignment.shopifyLocationId)!) ??
          null)
        : null;

      if (assignment.shopifyLocationId && !source) {
        unmappedLocations.push({
          shopifyLocationId: assignment.shopifyLocationId,
          locationName: assignment.locationName,
        });
      }

      /*
       * Which of the three this quantity is, decided once and recorded.
       *
       * A location with **no id at all** is a fulfilment order held by a
       * third-party or assigned service: this app holds only
       * `read_merchant_managed_fulfillment_orders`, so Shopify names the
       * service and withholds the id. Those goods never move through a
       * MetaKocka warehouse and no mapping could say which one, so they are
       * `external` — explicitly not represented, rather than allocated to a
       * warehouse by guesswork, which would misstate the ERP's stock.
       *
       * A location with an id that nothing maps is different in kind: the
       * merchant *can* fix it, on the supply sources page, so it is
       * `unresolved` and says so.
       */
      const disposition: QuantityDisposition = source
        ? "managed"
        : assignment.shopifyLocationId === null
          ? "external"
          : "unresolved";

      if (disposition === "external") {
        externalLocations.push({ locationName: assignment.locationName });
      }

      const canonical: CanonicalAllocation = {
        shopifyLocationId: assignment.shopifyLocationId,
        supplySourceId: source?.id ?? null,
        disposition,
        locationName: assignment.locationName,
        lines: [],
      };

      for (const line of assignment.lines) {
        const known = byShopifyLineId.get(line.shopifyLineItemId);
        // A fulfilment order for a line this app does not hold. Skipped rather
        // than invented: the order's lines come from the order, and a
        // fulfilment order that names something else is a Shopify state the
        // reconciler will see again on its next pass.
        if (!known) continue;

        /*
         * Never assign more of a line than the order contains.
         *
         * Shopify's fulfilment orders normally sum to the line quantity
         * exactly, but a cancelled-and-replaced fulfilment order read at the
         * wrong moment can briefly overlap. Capping here is what stops that
         * transient becoming a MetaKocka document for goods nobody ordered —
         * and the shortfall/over-assignment report below still tells the
         * merchant what was seen.
         */
        const alreadyAssigned = assignedByLine.get(line.shopifyLineItemId) ?? 0;
        const room = Math.max(0, known.quantity - alreadyAssigned);
        const quantity = Math.min(line.quantity, room);
        if (quantity <= 0) continue;

        assignedByLine.set(
          line.shopifyLineItemId,
          alreadyAssigned + quantity,
        );

        canonical.lines.push({
          shopifyLineItemId: line.shopifyLineItemId,
          quantity,
        });

        records.push({
          orderLineId: known.orderLineId,
          supplySourceId: source?.id ?? null,
          quantity,
          source: "shopify",
          shopifyLocationId: assignment.shopifyLocationId,
          reason: {
            rule: "shopify-fulfilment-order",
            locationId: assignment.shopifyLocationId,
            locationName: assignment.locationName,
            disposition,
          },
        });
      }

      if (canonical.lines.length > 0) allocations.push(canonical);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 2. Whatever Shopify did not account for                                */
  /* ---------------------------------------------------------------------- */

  const remaining = input.lines
    .map((line) => ({
      line,
      quantity:
        line.quantity - (assignedByLine.get(line.shopifyLineItemId) ?? 0),
    }))
    .filter((entry) => entry.quantity > 0);

  const shortfalls: AllocationPlan["shortfalls"] = [];

  if (remaining.length > 0) {
    const allocationLines: AllocationLine[] = remaining.map((entry) => ({
      lineId: entry.line.orderLineId,
      sku: entry.line.sku,
      quantity: entry.quantity,
    }));

    const skus = [
      ...new Set(allocationLines.map((line) => line.sku).filter(Boolean)),
    ];

    // Stock as this app last observed it (§2.5, §3): reading MetaKocka here
    // would put a call that can take tens of seconds inside an allocation.
    const levels = await prisma.supplyLevel.findMany({
      where: {
        sku: { sku: { in: skus }, shop: { domain: shopDomainOf(principal) } },
        supplySource: { enabled: true },
      },
      include: { supplySource: true, sku: true },
    });

    const supply: SupplyLevel[] = levels.map((level) => ({
      sourceId: level.supplySourceId,
      sourceCode: level.supplySource.code,
      sku: level.sku.sku,
      available: Math.max(0, level.quantity - level.reserved),
      kind: level.supplySource.kind,
      priority: level.supplySource.priority,
      canSplit: level.supplySource.canSplit,
      enabled: level.supplySource.enabled,
    }));

    const result = allocate({
      lines: allocationLines,
      supply,
      rules: [DEFAULT_RULE],
      now: new Date(),
    });

    const lineById = new Map(
      input.lines.map((line) => [line.orderLineId, line] as const),
    );
    const locationBySource = new Map(
      sources.map((source) => [source.id, source.shopifyLocationId] as const),
    );

    for (const allocation of result.allocations) {
      const known = lineById.get(allocation.lineId);
      if (!known) continue;

      records.push({
        orderLineId: allocation.lineId,
        supplySourceId: allocation.sourceId,
        quantity: allocation.quantity,
        source: "rules",
        shopifyLocationId: allocation.sourceId
          ? (locationBySource.get(allocation.sourceId) ?? null)
          : null,
        reason: allocation.reason,
      });

      const locationId = allocation.sourceId
        ? (locationBySource.get(allocation.sourceId) ?? null)
        : null;

      const existing = allocations.find(
        (entry) =>
          entry.supplySourceId === allocation.sourceId &&
          entry.shopifyLocationId === locationId,
      );
      const target: CanonicalAllocation =
        existing ??
        {
          shopifyLocationId: locationId,
          supplySourceId: allocation.sourceId,
          disposition: allocation.sourceId ? "managed" : "unresolved",
          lines: [],
        };
      if (!existing) allocations.push(target);

      const line = target.lines.find(
        (entry) => entry.shopifyLineItemId === known.shopifyLineItemId,
      );
      if (line) line.quantity += allocation.quantity;
      else
        target.lines.push({
          shopifyLineItemId: known.shopifyLineItemId,
          quantity: allocation.quantity,
        });
    }

    /*
     * Stock could not satisfy the rest.
     *
     * Recorded as an `unresolved` allocation with no source, so the
     * classification adds up rather than the quantity simply vanishing from
     * every bucket. Nothing is written to MetaKocka for it either way; the
     * difference is whether the order can report itself clean, and it cannot.
     */
    for (const shortfall of result.shortfalls) {
      const known = input.lines.find((line) => line.sku === shortfall.sku);
      if (!known) continue;

      allocations.push({
        shopifyLocationId: null,
        supplySourceId: null,
        disposition: "unresolved",
        lines: [
          {
            shopifyLineItemId: known.shopifyLineItemId,
            quantity: shortfall.quantity,
          },
        ],
      });
    }

    shortfalls.push(
      ...result.shortfalls.map((shortfall) => ({
        sku: shortfall.sku,
        quantity: shortfall.quantity,
      })),
    );
  }

  return {
    records,
    allocations,
    unmappedLocations,
    externalLocations,
    shortfalls,
    usedShopifyAssignment: assignedByLine.size > 0,
    classification: classifyQuantities(input.canonicalLines, allocations),
  };
}

/**
 * Whether the plan actually covers the order.
 *
 * Re-uses the canonical check rather than counting again, so the "did we
 * allocate everything" question has exactly one implementation. A plan that
 * does not cover the order is not written to MetaKocka as if it did: the
 * shortfall becomes an exception and the part that *is* covered still goes out,
 * which is the existing behaviour and the right one.
 */
export function planCoverage(
  lines: CanonicalLine[],
  plan: AllocationPlan,
): ReturnType<typeof allocationShortfalls> {
  return allocationShortfalls(lines, plan.allocations);
}
