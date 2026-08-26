/**
 * What MetaKocka *should* look like for one Shopify order, right now.
 *
 * The connector is a reconciliation engine, not an event-to-document mapper.
 * That distinction lives here: a webhook is only a nudge to recompute this
 * structure, and every MetaKocka change is generated from it rather than from
 * the payload that triggered the run. So the same order reconciled ten times
 * produces one set of documents, and an event that arrives twice, late, or out
 * of order costs one comparison.
 *
 * The canonical state answers three questions and nothing else:
 *
 *  1. **What does the customer currently take?** — `lines`, at Shopify's
 *     current quantities, after every edit and cancellation.
 *  2. **From where?** — `allocations`, one group per Shopify location, mapped to
 *     the MetaKocka warehouse the existing location mapping already names.
 *  3. **What money has actually moved?** — `financial`, derived from individual
 *     transactions (`domain/payments/transactions`), never from Shopify's
 *     display status.
 *
 * Pure (§5). Building it needs Shopify reads and database reads; those happen in
 * the job, which then hands the values here.
 */

import type {
  OrderTransaction,
  PaymentState,
  PaymentSummary,
} from "~/domain/payments/transactions";

export interface CanonicalLine {
  shopifyLineItemId: string;
  sku: string;
  title: string;
  /** Shopify's *current* quantity, after edits and cancellations. */
  quantity: number;
  unitPriceWithTaxMinor: number;
  discountMinor: number;
  taxFactor: string | null;
}

/** One line's share of one location, as Shopify has assigned it. */
export interface CanonicalAllocationLine {
  shopifyLineItemId: string;
  quantity: number;
}

/**
 * What will become of one quantity (order-reconciliation brief §4).
 *
 * Every Shopify quantity lands in exactly one of these, and the three sum to
 * the line. That total is the point: it is what makes "never silently missing"
 * checkable rather than aspirational, and it is why the reconciler can say of
 * any unit the customer bought whether it is in the ERP, deliberately not in
 * the ERP, or a problem.
 */
export type QuantityDisposition =
  /** Represented in a MetaKocka sales order. */
  | "managed"
  /**
   * Fulfilled through something this app does not manage, and **deliberately
   * not represented in MetaKocka**.
   *
   * Today that means one thing: a fulfilment order held by a third-party or
   * assigned service, which reports a location name and no location id because
   * the app holds only `read_merchant_managed_fulfillment_orders`. The goods
   * never move through a MetaKocka warehouse and there is no mapping that could
   * say which one, so inventing a warehouse would misstate stock in the ERP.
   *
   * This is an explicit business rule, not an omission — and it is never
   * silent: external quantity keeps an order out of `in_sync` and raises an
   * exception naming the service.
   */
  | "external"
  /**
   * Nothing can say where this quantity goes.
   *
   * A Shopify location with no supply source mapped, or quantity the stock
   * rules could not satisfy. Always an error state.
   */
  | "unresolved";

export interface CanonicalAllocation {
  /**
   * The Shopify location this group is fulfilled from, or null for the part of
   * the order Shopify has not assigned to one.
   *
   * Null is common and not an error: digital goods have no fulfilment order,
   * and an app with only merchant-managed fulfilment scopes cannot read a
   * third-party one. The caller decides what to do with it — normally, fall
   * back to the stock allocator for exactly that remainder.
   */
  shopifyLocationId: string | null;
  /** The supply source the location maps to, when there is a mapping. */
  supplySourceId: string | null;
  /** What becomes of these quantities. Never inferred by a reader. */
  disposition: QuantityDisposition;
  /** Shopify's name for the location, which is all a 3PL assignment gives us. */
  locationName?: string | null;
  lines: CanonicalAllocationLine[];
}

export interface LineDisposition {
  shopifyLineItemId: string;
  sku: string;
  title: string;
  /** What Shopify says the customer is buying. */
  quantity: number;
  managed: number;
  external: number;
  /** `quantity - managed - external`, floored at zero, plus any over-assignment. */
  unresolved: number;
}

export interface QuantityClassification {
  lines: LineDisposition[];
  managedTotal: number;
  externalTotal: number;
  unresolvedTotal: number;
  /** True when every unit is either represented or explicitly external. */
  fullyAccounted: boolean;
  /** Lines with quantity nothing can place. The ones that need a person. */
  unresolvedLines: LineDisposition[];
  /** Lines Shopify is fulfilling elsewhere. Reported, not an error. */
  externalLines: LineDisposition[];
}

