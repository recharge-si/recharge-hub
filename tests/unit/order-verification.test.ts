import { describe, expect, it } from "vitest";

import { buildSalesOrderBody } from "~/adapters/metakocka/documents";
import {
  classifyQuantities,
  type CanonicalLine,
  type QuantityClassification,
} from "~/domain/orders/canonical";
import { contentOf, verifyOrder } from "~/jobs/orders/verification";

/**
 * Verifying a reconciliation against the documents that were actually sent
 * (brief §25, §26).
 *
 * The actual side is read from the recorded request bodies — the exact bodies
 * MetaKocka accepted — rather than from a fresh read of every document. That is
 * a deliberate division of labour, and it is worth stating because it looks
 * like a shortcut and is not:
 *
 *  - "does MetaKocka still say what we sent" is the drift poller's question,
 *    asked hourly, per document;
 *  - "does what we sent add up to the order" is this one, asked every pass —
 *    and it is the failure the poller structurally cannot see, because every
 *    individual document can be exactly as sent while the set of them describes
 *    twice the order.
 *
 * So these tests build bodies with the real builder and check the arithmetic
 * over them, which is also what keeps the two in step: a change to the body
 * shape that this could not read would fail here rather than silently start
 * reporting every order as short.
 */

function body(
  countCode: string,
  lines: { sku: string; quantity: number; unitMinor: number }[],
) {
  return buildSalesOrderBody({
    countCode,
    buyerOrder: "SH-1050",
    docDate: new Date("2026-01-05T09:00:00Z"),
    currencyCode: "EUR",
    partner: { customer: "Ana Novak" },
    lines: lines.map((line) => ({
      code: line.sku,
      amount: line.quantity,
      priceWithTaxMinor: line.unitMinor,
      taxFactor: "0.22",
    })),
  });
}

/**
 * The classification a verification pass would have been handed.
 *
 * Written out rather than defaulted, because "where did every unit go" is
 * exactly what these tests are about: an order whose managed total is not its
 * Shopify total is a different assertion from one whose documents are wrong.
 */
function managed(lines: CanonicalLine[], external = 0): QuantityClassification {
  return classifyQuantities(
    lines,
    lines.flatMap((entry) => [
      {
        shopifyLocationId: "loc-a",
        supplySourceId: "src-a",
        disposition: "managed" as const,
        lines: [
          {
            shopifyLineItemId: entry.shopifyLineItemId,
            quantity: entry.quantity - external,
          },
        ],
      },
      ...(external > 0
        ? [
            {
              shopifyLocationId: null,
              supplySourceId: null,
              disposition: "external" as const,
              lines: [
                {
                  shopifyLineItemId: entry.shopifyLineItemId,
                  quantity: external,
                },
              ],
            },
          ]
        : []),
    ]),
  );
}

function line(sku: string, quantity: number, unitMinor = 10_000): CanonicalLine {
  return {
    shopifyLineItemId: `l-${sku}`,
    sku,
    title: sku,
    quantity,
    unitPriceWithTaxMinor: unitMinor,
    discountMinor: 0,
    taxFactor: "0.22",
  };
}

describe("reading a recorded document back", () => {
  it("understands what the builder produces", () => {
    const content = contentOf({
      countCode: "SH-1050-A",
      retired: false,
      requestBody: body("SH-1050-A", [
        { sku: "SKU-A", quantity: 2, unitMinor: 10_450 },
      ]),
    });

    expect(content.lines).toEqual([{ sku: "SKU-A", quantity: 2 }]);
    expect(content.valueMinor).toBe(20_900);
  });

  it("contributes nothing for a body it cannot read", () => {
    /*
     * The conservative direction on purpose. An unreadable body makes the
     * actual total look *smaller*, which reports a shortfall and asks a human
     * to look. Skipping the check instead would report everything as fine.
     */
    expect(contentOf({ countCode: "x", retired: false, requestBody: null }).lines)
      .toEqual([]);
    expect(
      contentOf({ countCode: "x", retired: false, requestBody: "[redacted]" })
        .lines,
    ).toEqual([]);
  });
});

