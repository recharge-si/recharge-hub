import { describe, expect, it } from "vitest";

import { parseOrder } from "~/adapters/shopify/order-payload";
import { redactPayload } from "~/jobs/handlers/redact-old-orders";

/**
 * The boundary between Shopify's payload and everything else. Money becomes
 * integer minor units here (§15) and personal data is kept only where §2.4
 * allows, so both are pinned.
 */

const PAYLOAD = {
  id: 5001,
  order_number: 1042,
  name: "#1042",
  currency: "EUR",
  presentment_currency: "EUR",
  financial_status: "paid",
  taxes_included: true,
  total_tax: "0.00",
  total_price: "119.98",
  current_total_price: "119.98",
  total_discounts: "10.00",
  total_shipping_price_set: {
    shop_money: { amount: "4.99" },
    presentment_money: { amount: "4.99" },
  },
  payment_gateway_names: ["shopify_payments"],
  note: "Leave at the door",
  created_at: "2026-08-24T10:00:00Z",
  line_items: [
    {
      id: 9001,
      sku: "MAST-490",
      title: "Carbon mast",
      quantity: 2,
      price: "59.99",
      total_discount: "5.00",
      tax_lines: [{ rate: 0.22, price: "10.82" }],
    },
    {
      id: 9002,
      sku: "",
      title: "Mystery item",
      quantity: 1,
      price: "0.00",
      tax_lines: [],
    },
  ],
  customer: {
    first_name: "Janez",
    last_name: "Novak",
    email: "janez@example.com",
    phone: "+386 1 234 5678",
  },
  billing_address: {
    first_name: "Janez",
    last_name: "Novak",
    company: "Jadra d.o.o.",
    address1: "Slovenska cesta 100",
    zip: "1000",
    city: "Ljubljana",
    country: "Slovenia",
    country_code: "SI",
  },
  shipping_address: {
    first_name: "Lojze",
    last_name: "Horvat",
    address1: "Dunajska 120",
    zip: "1000",
    city: "Ljubljana",
    country: "Slovenia",
    country_code: "SI",
  },
};