/**
 * Sorts every Shopify quantity into exactly one disposition.
 *
 * The invariant this exists to make checkable, stated as arithmetic:
 *
 * ```text
 * for every line:  managed + external + unresolved = Shopify quantity
 * ```
 *
 * Anything an allocation does not account for becomes `unresolved` rather than
 * disappearing — that is the whole difference between a connector that reports
 * a gap and one that reports success because a line quietly fell out of its own
 * allocation logic.
 *
 * An *over*-assignment (fulfilment orders describing more than the order
 * contains) is counted into `unresolved` too. It is a Shopify state this app
 * must not average away, and it is equally a reason not to call the order done.
 */
export function classifyQuantities(
  lines: readonly CanonicalLine[],
  allocations: readonly CanonicalAllocation[],
): QuantityClassification {
  const byDisposition = new Map<string, Record<QuantityDisposition, number>>();

  for (const line of lines) {
    byDisposition.set(line.shopifyLineItemId, {
      managed: 0,
      external: 0,
      unresolved: 0,
    });
  }

  for (const allocation of allocations) {
    for (const entry of allocation.lines) {
      const totals = byDisposition.get(entry.shopifyLineItemId);
      // An allocation for a line the order does not hold. Counted nowhere,
      // because there is no Shopify quantity for it to be part of.
      if (!totals) continue;
      totals[allocation.disposition] += entry.quantity;
    }
  }

  const classified: LineDisposition[] = lines.map((line) => {
    const totals = byDisposition.get(line.shopifyLineItemId)!;
    const placed = totals.managed + totals.external;

    return {
      shopifyLineItemId: line.shopifyLineItemId,
      sku: line.sku,
      title: line.title,
      quantity: line.quantity,
      managed: totals.managed,
      external: totals.external,
      // Whatever the allocations called unresolved, plus whatever they did not
      // mention at all, plus the magnitude of any over-assignment.
      unresolved: totals.unresolved + Math.abs(line.quantity - placed - totals.unresolved),
    };
  });

  const sum = (pick: (line: LineDisposition) => number) =>
    classified.reduce((total, line) => total + pick(line), 0);

  const unresolvedTotal = sum((line) => line.unresolved);

  return {
    lines: classified,
    managedTotal: sum((line) => line.managed),
    externalTotal: sum((line) => line.external),
    unresolvedTotal,
    fullyAccounted: unresolvedTotal === 0,
    unresolvedLines: classified.filter((line) => line.unresolved > 0),
    externalLines: classified.filter((line) => line.external > 0),
  };
}

export interface CanonicalFinancialState {
  currency: string;
  /** Shopify's current order total, minor units. */
  totalMinor: number;
  grossReceivedMinor: number;
  refundedMinor: number;
  netPaidMinor: number;
  outstandingMinor: number;
  state: PaymentState;
}

export interface CanonicalOrderState {
  shopifyOrderId: string;
  orderNumber: string;
  /** The reference every sibling document carries (`buyer_order`). */
  reference: string;
  cancelled: boolean;
  lines: CanonicalLine[];
  allocations: CanonicalAllocation[];
  financial: CanonicalFinancialState;
  /** The whole ledger, including the parts that are not settled money. */
  transactions: OrderTransaction[];
}

export function financialStateOf(
  summary: PaymentSummary,
  input: { currency: string; totalMinor: number },
): CanonicalFinancialState {
  return {
    currency: input.currency,
    totalMinor: input.totalMinor,
    grossReceivedMinor: summary.grossReceivedMinor,
    refundedMinor: summary.refundedMinor,
    netPaidMinor: summary.netPaidMinor,
    outstandingMinor: summary.outstandingMinor,
    state: summary.state,
  };
}

/**
 * The quantity each line is assigned across all locations.
 *
 * Not the same thing as the line's quantity, and the difference is the point:
 * where they differ, Shopify has told us less than the whole story and the
 * caller must make up the shortfall rather than shipping a MetaKocka document
 * that is quietly short.
 */
