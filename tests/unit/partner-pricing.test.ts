import { beforeEach, describe, expect, it, vi } from "vitest";

import { MetakockaClient } from "~/adapters/metakocka/client";
import {
  buildSalesOrderBody,
  type SalesOrderInput,
} from "~/adapters/metakocka/documents";
import {
  pricelistNetPrice,
  readPricelistNetPrices,
  type PricelistEntry,
} from "~/adapters/metakocka/pricelists";
import {
  classifyQuantities,
  type CanonicalLine,
} from "~/domain/orders/canonical";
import {
  buyerNote,
  parseDiscountPercent,
  partnerPricingForOrder,
} from "~/domain/orders/partner";
import { documentTitleFor } from "~/domain/orders/reference";
import { effectiveCountryRates } from "~/domain/tax/config";
import { decideOrderTax, decidePartnerPricedTax } from "~/domain/tax/decide";
import type { NormalizedOrderTax, TaxConfig } from "~/domain/tax/types";
import {
  contentOnly,
  sameDocument,
} from "~/jobs/handlers/write-metakocka-order";
import {
  applyPartnerPricing,
  clearPartnerPriceCache,
  frozenPartnerPrices,
  partnerNetPrices,
  unpricedSkus,
} from "~/jobs/partner-pricing";
import { verifyOrder } from "~/jobs/orders/verification";

/**
 * Partner pricing: every order of a reseller's Shopify store becomes this
 * company's wholesale sales order to the reseller (docs/architecture.md § Who
 * an order is filed against).
 *
 * The reference is MetaKocka document 1209/2026, made by hand for Shopify
 * order LISA #2035 and read back live on 2026-11-27. The body built here has
 * to say what that document says.
 */

const PRICING = { pricelistCode: "4", discountPercent: "20" };

/** What the Shopify order #2035 carries: a French consumer, shipping charged. */
const BUYER = {
  customer: "Tim Parey",
  street: "20 Chemin Du Roy D’Espagne, A1",
  postNumber: "13009",
  place: "Marseille",
  country: "France",
  email: "timparey@orange.fr",
  phone: "+33 6 16 99 17 16",
};

const LISA = {
  customer: "LISA Windsurfing",
  street: "Rue du Port 1",
  mkId: "400067186133",
  mkAddressId: "400076852151",
};

/**
 * The sales order the writer would send for #2035 without partner pricing:
 * the Shopify receiver, the retail price with VAT, the postage line, a
 * payment. Everything partner pricing has to take off is on it.
 */
function retailOrder(): SalesOrderInput {
  return {
    // MetaKocka numbering: no count_code, as on 1209/2026.
    countCode: null,
    buyerOrder: "SH-2035",
    title: documentTitleFor("LISA {order.name}", {
      name: "#2035",
      number: "2035",
      id: "6100000002035",
      customerEmail: null,
    }),
    docDate: new Date("2026-11-26T10:00:00Z"),
    currencyCode: "EUR",
    taxesIncluded: true,
    partner: LISA,
    receiver: { ...BUYER },
    salesPricelistCode: "1",
    warehouse: "Main",
    profitCenter: "TIME 4 ACTION, TRGOVINA D.O.O.",
    deliveryType: null,
    notes: buyerNote(BUYER),
    shippingLine: { code: "POSTAGE", amountMinor: 990, taxFactor: "0.2" },
    discountValueMinor: 500,
    payments: [
      {
        paymentType: "Shopify Payments",
        paidAt: new Date("2026-11-26T10:00:00Z"),
        amountMinor: 5390,
      },
    ],
    lines: [
      {
        code: "L12260002101",
        amount: 1,
        priceWithTaxMinor: 4900,
        // What the engine would have said for a French consumer.
        taxFactor: "0.2",
      },
    ],
  };
}

describe("the sales order for LISA #2035", () => {
  const body = buildSalesOrderBody(
    applyPartnerPricing(
      retailOrder(),
      PRICING,
      new Map([["L12260002101", { price: "32.5", discount: "20" }]]),
    ),
  );

  it("matches MetaKocka document 1209/2026, field for field", () => {
    expect(body).toEqual({
      doc_type: "sales_order",
      doc_date: "26.11.2026",
      currency_code: "EUR",
      buyer_order: "SH-2035",
      title: "LISA #2035",
      partner: {
        mk_id: "400067186133",
        mk_address_id: "400076852151",
        customer: "LISA Windsurfing",
        street: "Rue du Port 1",
      },
      sales_pricelist_code: "4",
      warehouse: "Main",
      profit_center: "TIME 4 ACTION, TRGOVINA D.O.O.",
      notes:
        "Tim Parey, 20 Chemin Du Roy D’Espagne, A1, 13009 Marseille, France, +33 6 16 99 17 16\ntimparey@orange.fr",
      product_list: [
        {
          code: "L12260002101",
          amount: "1",
          price: "32.5",
          discount: "20",
          tax_factor: "0",
        },
      ],
    });
  });

  it("sends no number, receiver, shipping, document discount or payment", () => {
    expect(body).not.toHaveProperty("count_code");
    expect(body).not.toHaveProperty("receiver");
    expect(body).not.toHaveProperty("discount_value");
    expect(body).not.toHaveProperty("mark_paid");
    expect(body.product_list).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("price_with_tax");
  });
});

