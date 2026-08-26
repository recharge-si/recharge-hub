import { describe, expect, it } from "vitest";

import {
  minimiseOrderPayload,
  parseOrder,
  parseOrderSafe,
} from "~/adapters/shopify/order-payload";
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

/*
 * §8.6: the presentment currency and the presentment amount, or neither.
 *
 * The plain `total_price` / `line_items[].price` fields are the *shop* amounts.
 * Reading those and filing them under `presentment_currency` produces a
 * document that is internally consistent, plausible, and wrong by the exchange
 * rate — on every line, with nothing downstream able to notice.
 */
describe("a multi-currency order", () => {
  const MULTI = {
    ...PAYLOAD,
    currency: "EUR",
    presentment_currency: "USD",
    // Shop currency in the flat fields, presentment in the sets. A real
    // Shopify payload carries both.
    total_price: "119.98",
    current_total_price: "119.98",
    total_discounts: "10.00",
    total_tax: "21.63",
    total_price_set: {
      shop_money: { amount: "119.98" },
      presentment_money: { amount: "131.98" },
    },
    current_total_price_set: {
      shop_money: { amount: "119.98" },
      presentment_money: { amount: "131.98" },
    },
    total_discounts_set: {
      shop_money: { amount: "10.00" },
      presentment_money: { amount: "11.00" },
    },
    total_tax_set: {
      shop_money: { amount: "21.63" },
      presentment_money: { amount: "23.79" },
    },
    total_shipping_price_set: {
      shop_money: { amount: "4.99" },
      presentment_money: { amount: "5.49" },
    },
    line_items: [
      {
        ...PAYLOAD.line_items[0],
        price: "59.99",
        total_discount: "5.00",
        price_set: {
          shop_money: { amount: "59.99" },
          presentment_money: { amount: "65.99" },
        },
        total_discount_set: {
          shop_money: { amount: "5.00" },
          presentment_money: { amount: "5.50" },
        },
      },
    ],
  };

  const order = parseOrder(MULTI);

  it("stores the presentment amount under the presentment currency", () => {
    expect(order.currency).toBe("USD");
    expect(order.totalMinor).toBe(13198);
    expect(order.discountMinor).toBe(1100);
    expect(order.totalTaxMinor).toBe(2379);
    expect(order.shippingMinor).toBe(549);
    expect(order.lines[0]?.unitPriceWithTaxMinor).toBe(6599);
    expect(order.lines[0]?.discountMinor).toBe(550);
  });

  it("falls back to the flat field when the set is absent", () => {
    // A single-currency store reports the same number in both, and an older
    // payload may not carry the set at all.
    const flat = parseOrder(PAYLOAD);
    expect(flat.totalMinor).toBe(11998);
    expect(flat.discountMinor).toBe(1000);
    expect(flat.lines[0]?.unitPriceWithTaxMinor).toBe(5999);
    expect(flat.lines[0]?.discountMinor).toBe(500);
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
    // `name` used to be blanked wherever it appeared, which took the order's
    // own number and every line's product name with it — the decision trail
    // §2.4 promises to keep, and what the order screen reads.
    expect(redacted.name).toBe("#1042");
  });

  it("keeps a name that is a product, not a person", () => {
    const withNames = redactPayload({
      name: "#1042",
      line_items: [{ sku: "MAST-490", name: "Carbon mast - Blue", price: "1" }],
      product_list: [{ code: "MAST-490", name: "Carbon mast" }],
    }) as {
      name: string;
      line_items: { name: string }[];
      product_list: { name: string }[];
    };

    expect(withNames.name).toBe("#1042");
    expect(withNames.line_items[0]?.name).toBe("Carbon mast - Blue");
    expect(withNames.product_list[0]?.name).toBe("Carbon mast");
  });

  it("still blanks a name that is a person", () => {
    const nested = redactPayload({
      fulfillments: [{ destination: { name: "Lojze Horvat", zip: "1000" } }],
    }) as { fulfillments: { destination: { name: string } }[] };

    // Not one of the containers blanked whole, so the field itself has to go.
    expect(nested.fulfillments[0]?.destination.name).toBe("[redacted]");
  });

  it("is safe to run twice", () => {
    expect(redactPayload(redacted)).toEqual(redacted);
  });
});

describe("re-reading a stored payload", () => {
  it("survives a payload the retention job has been through", () => {
    /*
     * The §2.4 job replaces whole objects with the string "[redacted]" —
     * `customer`, `billing_address` and `shipping_address` among them — so a
     * stored payload is not guaranteed to still be an order.
     *
     * Three jobs re-read stored payloads: the document writer, the order sync
     * and the exception re-check. Handing a schema expecting an object a string
     * throws, which would have turned "this order is too old to send" into a
     * job that crashes, retries, and crashes again.
     */
    const redacted = redactPayload(PAYLOAD);

    expect(() => parseOrder(redacted)).toThrow();
    expect(parseOrderSafe(redacted)).toBeNull();
  });

  it("still reads a payload that is intact", () => {
    expect(parseOrderSafe(PAYLOAD)?.orderNumber).toBe("1042");
    expect(parseOrderSafe(null)).toBeNull();
  });
});

/*
 * §2.4 data minimisation. `raw_payload` is deliberately Shopify's whole record
 * of the order — trimming it to today's diff is what let an arriving address
 * go unnoticed — but the shopper's browser is not part of that record.
 */
describe("what is not stored at all", () => {
  it("drops the browser and the IP address", () => {
    const stored = minimiseOrderPayload({
      ...PAYLOAD,
      browser_ip: "81.4.6.10",
      client_details: {
        browser_ip: "81.4.6.10",
        user_agent: "Mozilla/5.0",
        accept_language: "sl-SI",
        session_hash: "abc",
      },
    }) as Record<string, unknown>;

    expect(stored).not.toHaveProperty("browser_ip");
    expect(stored).not.toHaveProperty("client_details");
    expect(JSON.stringify(stored)).not.toContain("81.4.6.10");
  });

  it("keeps everything the app actually reads", () => {
    const stored = minimiseOrderPayload(PAYLOAD);
    expect(stored).toEqual(PAYLOAD);
    // Nothing to remove means the same object, not a rebuilt copy.
    expect(stored).toBe(PAYLOAD);
  });

  it("leaves a payload that is not an object alone", () => {
    expect(minimiseOrderPayload(null)).toBeNull();
    expect(minimiseOrderPayload("[redacted]")).toBe("[redacted]");
  });
});
