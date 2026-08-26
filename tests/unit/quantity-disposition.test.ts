import { describe, expect, it } from "vitest";

import {
  classifyQuantities,
  type CanonicalAllocation,
  type CanonicalLine,
} from "~/domain/orders/canonical";

/**
 * Every Shopify quantity is accounted for, or the order is not clean
 * (verification pass §4).
 *
 * The requirement, stated as the question the connector must always be able to
 * answer for any unit the customer bought:
 *
 * ```text
 * represented in MetaKocka
 *   OR explicitly fulfilled outside it
 *   OR unresolved / an error
 * ```
 *
 * Never silently missing. The failure this rules out is the subtle one: a line
 * that falls out of the allocation logic — an unmapped location, a fulfilment
 * service the app's scopes cannot read — leaves the documents internally
 * consistent, so a verification comparing only documents against documents
 * would call the order perfect while the customer's goods were nowhere.
 */

function line(sku: string, quantity: number): CanonicalLine {
  return {
    shopifyLineItemId: `l-${sku}`,
    sku,
    title: sku,
    quantity,
    unitPriceWithTaxMinor: 10_000,
    discountMinor: 0,
    taxFactor: "0.22",
  };
}

function at(
  disposition: CanonicalAllocation["disposition"],
  sku: string,
  quantity: number,
  locationId: string | null = "loc-a",
): CanonicalAllocation {
  return {
    shopifyLocationId: locationId,
    supplySourceId: disposition === "managed" ? "src-a" : null,
    disposition,
    lines: [{ shopifyLineItemId: `l-${sku}`, quantity }],
  };
}

describe("the three dispositions", () => {
  it("calls a mapped location's quantity managed", () => {
    const result = classifyQuantities(
      [line("SKU-A", 3)],
      [at("managed", "SKU-A", 3)],
    );

    expect(result.managedTotal).toBe(3);
    expect(result.externalTotal).toBe(0);
    expect(result.unresolvedTotal).toBe(0);
    expect(result.fullyAccounted).toBe(true);
  });

  it("calls a third-party fulfilment's quantity external, not missing", () => {
    /*
     * The T-19 case. Shopify reports a service name and no location id, because
     * the app holds only `read_merchant_managed_fulfillment_orders`. Those
     * goods never pass through a MetaKocka warehouse, so they are deliberately
     * not represented — and saying so explicitly is the difference between a
     * business rule and a bug.
     */
    const result = classifyQuantities(
      [line("SKU-A", 3)],
      [at("external", "SKU-A", 3, null)],
    );

    expect(result.externalTotal).toBe(3);
    expect(result.managedTotal).toBe(0);
    // Not an error: it is accounted for, just not in the ERP.
    expect(result.unresolvedTotal).toBe(0);
    expect(result.fullyAccounted).toBe(true);
    expect(result.externalLines).toHaveLength(1);
  });

  it("calls an unmapped Shopify location's quantity unresolved", () => {
    // Different in kind from external: the merchant *can* fix this, by mapping
    // the location, so it is an error rather than a rule.
    const result = classifyQuantities(
      [line("SKU-A", 3)],
      [at("unresolved", "SKU-A", 3, "loc-z")],
    );

    expect(result.unresolvedTotal).toBe(3);
    expect(result.fullyAccounted).toBe(false);
    expect(result.unresolvedLines[0]).toMatchObject({ sku: "SKU-A", unresolved: 3 });
  });
});

describe("the accounting identity", () => {
  it("splits one line across all three", () => {
    const result = classifyQuantities(
      [line("SKU-A", 6)],
      [
        at("managed", "SKU-A", 3),
        at("external", "SKU-A", 2, null),
        at("unresolved", "SKU-A", 1, "loc-z"),
      ],
    );

    expect(result.managedTotal).toBe(3);
    expect(result.externalTotal).toBe(2);
    expect(result.unresolvedTotal).toBe(1);

    const only = result.lines[0]!;
    // The identity: nothing is double counted and nothing is lost.
    expect(only.managed + only.external + only.unresolved).toBe(only.quantity);
  });

  it("counts quantity no allocation mentions at all as unresolved", () => {
    /*
     * The one that matters most. A line that quietly drops out of the
     * allocation must not vanish from the arithmetic — an order can never be
     * reported clean because the connector forgot about a unit.
     */
    const result = classifyQuantities([line("SKU-A", 5)], []);

    expect(result.unresolvedTotal).toBe(5);
    expect(result.fullyAccounted).toBe(false);
    expect(result.lines[0]).toMatchObject({
      quantity: 5,
      managed: 0,
      external: 0,
      unresolved: 5,
    });
  });

  it("counts a partly allocated line's remainder as unresolved", () => {
    const result = classifyQuantities(
      [line("SKU-A", 5)],
      [at("managed", "SKU-A", 2)],
    );

    expect(result.managedTotal).toBe(2);
    expect(result.unresolvedTotal).toBe(3);
    expect(result.fullyAccounted).toBe(false);
  });

  it("counts an over-assignment as unresolved rather than averaging it away", () => {
    // Fulfilment orders describing more than the order contains is a Shopify
    // state, and equally a reason not to call the order done.
    const result = classifyQuantities(
      [line("SKU-A", 2)],
      [at("managed", "SKU-A", 5)],
    );

    expect(result.managedTotal).toBe(5);
    expect(result.unresolvedTotal).toBe(3);
    expect(result.fullyAccounted).toBe(false);
  });

  it("ignores an allocation for a line the order does not hold", () => {
    // A fulfilment order naming something else. It cannot be part of any
    // Shopify quantity, so it is counted into none of them.
    const result = classifyQuantities(
      [line("SKU-A", 2)],
      [at("managed", "SKU-A", 2), at("managed", "SKU-GHOST", 9)],
    );

    expect(result.managedTotal).toBe(2);
    expect(result.fullyAccounted).toBe(true);
  });

  it("holds the identity across several lines", () => {
    const lines = [line("SKU-A", 4), line("SKU-B", 1), line("SKU-C", 7)];
    const result = classifyQuantities(lines, [
      at("managed", "SKU-A", 4),
      at("external", "SKU-B", 1, null),
      at("managed", "SKU-C", 5),
      at("unresolved", "SKU-C", 2, "loc-z"),
    ]);

    for (const entry of result.lines) {
      expect(entry.managed + entry.external + entry.unresolved).toBe(
        entry.quantity,
      );
    }
    expect(result.managedTotal + result.externalTotal + result.unresolvedTotal).toBe(
      12,
    );
  });
});
