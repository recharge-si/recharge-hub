import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseOrder } from "~/adapters/shopify/order-payload";
import { toWebhookShape } from "~/adapters/shopify/orders";

/**
 * Shopify's tax data, normalised at the boundary (§14 of the brief).
 *
 * The engine never sees a Shopify field name: it reads a `NormalizedOrderTax`
 * built here from a recorded webhook payload. The same structure has to come
 * out of the Admin API read, so the second half of this file pushes a GraphQL
 * node through the mapper and parses the result with the same parser.
 */

const PAYLOAD: unknown = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "tests/fixtures/shopify/orders_create_mixed_tax.json"),
    "utf8",
  ),
);

describe("a webhook payload with mixed rates, taxed shipping and a VAT number", () => {
  const order = parseOrder(PAYLOAD);

  it("reads the order-level tax facts", () => {
    expect(order.tax.currency).toBe("EUR");
    expect(order.tax.taxesIncluded).toBe(true);
    expect(order.tax.totalTaxMinor).toBe(4166);
    expect(order.totalTaxMinor).toBe(4166);
    expect(order.tax.orderTaxLines).toEqual([
      { rateKey: "22", amountMinor: 3976, title: "DDV" },
      { rateKey: "9.5", amountMinor: 190, title: "DDV" },
    ]);
  });

  it("reads the destination and the buyer's tax context", () => {
    expect(order.tax.destinationCountry).toBe("DE");
    expect(order.tax.billingCountry).toBe("DE");
    expect(order.tax.customer).toEqual({
      isBusiness: true,
      vatNumber: "DE123456789",
      taxExempt: false,
    });
  });

  it("keeps every line at its own rate with Shopify's own amounts", () => {
    expect(order.tax.lines).toEqual([
      {
        lineId: "14101",
        sku: "MAST-490",
        quantity: 2,
        unitPriceMinor: 11220,
        discountMinor: 1000,
        taxable: true,
        taxLines: [{ rateKey: "22", amountMinor: 3866, title: "DDV" }],
      },
      {
        lineId: "14102",
        sku: "BOOK-1",
        quantity: 1,
        unitPriceMinor: 2190,
        discountMinor: 0,
        taxable: true,
        taxLines: [{ rateKey: "9.5", amountMinor: 190, title: "DDV" }],
      },
      {
        lineId: "14103",
        sku: "GIFT-CARD",
        quantity: 1,
        unitPriceMinor: 1200,
        discountMinor: 0,
        taxable: false,
        taxLines: [],
      },
    ]);
  });

  it("reads shipping's own tax lines rather than borrowing a product rate", () => {
    expect(order.tax.shipping).toEqual({
      amountMinor: 610,
      taxLines: [{ rateKey: "22", amountMinor: 110, title: "DDV" }],
    });
  });

  it("reads the refund with Shopify's own goods and tax amounts and the shipping adjustment", () => {
    expect(order.refunds).toEqual([
      {
        refundId: "88001",
        createdAt: "2026-09-12T09:30:00+02:00",
        totalRefundedMinor: 10720 + 610,
        lines: [{ lineId: "14101", quantity: 1, subtotalMinor: 10720, taxMinor: 1933 }],
        shipping: { amountMinor: 610, taxMinor: 110 },
      },
    ]);
  });

  it("still derives the raw per-line factor the way it always did", () => {
    expect(order.lines.map((line) => line.taxFactor)).toEqual(["0.22", "0.095", "0"]);
  });
});

describe("a payload without shipping lines", () => {
  it("reports shipping as not described, not as untaxed", () => {
    const payload = JSON.parse(JSON.stringify(PAYLOAD)) as Record<string, unknown>;
    delete payload.shipping_lines;
    const order = parseOrder(payload);
    expect(order.tax.shipping).toEqual({ amountMinor: 610, taxLines: null });
  });

  it("finds Northern Ireland inside the EU VAT area", () => {
    const payload = JSON.parse(JSON.stringify(PAYLOAD)) as {
      shipping_address: Record<string, unknown>;
    };
    payload.shipping_address = {
      ...payload.shipping_address,
      country: "United Kingdom",
      country_code: "GB",
      province: "Northern Ireland",
    };
    expect(parseOrder(payload).tax.destinationCountry).toBe("XI");
  });

  it("drops a tax line whose rate cannot be read rather than guessing", () => {
    const payload = JSON.parse(JSON.stringify(PAYLOAD)) as {
      line_items: { tax_lines: { rate: unknown }[] }[];
    };
    payload.line_items[0]!.tax_lines[0]!.rate = "not a rate";
    expect(parseOrder(payload).tax.lines[0]?.taxLines).toEqual([]);
  });
});

