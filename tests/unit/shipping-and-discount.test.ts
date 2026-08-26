import { describe, expect, it } from "vitest";

import { buildSalesOrderBody } from "~/adapters/metakocka/documents";
import { splitOrderMoney } from "~/domain/money/split";
import { reconcileValue } from "~/domain/orders/invariants";
import { contentOf, verifyOrder } from "~/jobs/orders/verification";
import { classifyQuantities, type CanonicalLine } from "~/domain/orders/canonical";

/**
 * Shipping and discounts on a MetaKocka sales order.
 *
 * The mechanisms are the ones verified live against the designated test company
 * on 2026-08-26 (`tests/fixtures/metakocka/shipping_discount_semantics.json`),
 * and the two that were *rejected* matter as much as the one chosen:
 *
 *  - the per-line `discount` field is a **percentage** (a 200.00 line with
 *    `discount: "10"` reads 180), and Shopify supplies absolute amounts, so
 *    using it would mean inventing a conversion and its rounding;
 *  - a negative-price line works exactly, cents and all, but puts a
 *    negative-priced *stock* article on the document and moves inventory for
 *    goods that do not exist.
 *
 * So shipping is a positive line against an article the merchant names, and a
 * discount is the document's own `discount_value`, which is absolute.
 */

const SHIP = "SHIPPING";

const BASE = {
  countCode: "SH-1050-A",
  buyerOrder: "SH-1050",
  docDate: new Date("2026-01-05T09:00:00Z"),
  currencyCode: "EUR",
  partner: { customer: "Ana Novak" },
  lines: [
    { code: "SKU-A", amount: 1, priceWithTaxMinor: 10_000, taxFactor: "0.22" },
  ],
};

function linesOf(body: ReturnType<typeof buildSalesOrderBody>) {
  return (body as { product_list: Record<string, string>[] }).product_list;
}

describe("the document body", () => {
  it("writes shipping as an extra positive line, last", () => {
    const body = buildSalesOrderBody({
      ...BASE,
      shippingLine: { code: SHIP, amountMinor: 500, taxFactor: "0.22" },
    });

    expect(linesOf(body)).toEqual([
      { code: "SKU-A", amount: "1", price_with_tax: "100.00", tax_factor: "0.22" },
      { code: SHIP, amount: "1", price_with_tax: "5.00", tax_factor: "0.22" },
    ]);
  });

  it("writes a discount as the document's own absolute discount_value", () => {
    const body = buildSalesOrderBody({ ...BASE, discountValueMinor: 1_000 });
    expect((body as { discount_value?: string }).discount_value).toBe("10.00");
  });

  it("builds the brief's worked example: 100 + 5 - 10 = 95", () => {
    const body = buildSalesOrderBody({
      ...BASE,
      shippingLine: { code: SHIP, amountMinor: 500, taxFactor: "0.22" },
      discountValueMinor: 1_000,
    });

    const lineTotal = linesOf(body).reduce(
      (sum, line) => sum + Math.round(Number(line.price_with_tax) * 100),
      0,
    );
    const discount = Math.round(
      Number((body as { discount_value: string }).discount_value) * 100,
    );

    expect(lineTotal - discount).toBe(9_500);
  });

  it("omits both when the order has neither", () => {
    const body = buildSalesOrderBody(BASE);
    expect(linesOf(body)).toHaveLength(1);
    expect((body as { discount_value?: string }).discount_value).toBeUndefined();
  });

  it("is byte-identical when built twice", () => {
    // The update path compares bodies to decide whether to write at all.
    const input = {
      ...BASE,
      shippingLine: { code: SHIP, amountMinor: 500, taxFactor: "0.22" },
      discountValueMinor: 1_000,
    };
    expect(JSON.stringify(buildSalesOrderBody(input))).toBe(
      JSON.stringify(buildSalesOrderBody(input)),
    );
  });
});

describe("reading a document back", () => {
  const body = buildSalesOrderBody({
    ...BASE,
    shippingLine: { code: SHIP, amountMinor: 500, taxFactor: "0.22" },
    discountValueMinor: 1_000,
  });

  it("keeps the shipping line out of the merchandise", () => {
    /*
     * A shipping line is a product line on the wire. Counted as merchandise it
     * would break the quantity invariant on every order with postage: MetaKocka
     * would appear to hold one unit of a SKU Shopify never sold.
     */
    const content = contentOf(
      { countCode: "SH-1050-A", retired: false, requestBody: body },
      SHIP,
    );

    expect(content.lines).toEqual([{ sku: "SKU-A", quantity: 1 }]);
    expect(content.valueMinor).toBe(10_000);
    expect(content.shippingMinor).toBe(500);
    expect(content.discountMinor).toBe(1_000);
  });

  it("counts it as goods when no shipping article is configured", () => {
    // Honest rather than clever: with nothing configured the app has no way to
    // know that line is postage, and pretending otherwise would hide a real
    // extra line somebody added by hand.
    const content = contentOf({
      countCode: "SH-1050-A",
      retired: false,
      requestBody: body,
    });
    expect(content.lines).toHaveLength(2);
  });
});