export function assignedQuantities(
  allocations: readonly CanonicalAllocation[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const allocation of allocations) {
    for (const line of allocation.lines) {
      totals.set(
        line.shopifyLineItemId,
        (totals.get(line.shopifyLineItemId) ?? 0) + line.quantity,
      );
    }
  }
  return totals;
}

export interface AllocationShortfall {
  shopifyLineItemId: string;
  sku: string;
  title: string;
  /** Shopify's line quantity. */
  requiredQuantity: number;
  /** What the fulfilment orders accounted for. */
  assignedQuantity: number;
  /** `required - assigned`. Always positive when present. */
  shortfallQuantity: number;
}

/**
 * Lines whose fulfilment assignment does not cover their quantity.
 *
 * Three real causes, all of which the caller handles the same way — allocate
 * the remainder from stock rules:
 *
 *  - a digital or service line, which has no fulfilment order at all;
 *  - a fulfilment order held by a third-party or assigned service the app's
 *    scopes cannot read;
 *  - a fulfilment order that has been closed or cancelled without a
 *    replacement.
 *
 * An *over*-assignment is reported too, as a negative shortfall would be
 * meaningless: it means the fulfilment orders describe more goods than the
 * order contains, which is a Shopify state this app must not average out.
 */
export function allocationShortfalls(
  lines: readonly CanonicalLine[],
  allocations: readonly CanonicalAllocation[],
): { shortfalls: AllocationShortfall[]; overAssigned: AllocationShortfall[] } {
  const assigned = assignedQuantities(allocations);

  const shortfalls: AllocationShortfall[] = [];
  const overAssigned: AllocationShortfall[] = [];

  for (const line of lines) {
    const assignedQuantity = assigned.get(line.shopifyLineItemId) ?? 0;
    if (assignedQuantity === line.quantity) continue;

    const entry: AllocationShortfall = {
      shopifyLineItemId: line.shopifyLineItemId,
      sku: line.sku,
      title: line.title,
      requiredQuantity: line.quantity,
      assignedQuantity,
      shortfallQuantity: line.quantity - assignedQuantity,
    };

    if (entry.shortfallQuantity > 0) shortfalls.push(entry);
    else overAssigned.push(entry);
  }

  return { shortfalls, overAssigned };
}

/**
 * Folds an allocation set down to one group per supply source.
 *
 * Two Shopify locations can map to the same MetaKocka warehouse — a shop floor
 * and its stockroom, counted together in the ERP — and MetaKocka's warehouse is
 * document-level (§3), so those must become *one* document with the quantities
 * added, not two documents racing for the same `count_code`.
 *
 * Groups with no supply source are returned separately rather than merged into
 * a null bucket, because "Shopify says location X and nothing maps X" is a
 * merchant configuration problem with a specific fix, and it must not silently
 * become "unallocated".
 */
export function groupBySupplySource(
  allocations: readonly CanonicalAllocation[],
): {
  bySource: Map<string, CanonicalAllocationLine[]>;
  unmappedLocations: { shopifyLocationId: string; lines: CanonicalAllocationLine[] }[];
  unassigned: CanonicalAllocationLine[];
} {
  const bySource = new Map<string, CanonicalAllocationLine[]>();
  const unmapped = new Map<string, CanonicalAllocationLine[]>();
  const unassigned: CanonicalAllocationLine[] = [];

  const add = (target: CanonicalAllocationLine[], line: CanonicalAllocationLine) => {
    const existing = target.find(
      (entry) => entry.shopifyLineItemId === line.shopifyLineItemId,
    );
    if (existing) existing.quantity += line.quantity;
    else target.push({ ...line });
  };

  for (const allocation of allocations) {
    for (const line of allocation.lines) {
      if (line.quantity <= 0) continue;

      if (allocation.supplySourceId) {
        const target = bySource.get(allocation.supplySourceId) ?? [];
        add(target, line);
        bySource.set(allocation.supplySourceId, target);
        continue;
      }

      if (allocation.shopifyLocationId) {
        const target = unmapped.get(allocation.shopifyLocationId) ?? [];
        add(target, line);
        unmapped.set(allocation.shopifyLocationId, target);
        continue;
      }

      add(unassigned, line);
    }
  }

  return {
    bySource,
    unmappedLocations: [...unmapped.entries()].map(
      ([shopifyLocationId, lines]) => ({ shopifyLocationId, lines }),
    ),
    unassigned,
  };
}