describe("the Admin API read produces the same normalised tax", () => {
  const node = {
    id: "gid://shopify/Order/5551234567999",
    name: "#1077",
    number: 1077,
    createdAt: "2026-09-10T07:30:00Z",
    updatedAt: "2026-09-12T07:30:00Z",
    cancelledAt: null,
    note: null,
    email: "anna@example.test",
    phone: null,
    currencyCode: "EUR",
    presentmentCurrencyCode: "EUR",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    taxesIncluded: true,
    taxExempt: false,
    paymentGatewayNames: ["bank_deposit"],
    currentTotalPriceSet: { presentmentMoney: { amount: "254.40" } },
    totalPriceSet: { presentmentMoney: { amount: "254.40" } },
    totalDiscountsSet: { presentmentMoney: { amount: "10.00" } },
    totalTaxSet: { presentmentMoney: { amount: "41.66" } },
    currentTotalTaxSet: { presentmentMoney: { amount: "41.66" } },
    totalShippingPriceSet: { presentmentMoney: { amount: "6.10" } },
    taxLines: [
      { title: "DDV", rate: 0.22, ratePercentage: 22, priceSet: { presentmentMoney: { amount: "39.76" } } },
      { title: "DDV", rate: 0.095, ratePercentage: 9.5, priceSet: { presentmentMoney: { amount: "1.90" } } },
    ],
    customAttributes: [{ key: "VAT number", value: "DE123456789" }],
    shippingLines: {
      nodes: [
        {
          title: "Standard",
          originalPriceSet: { presentmentMoney: { amount: "6.10" } },
          discountedPriceSet: { presentmentMoney: { amount: "6.10" } },
          taxLines: [{ title: "DDV", rate: 0.22, ratePercentage: 22, priceSet: { presentmentMoney: { amount: "1.10" } } }],
        },
      ],
    },
    refunds: [
      {
        id: "gid://shopify/Refund/88001",
        createdAt: "2026-09-12T07:30:00Z",
        refundLineItems: {
          nodes: [
            {
              quantity: 1,
              subtotalSet: { presentmentMoney: { amount: "107.20" } },
              totalTaxSet: { presentmentMoney: { amount: "19.33" } },
              lineItem: { id: "gid://shopify/LineItem/14101" },
            },
          ],
        },
        refundShippingLines: {
          nodes: [
            {
              subtotalAmountSet: { presentmentMoney: { amount: "6.10" } },
              taxAmountSet: { presentmentMoney: { amount: "1.10" } },
            },
          ],
        },
      },
    ],
    billingAddress: {
      firstName: "Anna",
      lastName: "Schmidt",
      name: "Anna Schmidt",
      company: "Schmidt GmbH",
      address1: "Hauptstrasse 1",
      address2: null,
      zip: "10115",
      city: "Berlin",
      province: null,
      provinceCode: null,
      country: "Germany",
      countryCodeV2: "DE",
      phone: null,
    },
    shippingAddress: null,
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/LineItem/14101",
          sku: "MAST-490",
          title: "Carbon mast 490",
          name: "Carbon mast 490",
          quantity: 2,
          taxable: true,
          originalUnitPriceSet: { presentmentMoney: { amount: "112.20" } },
          totalDiscountSet: { presentmentMoney: { amount: "10.00" } },
          taxLines: [{ title: "DDV", rate: 0.22, ratePercentage: 22, priceSet: { presentmentMoney: { amount: "38.66" } } }],
        },
        {
          id: "gid://shopify/LineItem/14103",
          sku: "GIFT-CARD",
          title: "Gift card",
          name: "Gift card",
          quantity: 1,
          taxable: false,
          originalUnitPriceSet: { presentmentMoney: { amount: "12.00" } },
          totalDiscountSet: { presentmentMoney: { amount: "0.00" } },
          taxLines: [],
        },
      ],
    },
  };

  const order = parseOrder(toWebhookShape(node));

  it("carries the order's tax facts, the VAT number and the exemption flag", () => {
    expect(order.tax.totalTaxMinor).toBe(4166);
    expect(order.tax.orderTaxLines.map((line) => line.rateKey)).toEqual(["22", "9.5"]);
    expect(order.tax.customer).toEqual({ isBusiness: true, vatNumber: "DE123456789", taxExempt: false });
    // No shipping address: the billing country is the destination.
    expect(order.tax.destinationCountry).toBeNull();
    expect(order.tax.billingCountry).toBe("DE");
  });

  it("carries shipping tax lines and the refund the way the webhook does", () => {
    expect(order.tax.shipping).toEqual({
      amountMinor: 610,
      taxLines: [{ rateKey: "22", amountMinor: 110, title: "DDV" }],
    });
    expect(order.refunds[0]).toMatchObject({
      refundId: "88001",
      lines: [{ lineId: "14101", quantity: 1, subtotalMinor: 10720, taxMinor: 1933 }],
      shipping: { amountMinor: 610, taxMinor: 110 },
    });
  });

  it("reads the per-line tax lines with the decimal rate", () => {
    expect(order.tax.lines[0]?.taxLines).toEqual([{ rateKey: "22", amountMinor: 3866, title: "DDV" }]);
    expect(order.tax.lines[1]?.taxable).toBe(false);
  });
});
