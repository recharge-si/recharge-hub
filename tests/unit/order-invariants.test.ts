import { describe, expect, it } from "vitest";

import {
  DEFAULT_VALUE_TOLERANCE_MINOR,
  describeDiscrepancies,
  verifyPaymentRepresentation,
  verifyQuantities,
  verifyValue,
} from "~/domain/orders/invariants";

/**
 * The invariants (brief §24, §25, §26).
 *
 * ```text
 * for every SKU:
 *   SUM(quantity across the order's MetaKocka documents) = Shopify's quantity
 * ```
 *
 * The response to a break is as important as the detection, and it is the
 * reason this is a check rather than a repair: **a mismatch is never fixed by
 * writing another document.** If MetaKocka holds six where Shopify says four,
 * another document makes it ten. What these functions produce is the exact
 * difference, per SKU, for the exception and for the next deterministic pass.
 */

describe("the quantity invariant", () => {
  it("passes when the documents add up to the order", () => {
    // A split order: 5 units, 2 from one warehouse and 3 from another.
    const result = verifyQuantities({
      expected: [{ sku: "SKU-A", quantity: 5 }],
      actual: [
        { sku: "SKU-A", quantity: 2 },
        { sku: "SKU-A", quantity: 3 },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.expectedTotal).toBe(5);
    expect(result.actualTotal).toBe(5);
  });

  it("is unmoved by a line changing warehouse", () => {
    /*
     * The property that makes this worth asserting at all. A location move
     * changes both documents and changes nothing about the invariant — so a
     * move that is correct passes, and one that duplicated the line does not.
     */
    const before = verifyQuantities({
      expected: [{ sku: "SKU-A", quantity: 2 }],
      actual: [{ sku: "SKU-A", quantity: 2 }],
    });
    const after = verifyQuantities({
      expected: [{ sku: "SKU-A", quantity: 2 }],
      actual: [
        { sku: "SKU-A", quantity: 0 },
        { sku: "SKU-A", quantity: 2 },
      ],
    });

    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
  });

  it("catches the duplicate a botched move would leave behind", () => {
    const result = verifyQuantities({
      expected: [{ sku: "SKU-A", quantity: 2 }],
      actual: [
        { sku: "SKU-A", quantity: 2 },
        { sku: "SKU-A", quantity: 2 },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.discrepancies).toEqual([
      { sku: "SKU-A", expected: 2, actual: 4, difference: 2 },
    ]);
  });

  it("reports the brief's 4-versus-6 example with the difference stated", () => {
    const result = verifyQuantities({
      expected: [{ sku: "ABC", quantity: 4 }],
      actual: [{ sku: "ABC", quantity: 6 }],
    });

    expect(result.discrepancies).toEqual([
      { sku: "ABC", expected: 4, actual: 6, difference: 2 },
    ]);
    expect(describeDiscrepancies(result.discrepancies)).toEqual([
      "ABC: Shopify 4, MetaKocka 6 (+2).",
    ]);
  });

  it("catches a SKU MetaKocka holds that the order does not", () => {
    // The most expensive failure there is: goods in the ERP nobody bought.
    const result = verifyQuantities({
      expected: [{ sku: "SKU-A", quantity: 2 }],
      actual: [
        { sku: "SKU-A", quantity: 2 },
        { sku: "SKU-B", quantity: 1 },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.discrepancies).toEqual([
      { sku: "SKU-B", expected: 0, actual: 1, difference: 1 },
    ]);
  });

  it("catches a SKU the order has and MetaKocka does not", () => {
    const result = verifyQuantities({
      expected: [
        { sku: "SKU-A", quantity: 2 },
        { sku: "SKU-B", quantity: 1 },
      ],
      actual: [{ sku: "SKU-A", quantity: 2 }],
    });

    expect(result.discrepancies).toEqual([
      { sku: "SKU-B", expected: 1, actual: 0, difference: -1 },
    ]);
  });

  it("reports discrepancies in a stable order", () => {
    // The exception message is compared between passes by a human; an unstable
    // order reads as a changing problem.
    const result = verifyQuantities({
      expected: [],
      actual: [
        { sku: "ZZZ", quantity: 1 },
        { sku: "AAA", quantity: 1 },
      ],
    });
    expect(result.discrepancies.map((entry) => entry.sku)).toEqual([
      "AAA",
      "ZZZ",
    ]);
  });
});

describe("the value invariant", () => {
  it("allows a cent of rounding and nothing more", () => {
    expect(
      verifyValue({ expectedMinor: 20_900, actualMinor: 20_901 }).ok,
    ).toBe(true);
    expect(
      verifyValue({ expectedMinor: 20_900, actualMinor: 20_902 }).ok,
    ).toBe(false);
    expect(DEFAULT_VALUE_TOLERANCE_MINOR).toBe(1);
  });

  it("allows exactly the shipping and discount the connector knows it omits", () => {
    /*
     * Shipping and order-level discounts are accounted for in the payment
     * shares but are not yet MetaKocka document lines (project status
     * T-05/T-06). Without the allowance every order with postage on it would
     * report as broken; with it, a line price drifting still does.
     */
    const withShipping = verifyValue({
      expectedMinor: 25_900, // 209.00 of goods plus 50.00 of postage
      actualMinor: 20_900,
      allowanceMinor: 5_000,
    });
    expect(withShipping.ok).toBe(true);

    const withDrift = verifyValue({
      expectedMinor: 25_900,
      actualMinor: 19_900,
      allowanceMinor: 5_000,
    });
    expect(withDrift.ok).toBe(false);
    expect(withDrift.differenceMinor).toBe(-6_000);
  });

  it("reports the direction of the difference", () => {
    const over = verifyValue({ expectedMinor: 10_000, actualMinor: 20_000 });
    expect(over.differenceMinor).toBe(10_000);
    expect(over.ok).toBe(false);
  });
});

describe("the payment invariant (§24)", () => {
  it("compares the gross received against what was recorded", () => {
    expect(
      verifyPaymentRepresentation({
        grossReceivedMinor: 30_000,
        representedMinor: 30_000,
      }).ok,
    ).toBe(true);
  });

  it("compares against gross, not net, so a refund does not break it for ever", () => {
    /*
     * A document that received €300 and was later credited €50 still
     * legitimately carries a €300 payment: in MetaKocka the refund is a credit
     * note, not a shrunken receipt. Comparing the net would report every
     * refunded order as broken from then on.
     */
    const result = verifyPaymentRepresentation({
      grossReceivedMinor: 30_000,
      representedMinor: 30_000,
    });
    expect(result.ok).toBe(true);
    expect(result.differenceMinor).toBe(0);
  });

  it("catches money received that MetaKocka was never told about", () => {
    const result = verifyPaymentRepresentation({
      grossReceivedMinor: 30_000,
      representedMinor: 10_000,
    });
    expect(result.ok).toBe(false);
    expect(result.differenceMinor).toBe(-20_000);
  });

  it("catches the doubled payment a bad split would produce", () => {
    const result = verifyPaymentRepresentation({
      grossReceivedMinor: 30_000,
      representedMinor: 60_000,
    });
    expect(result.ok).toBe(false);
    expect(result.differenceMinor).toBe(30_000);
  });
});