describe("a shop without partner pricing", () => {
  const ordinary: SalesOrderInput = {
    countCode: "SH-1050",
    buyerOrder: "SH-1050",
    docDate: new Date("2026-08-25T09:30:00Z"),
    currencyCode: "EUR",
    taxesIncluded: true,
    partner: { customer: "Ana Novak", street: "Trzaska 1" },
    receiver: { customer: "Ana Novak", street: "Trzaska 1" },
    salesPricelistCode: "1",
    warehouse: "GLAVNO",
    lines: [
      {
        code: "MAST-490",
        amount: 2,
        priceWithTaxMinor: 5999,
        taxFactor: "0.22",
      },
    ],
  };

  it("sends exactly the bytes it always did", () => {
    expect(JSON.stringify(buildSalesOrderBody(ordinary))).toBe(
      JSON.stringify({
        doc_type: "sales_order",
        count_code: "SH-1050",
        doc_date: "25.08.2026",
        currency_code: "EUR",
        buyer_order: "SH-1050",
        partner: {
          business_entity: "false",
          taxpayer: "false",
          foreign_county: "false",
          tax_id_number: "",
          customer: "Ana Novak",
          street: "Trzaska 1",
        },
        receiver: {
          business_entity: "false",
          taxpayer: "false",
          foreign_county: "false",
          tax_id_number: "",
          customer: "Ana Novak",
          street: "Trzaska 1",
        },
        sales_pricelist_code: "1",
        warehouse: "GLAVNO",
        product_list: [
          {
            code: "MAST-490",
            amount: "2",
            price_with_tax: "59.99",
            tax_factor: "0.22",
          },
        ],
      }),
    );
  });

  it("is unchanged by the new fields left empty", () => {
    expect(
      JSON.stringify(
        buildSalesOrderBody({
          ...ordinary,
          title: null,
          lines: ordinary.lines.map((line) => ({
            ...line,
            netPrice: null,
            discountPercent: null,
          })),
        }),
      ),
    ).toBe(JSON.stringify(buildSalesOrderBody(ordinary)));
  });

  it("does not apply when the order has its own partner", () => {
    expect(
      partnerPricingForOrder({ pricing: PRICING, hasOrderOverride: true }),
    ).toBeNull();
    expect(
      partnerPricingForOrder({ pricing: PRICING, hasOrderOverride: false }),
    ).toEqual(PRICING);
    expect(
      partnerPricingForOrder({ pricing: null, hasOrderOverride: false }),
    ).toBeNull();
  });
});