describe("shipping and discount across a split order", () => {
  it("charges each exactly once, in proportion to merchandise", () => {
    // The brief's example: A 100, B 200, shipping 15, discount 30.
    const shares = splitOrderMoney({
      perSource: [
        { sourceId: "a", sourceCode: "A", kind: "own", lineTotalMinor: 10_000 },
        { sourceId: "b", sourceCode: "B", kind: "own", lineTotalMinor: 20_000 },
      ],
      orderTotalMinor: 28_500,
      shippingMinor: 1_500,
      discountMinor: 3_000,
    });

    const a = shares.find((s) => s.sourceCode === "A")!;
    const b = shares.find((s) => s.sourceCode === "B")!;

    expect([a.shippingMinor, b.shippingMinor]).toEqual([500, 1_000]);
    expect([a.discountMinor, b.discountMinor]).toEqual([1_000, 2_000]);

    // Never 15 on each, which is the failure this exists to prevent.
    expect(a.shippingMinor + b.shippingMinor).toBe(1_500);
    expect(a.discountMinor + b.discountMinor).toBe(3_000);
  });

  it("moves the whole charge when every product moves to one warehouse", () => {
    /*
     * The reconciliation case. Before: A 100, B 200, shipping 15. After: all
     * products at A. A must carry the whole 15 and B none of it — no stale
     * postage may stay on the document the order left.
     */
    const after = splitOrderMoney({
      perSource: [
        { sourceId: "a", sourceCode: "A", kind: "own", lineTotalMinor: 30_000 },
      ],
      orderTotalMinor: 31_500,
      shippingMinor: 1_500,
      discountMinor: 0,
    });

    expect(after).toHaveLength(1);
    expect(after[0]!.shippingMinor).toBe(1_500);
  });
});

describe("the value invariant once shipping and discounts are represented", () => {
  const line: CanonicalLine = {
    shopifyLineItemId: "l1",
    sku: "SKU-A",
    title: "A",
    quantity: 1,
    unitPriceWithTaxMinor: 10_000,
    discountMinor: 0,
    taxFactor: "0.22",
  };

  const classification = classifyQuantities(
    [line],
    [
      {
        shopifyLocationId: "loc-a",
        supplySourceId: "src-a",
        disposition: "managed",
        lines: [{ shopifyLineItemId: "l1", quantity: 1 }],
      },
    ],
  );

  const documents = [
    {
      countCode: "SH-1050-A",
      retired: false,
      requestBody: buildSalesOrderBody({
        ...BASE,
        shippingLine: { code: SHIP, amountMinor: 500, taxFactor: "0.22" },
        discountValueMinor: 1_000,
      }),
    },
  ];

  it("explains the whole 95.00 with nothing left over", () => {
    const result = verifyOrder({
      lines: [line],
      classification,
      documents,
      orderTotalMinor: 9_500,
      shippingMinor: 500,
      orderDiscountMinor: 1_000,
      shippingProductCode: SHIP,
      discountConfigured: true,
      grossReceivedMinor: 0,
      representedPaymentMinor: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.value.representedShippingMinor).toBe(500);
    expect(result.value.representedDiscountMinor).toBe(1_000);
    expect(result.value.unexplainedMinor).toBe(0);
    expect(result.value.representationGapMinor).toBe(0);
    expect(result.value.documentDriftMinor).toBe(0);
  });

  it("reports a representation gap without calling the documents wrong", () => {
    /*
     * Nothing configured: the documents legitimately carry only the goods, so
     * that is not *drift*. It is a decision nobody has made, which the caller
     * turns into `commercial_representation_missing` and a blocked order —
     * never a silent full reconciliation.
     */
    const result = verifyOrder({
      lines: [line],
      classification,
      documents: [
        { countCode: "SH-1050-A", retired: false, requestBody: buildSalesOrderBody(BASE) },
      ],
      orderTotalMinor: 9_500,
      shippingMinor: 500,
      orderDiscountMinor: 1_000,
      shippingProductCode: null,
      discountConfigured: false,
      grossReceivedMinor: 0,
      representedPaymentMinor: 0,
    });

    expect(result.value.documentDriftMinor).toBe(0);
    expect(result.value.representationGapMinor).toBe(1_500);
  });

  it("still calls it drift when a configured charge fails to reach the document", () => {
    // Configured, and the document does not carry it: that is a fault.
    const value = reconcileValue({
      orderTotalMinor: 9_500,
      documentsMinor: 10_000,
      productsExpectedMinor: 10_000,
      lineDiscountMinor: 0,
      orderDiscountMinor: 1_000,
      shippingMinor: 500,
      externalValueMinor: 0,
      representedShippingMinor: 0,
      representedDiscountMinor: 0,
      shippingConfigured: true,
      discountConfigured: true,
    });

    expect(value.ok).toBe(false);
    expect(value.representationGapMinor).toBe(0);
    expect(value.documentDriftMinor).toBe(500);
  });
});