describe("parsing an order", () => {
  const order = parseOrder(PAYLOAD);

  it("turns money into integer minor units", () => {
    expect(order.totalMinor).toBe(11998);
    expect(order.shippingMinor).toBe(499);
    expect(order.discountMinor).toBe(1000);
    expect(order.lines[0]?.unitPriceWithTaxMinor).toBe(5999);
    expect(order.lines[0]?.discountMinor).toBe(500);
  });

  it("never produces a float", () => {
    const numbers = [
      order.totalMinor,
      order.shippingMinor,
      order.discountMinor,
      ...order.lines.map((line) => line.unitPriceWithTaxMinor),
    ];
    expect(numbers.every(Number.isInteger)).toBe(true);
  });

  it("derives the tax factor from the line's own tax lines", () => {
    expect(order.lines[0]?.taxFactor).toBe("0.22");
  });

  /*
   * MetaKocka refuses a line whose product has no tax attribute and no tax on
   * the line — "Attribute 'tax' for product with code 'X' must be set." So the
   * question is not just "what is the rate" but "do we actually know it".
   */
  describe("when a line has no tax lines of its own", () => {
    it("is unknown when the line is taxable but no rate was given", () => {
      /*
       * Not zero, which this used to say. A taxable line with no tax lines is a
       * shop with no tax registration for that market, not a zero-rated sale.
       * Sending zero put a line of 209.00 at 0% into MetaKocka against a
       * pricelist reading 171.31 at 22% — right gross, a net matching nothing,
       * and VAT understated. Null makes the caller use the shop's own rate.
       */
      const untaxed = parseOrder({ ...PAYLOAD, total_tax: "0.00" });
      expect(untaxed.lines[1]?.taxFactor).toBeNull();
    });

    it("is zero when Shopify says the line is not taxable", () => {
      const exempt = parseOrder({
        ...PAYLOAD,
        total_tax: "12.00",
        line_items: [{ ...PAYLOAD.line_items[1], taxable: false }],
      });
      expect(exempt.lines[0]?.taxFactor).toBe("0");
    });

    it("is unknown when tax was charged but not broken down", () => {
      const taxed = parseOrder({ ...PAYLOAD, total_tax: "12.00" });
      expect(taxed.lines[1]?.taxFactor).toBeNull();
    });
  });

  it("reads whether prices already include tax", () => {
    expect(order.taxesIncluded).toBe(true);
    expect(
      parseOrder({ ...PAYLOAD, taxes_included: false }).taxesIncluded,
    ).toBe(false);
    // Unstated means inclusive, which is Shopify's own default. Assuming
    // exclusive would inflate every price by the VAT rate.
    const { taxes_included: _omitted, ...withoutFlag } = PAYLOAD;
    expect(parseOrder(withoutFlag).taxesIncluded).toBe(true);
  });

  it("keeps a line with no SKU rather than dropping it", () => {
    expect(order.lines).toHaveLength(2);
    expect(order.lines[1]?.sku).toBe("");
  });

  it("reads the buyer and the receiver separately", () => {
    expect(order.partner?.customer).toBe("Janez Novak");
    expect(order.receiver?.customer).toBe("Lojze Horvat");
  });

  it("treats a company on the address as a business buyer", () => {
    expect(order.partner?.isBusiness).toBe(true);
    expect(order.receiver?.isBusiness).toBe(false);
  });

  it("carries the gateway and the financial status through", () => {
    expect(order.gateway).toBe("shopify_payments");
    expect(order.financialStatus).toBe("paid");
  });

  it("falls back to unknown for a status with no rule", () => {
    const odd = parseOrder({ ...PAYLOAD, financial_status: "something_new" });
    expect(odd.financialStatus).toBe("unknown");
  });

  it("uses the presentment currency, never the shop currency", () => {
    const usd = parseOrder({ ...PAYLOAD, presentment_currency: "USD" });
    expect(usd.currency).toBe("USD");
  });
});

describe("Northern Ireland", () => {
  it("is its own country string, not UK", () => {
    const order = parseOrder({
      ...PAYLOAD,
      shipping_address: {
        ...PAYLOAD.shipping_address,
        country: "United Kingdom",
        country_code: "GB",
        province: "Northern Ireland",
      },
    });

    expect(order.receiver?.country).toBe("United Kingdom - Northern Ireland");
  });

  it("leaves the rest of the UK alone", () => {
    const order = parseOrder({
      ...PAYLOAD,
      shipping_address: {
        ...PAYLOAD.shipping_address,
        country: "United Kingdom",
        country_code: "GB",
        province: "Kent",
      },
    });

    expect(order.receiver?.country).toBe("United Kingdom");
  });
});

describe("the retention job keeps the decision trail", () => {
  const redacted = redactPayload(PAYLOAD) as typeof PAYLOAD;

  it("removes the person", () => {
    expect(JSON.stringify(redacted)).not.toContain("janez@example.com");
    expect(JSON.stringify(redacted)).not.toContain("Slovenska cesta 100");
    expect(JSON.stringify(redacted)).not.toContain("Novak");
  });

  it("keeps SKUs, quantities and prices", () => {
    expect(redacted.line_items[0]?.sku).toBe("MAST-490");
    expect(redacted.line_items[0]?.quantity).toBe(2);
    expect(redacted.line_items[0]?.price).toBe("59.99");
    expect(redacted.total_price).toBe("119.98");
  });

  it("keeps the order identity, so the audit trail still resolves", () => {
    expect(redacted.id).toBe(5001);
    expect(redacted.order_number).toBe(1042);
  });

  it("is safe to run twice", () => {
    expect(redactPayload(redacted)).toEqual(redacted);
  });
});