describe("reading a pricelist's net price", () => {
  const AT = new Date("2026-11-27T10:00:00Z");

  const entry = (
    overrides: Partial<PricelistEntry> & { price?: string },
  ): PricelistEntry => ({
    count_code: overrides.count_code ?? "4",
    valid_from: overrides.valid_from ?? "2025-11-01+02:00",
    sales_purchase: overrides.sales_purchase ?? "sales",
    price_def: overrides.price_def ?? [{ price: overrides.price ?? "32,5" }],
  });

  it("reads a decimal comma as a dot", () => {
    expect(pricelistNetPrice([entry({})], "4", AT)).toBe("32.5");
    expect(pricelistNetPrice([entry({ price: "1.234,50" })], "4", AT)).toBe(
      "1234.50",
    );
  });

  it("takes the latest valid_from that is not in the future", () => {
    const entries = [
      entry({ valid_from: "2024-11-01+01:00", price: "30" }),
      entry({ valid_from: "2025-11-01+02:00", price: "32,5" }),
      entry({ valid_from: "2027-01-01+01:00", price: "35" }),
    ];
    expect(pricelistNetPrice(entries, "4", AT)).toBe("32.5");
  });

  it("counts a price valid from today", () => {
    expect(
      pricelistNetPrice(
        [entry({ valid_from: "2026-11-27+01:00", price: "33" })],
        "4",
        AT,
      ),
    ).toBe("33");
  });

  it("ignores other pricelists, purchase prices and gross-only entries", () => {
    expect(
      pricelistNetPrice(
        [
          entry({ count_code: "1", price: "49" }),
          entry({ sales_purchase: "purchase", price: "20" }),
          entry({ price_def: [{}] }),
        ],
        "4",
        AT,
      ),
    ).toBeNull();
  });

  it("pages through the whole catalogue", async () => {
    const page = (from: number, count: number) => ({
      opr_code: "0",
      product_list: Array.from({ length: count }, (_, index) => ({
        code: `SKU-${from + index}`,
        pricelist: [
          {
            count_code: "4",
            title: "Partner price 2026",
            price_def: { tax: "EX4", tax_desc: "22", price: "10,5" },
            valid_from: "2025-11-01+02:00",
            sales_purchase: "sales",
            currency_code: "EUR",
          },
        ],
      })),
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(page(0, 100)))
      .mockResolvedValueOnce(Response.json(page(100, 3)));
    const client = new MetakockaClient(
      { companyId: "16", secretKey: "secret" },
      { fetchImpl, timeoutMs: 1000 },
    );

    const prices = await readPricelistNetPrices(client, "4", AT);

    expect(prices.size).toBe(103);
    expect(prices.get("SKU-102")).toBe("10.5");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("the price cache", () => {
  beforeEach(() => clearPartnerPriceCache());

  const pageWith = (codes: string[]) =>
    Response.json({
      opr_code: "0",
      product_list: codes.map((code) => ({
        code,
        pricelist: [{ count_code: "4", price_def: { price: "32,5" } }],
      })),
    });

  it("reads the catalogue once for a burst of orders", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => pageWith(["A", "B"]));
    const client = new MetakockaClient(
      { companyId: "16", secretKey: "secret" },
      { fetchImpl, timeoutMs: 1000 },
    );
    const now = new Date("2026-11-27T10:00:00Z");

    for (const sku of ["A", "B", "A"]) {
      const result = await partnerNetPrices({
        shopDomain: "lisa.myshopify.com",
        client,
        pricelistCode: "4",
        skus: [sku],
        now,
      });
      expect(result.missing).toEqual([]);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Eleven minutes later it is read again.
    await partnerNetPrices({
      shopDomain: "lisa.myshopify.com",
      client,
      pricelistCode: "4",
      skus: ["A"],
      now: new Date(now.getTime() + 11 * 60 * 1000),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("names the SKUs the pricelist does not price", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => pageWith(["A"]));
    const client = new MetakockaClient(
      { companyId: "16", secretKey: "secret" },
      { fetchImpl, timeoutMs: 1000 },
    );

    const result = await partnerNetPrices({
      shopDomain: "lisa.myshopify.com",
      client,
      pricelistCode: "4",
      skus: ["A", "B", "C", "B"],
      now: new Date("2026-11-27T10:00:00Z"),
    });
    expect(result.missing).toEqual(["B", "C"]);
  });
});

describe("a written document keeps the prices it was sent with", () => {
  const sent = buildSalesOrderBody(
    applyPartnerPricing(
      retailOrder(),
      PRICING,
      new Map([["L12260002101", { price: "32.5", discount: "20" }]]),
    ),
  );
  const recorded: unknown = JSON.parse(JSON.stringify(sent));

  it("reads them back from the recorded body", () => {
    const frozen = frozenPartnerPrices(recorded, "4");
    expect(frozen.get("L12260002101")).toEqual({
      price: "32.5",
      discount: "20",
    });
    expect(unpricedSkus(["L12260002101", "NEW"], frozen)).toEqual(["NEW"]);
  });

  it("does not freeze a body that was not partner-priced", () => {
    expect(frozenPartnerPrices(recorded, "5").size).toBe(0);
    expect(
      frozenPartnerPrices(buildSalesOrderBody(retailOrder()), "1").size,
    ).toBe(0);
  });

  it("rebuilds to the same content, so nothing is rewritten", () => {
    const rebuilt = buildSalesOrderBody(
      applyPartnerPricing(
        retailOrder(),
        PRICING,
        frozenPartnerPrices(recorded, "4"),
      ),
    );
    expect(sameDocument(contentOnly(recorded), contentOnly(rebuilt))).toBe(
      true,
    );
  });

  it("does not count a changed title as a change to the order", () => {
    const retitled = { ...sent, title: "LISA order #2035" };
    expect(sameDocument(contentOnly(sent), contentOnly(retitled))).toBe(true);
  });
});

describe("VAT under partner pricing", () => {
  const french: NormalizedOrderTax = {
    currency: "EUR",
    taxesIncluded: true,
    totalTaxMinor: 982,
    orderTaxLines: [],
    destinationCountry: "FR",
    billingCountry: "FR",
    customer: { isBusiness: false, vatNumber: null, taxExempt: false },
    lines: [
      {
        lineId: "line-1",
        sku: "L12260002101",
        quantity: 1,
        unitPriceMinor: 4900,
        discountMinor: 0,
        taxable: true,
        taxLines: [{ rateKey: "20", amountMinor: 817, title: "FR TVA" }],
      },
    ],
    shipping: {
      amountMinor: 990,
      taxLines: [{ rateKey: "20", amountMinor: 165, title: "FR TVA" }],
    },
  };

  const config: TaxConfig = {
    version: 1,
    domesticCountry: "SI",
    domesticRateKey: "22",
    fallbackScope: "domestic",
    nonEuNoTaxPolicy: "review",
    ossEnabled: false,
    registrations: [
      { kind: "domestic", country: "SI", vatNumber: null, enabled: true },
    ],
    countryRates: effectiveCountryRates([]),
    mappings: [{ rateKey: "22", metakockaTaxFactor: "0.22", enabled: true }],
    overrides: [],
  };

  it("would hold the order as a French consumer sale without OSS", () => {
    expect(decideOrderTax(french, config).ok).toBe(false);
  });

  it("is a zero-rated decision that says why", () => {
    const decision = decidePartnerPricedTax(french, config, PRICING);

    expect(decision.ok).toBe(true);
    expect(decision.issues).toEqual([]);
    expect(decision.treatment).toBe("MANUAL_OVERRIDE");
    expect(decision.shipping).toBeNull();
    expect(decision.lines).toHaveLength(1);
    expect(decision.lines[0]).toMatchObject({
      lineId: "line-1",
      metakockaTaxFactor: "0",
      taxMinor: 0,
      rateKey: "0",
    });
    expect(decision.lines[0]?.zeroReason).toContain("pricelist 4");
    // Still says what Shopify charged the end buyer, for the record.
    expect(decision.destinationCountry).toBe("FR");
    expect(decision.totals.shopifyTaxMinor).toBe(982);
  });
});

describe("verifying a partner-priced order", () => {
  const line: CanonicalLine = {
    shopifyLineItemId: "line-1",
    sku: "L12260002101",
    title: "Board bag",
    quantity: 1,
    unitPriceWithTaxMinor: 4900,
    discountMinor: 0,
    taxFactor: "0",
  };
  const classification = classifyQuantities(
    [line],
    [
      {
        shopifyLocationId: null,
        supplySourceId: null,
        disposition: "managed",
        lines: [{ shopifyLineItemId: "line-1", quantity: 1 }],
      },
    ],
  );
  const document = (amount: number) => ({
    countCode: "1209/2026",
    retired: false,
    requestBody: buildSalesOrderBody(
      applyPartnerPricing(
        {
          ...retailOrder(),
          lines: [{ ...retailOrder().lines[0]!, amount }],
        },
        PRICING,
        new Map([["L12260002101", { price: "32.5", discount: "20" }]]),
      ),
    ),
  });
  const verify = (amount: number, partnerPricing: boolean) =>
    verifyOrder({
      lines: [line],
      classification,
      documents: [document(amount)],
      orderTotalMinor: 5890,
      shippingMinor: 990,
      orderDiscountMinor: 0,
      grossReceivedMinor: 5890,
      representedPaymentMinor: 0,
      partnerPricing,
    });

  it("does not compare its value with the Shopify total", () => {
    expect(verify(1, false).ok).toBe(false);
    const result = verify(1, true);
    expect(result.ok).toBe(true);
    expect(result.payments.ok).toBe(true);
  });

  it("still checks the quantities", () => {
    const result = verify(2, true);
    expect(result.ok).toBe(false);
    expect(result.quantities.ok).toBe(false);
  });
});

describe("the settings", () => {
  it("accepts a percent and canonicalises it", () => {
    expect(parseDiscountPercent("20")).toBe("20");
    expect(parseDiscountPercent(" 12,50 % ")).toBe("12.5");
    expect(parseDiscountPercent("")).toBeNull();
    expect(parseDiscountPercent("100")).toBe("invalid");
    expect(parseDiscountPercent("-5")).toBe("invalid");
    expect(parseDiscountPercent("1e2")).toBe("invalid");
  });

  it("renders the title, and sends none for an empty pattern", () => {
    const context = {
      name: "#2035",
      number: "2035",
      id: "1",
      customerEmail: null,
    };
    expect(documentTitleFor("LISA {order.name}", context)).toBe("LISA #2035");
    expect(documentTitleFor(null, context)).toBeNull();
    expect(documentTitleFor("{customer.email}", context)).toBeNull();
  });
});