describe("verifying a whole order", () => {
  const documents = [
    {
      countCode: "SH-1050-A",
      retired: false,
      requestBody: body("SH-1050-A", [
        { sku: "SKU-A", quantity: 2, unitMinor: 10_000 },
      ]),
    },
    {
      countCode: "SH-1050-B",
      retired: false,
      requestBody: body("SH-1050-B", [
        { sku: "SKU-A", quantity: 3, unitMinor: 10_000 },
      ]),
    },
  ];

  it("passes for a split order that adds up", () => {
    const result = verifyOrder({
      lines: [line("SKU-A", 5)],
      classification: managed([line("SKU-A", 5)]),
      documents,
      orderTotalMinor: 50_000,
      shippingMinor: 0,
      orderDiscountMinor: 0,
      grossReceivedMinor: 0,
      representedPaymentMinor: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.quantities.actualTotal).toBe(5);
    expect(result.documents).toEqual([
      {
        countCode: "SH-1050-A",
        retired: false,
        quantity: 2,
        valueMinor: 20_000,
        shippingMinor: 0,
        discountMinor: 0,
      },
      {
        countCode: "SH-1050-B",
        retired: false,
        quantity: 3,
        valueMinor: 30_000,
        shippingMinor: 0,
        discountMinor: 0,
      },
    ]);
  });

  it("counts a retired document, because MetaKocka still holds it", () => {
    /*
     * The point of counting them. A document the order no longer takes anything
     * from, which MetaKocka refused to empty, is holding quantity — and the
     * whole reason for this check is to make that visible rather than leaving
     * it to be discovered at the end of a quarter.
     */
    const result = verifyOrder({
      lines: [line("SKU-A", 2)],
      classification: managed([line("SKU-A", 2)]),
      documents: [
        {
          countCode: "SH-1050-A",
          retired: true,
          requestBody: body("SH-1050-A", [
            { sku: "SKU-A", quantity: 2, unitMinor: 10_000 },
          ]),
        },
        {
          countCode: "SH-1050-B",
          retired: false,
          requestBody: body("SH-1050-B", [
            { sku: "SKU-A", quantity: 2, unitMinor: 10_000 },
          ]),
        },
      ],
      orderTotalMinor: 20_000,
      shippingMinor: 0,
      orderDiscountMinor: 0,
      grossReceivedMinor: 0,
      representedPaymentMinor: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.quantities.discrepancies).toEqual([
      { sku: "SKU-A", expected: 2, actual: 4, difference: 2 },
    ]);
    expect(result.summary[0]).toBe("SKU-A: Shopify 2, MetaKocka 4 (+2).");
  });

  it("explains shipping as shipping rather than widening the tolerance", () => {
    /*
     * The identity closes: 500.00 of products plus 50.00 of postage is the
     * 550.00 Shopify charged. Shipping is not yet a MetaKocka document line
     * (project status T-05/T-06), so it is *named* as an unrepresented term
     * rather than absorbed into a tolerance that would also hide a 50.00 price
     * error.
     */
    const result = verifyOrder({
      lines: [line("SKU-A", 5)],
      classification: managed([line("SKU-A", 5)]),
      documents,
      orderTotalMinor: 55_000,
      shippingMinor: 5_000,
      orderDiscountMinor: 0,
      grossReceivedMinor: 0,
      representedPaymentMinor: 0,
    });

    expect(result.ok).toBe(true);
  });

  it("still fails when a line price has drifted", () => {
    const result = verifyOrder({
      lines: [line("SKU-A", 5)],
      classification: managed([line("SKU-A", 5)]),
      documents,
      // The order is worth 600.00 but the documents only add to 500.00 and
      // there is only 50.00 of shipping to explain it.
      orderTotalMinor: 60_000,
      shippingMinor: 5_000,
      orderDiscountMinor: 0,
      grossReceivedMinor: 0,
      representedPaymentMinor: 0,
    });

    /*
     * 500.00 of products plus 50.00 of postage explains 550.00 of a 600.00
     * order, so 50.00 is unaccounted for and the check fails.
     *
     * The old allowance-based version **passed this**: it widened the tolerance
     * by the shipping charge, so any drift smaller than the postage went
     * unnoticed. That is the hole the identity closes.
     */
    expect(result.ok).toBe(false);
    expect(result.value.unexplainedMinor).toBe(5_000);
    expect(
      result.summary.some((entry) => entry.includes("not accounted for")),
    ).toBe(true);
  });

  it("reports a payment mismatch without failing the order's sync verdict", () => {
    /*
     * A payment waiting on an unmapped gateway is a blocked payment, with its
     * own exception and its own retry. Calling the whole order inconsistent for
     * it would put a red banner on an order whose documents are perfect.
     */
    const result = verifyOrder({
      lines: [line("SKU-A", 5)],
      classification: managed([line("SKU-A", 5)]),
      documents,
      orderTotalMinor: 50_000,
      shippingMinor: 0,
      orderDiscountMinor: 0,
      grossReceivedMinor: 50_000,
      representedPaymentMinor: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.payments.ok).toBe(false);
    expect(result.payments.differenceMinor).toBe(-50_000);
  });
});
