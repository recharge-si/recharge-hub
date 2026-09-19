import { describe, expect, it } from "vitest";

import { effectiveCountryRates } from "~/domain/tax/config";
import { decideOrderTax } from "~/domain/tax/decide";
import type {
  NormalizedOrderTax,
  OrderLineTaxInput,
  TaxConfig,
  TaxLineInput,
} from "~/domain/tax/types";

/**
 * The tax engine, scenario by scenario (§57 of the brief).
 *
 * Every case is a Slovenian shop selling somewhere, with Shopify's transaction
 * tax as the input, and asserts three things: the rate and amounts the line is
 * filed with, the treatment it is classified as, and whether the order may be
 * sent at all. Nothing here reaches a database or a network.
 */

function tax(rateKey: string, amountMinor: number): TaxLineInput {
  return { rateKey, amountMinor, title: null };
}

function line(
  overrides: Partial<OrderLineTaxInput> & { lineId: string },
): OrderLineTaxInput {
  return {
    sku: `SKU-${overrides.lineId}`,
    quantity: 1,
    unitPriceMinor: 12200,
    discountMinor: 0,
    taxable: true,
    taxLines: [],
    ...overrides,
  };
}

function config(overrides: Partial<TaxConfig> = {}): TaxConfig {
  return {
    version: 3,
    domesticCountry: "SI",
    domesticRateKey: "22",
    fallbackScope: "domestic",
    nonEuNoTaxPolicy: "review",
    ossEnabled: false,
    registrations: [
      {
        kind: "domestic",
        country: "SI",
        vatNumber: "SI12345678",
        enabled: true,
      },
    ],
    countryRates: effectiveCountryRates([]),
    mappings: [
      { rateKey: "0", metakockaTaxFactor: "0", enabled: true },
      { rateKey: "22", metakockaTaxFactor: "0.22", enabled: true },
      { rateKey: "9.5", metakockaTaxFactor: "0.095", enabled: true },
      { rateKey: "20", metakockaTaxFactor: "0.2", enabled: true },
      { rateKey: "19", metakockaTaxFactor: "0.19", enabled: true },
      { rateKey: "25", metakockaTaxFactor: "0.25", enabled: true },
    ],
    overrides: [],
    ...overrides,
  };
}

function order(
  overrides: Partial<NormalizedOrderTax> = {},
): NormalizedOrderTax {
  const lines = overrides.lines ?? [
    line({ lineId: "1", taxLines: [tax("22", 2200)] }),
  ];
  const totalTaxMinor =
    overrides.totalTaxMinor ??
    lines.reduce(
      (sum, entry) =>
        sum + entry.taxLines.reduce((s, t) => s + t.amountMinor, 0),
      0,
    ) +
      (overrides.shipping?.taxLines?.reduce((s, t) => s + t.amountMinor, 0) ??
        0);

  return {
    currency: "EUR",
    taxesIncluded: true,
    orderTaxLines: [],
    destinationCountry: "SI",
    billingCountry: "SI",
    customer: { isBusiness: false, vatNumber: null, taxExempt: false },
    shipping: null,
    ...overrides,
    lines,
    totalTaxMinor,
  };
}

const blocking = (decision: ReturnType<typeof decideOrderTax>) =>
  decision.issues
    .filter((issue) => issue.severity === "blocking")
    .map((issue) => issue.kind);

describe("domestic and EU consumer sales", () => {
  it("SI consumer at 22%: Shopify's rate, Shopify's amounts, domestic VAT", () => {
    const decision = decideOrderTax(order(), config());

    expect(decision.ok).toBe(true);
    expect(decision.jurisdiction).toBe("domestic");
    expect(decision.customerKind).toBe("b2c");
    expect(decision.treatment).toBe("DOMESTIC_VAT");
    expect(decision.source).toBe("SHOPIFY");
    expect(decision.lines[0]).toMatchObject({
      rateKey: "22",
      taxMinor: 2200,
      taxableMinor: 10000,
      metakockaTaxFactor: "0.22",
      mapping: "mapped",
    });
    expect(decision.totals).toEqual({
      taxableMinor: 10000,
      taxMinor: 2200,
      shopifyTaxMinor: 2200,
      differenceMinor: 0,
      reconciled: true,
    });
    expect(decision.rateKeys).toEqual(["22"]);
  });

  it.each([
    ["AT", "20", 12000, 2000],
    ["DE", "19", 11900, 1900],
    ["HR", "25", 12500, 2500],
  ])(
    "%s consumer under OSS: destination VAT at %s%% is EU_OSS",
    (country, rate, gross, vat) => {
      const decision = decideOrderTax(
        order({
          destinationCountry: country,
          lines: [
            line({
              lineId: "1",
              unitPriceMinor: gross,
              taxLines: [tax(rate, vat)],
            }),
          ],
        }),
        config({ ossEnabled: true }),
      );

      expect(decision.ok).toBe(true);
      expect(decision.treatment).toBe("EU_OSS");
      expect(decision.lines[0]).toMatchObject({
        rateKey: rate,
        taxMinor: vat,
        taxableMinor: 10000,
        source: "SHOPIFY",
      });
    },
  );

  it("destination VAT with no OSS and no local registration is held, not guessed", () => {
    const decision = decideOrderTax(
      order({
        destinationCountry: "AT",
        lines: [
          line({
            lineId: "1",
            unitPriceMinor: 12000,
            taxLines: [tax("20", 2000)],
          }),
        ],
      }),
      config(),
    );

    expect(decision.ok).toBe(false);
    expect(blocking(decision)).toEqual(["registration_error"]);
    expect(decision.lines[0]?.treatment).toBe("UNKNOWN");
    expect(decision.issues[0]?.message).toContain("Austria VAT at 20%");
  });

  it("destination VAT under a local registration is EU_LOCAL_REGISTRATION", () => {
    const decision = decideOrderTax(
      order({
        destinationCountry: "DE",
        lines: [
          line({
            lineId: "1",
            unitPriceMinor: 11900,
            taxLines: [tax("19", 1900)],
          }),
        ],
      }),
      config({
        registrations: [
          { kind: "domestic", country: "SI", vatNumber: null, enabled: true },
          {
            kind: "local",
            country: "DE",
            vatNumber: "DE123456789",
            enabled: true,
          },
        ],
      }),
    );

    expect(decision.ok).toBe(true);
    expect(decision.treatment).toBe("EU_LOCAL_REGISTRATION");
  });

  it("the home rate charged to an EU consumer is a distance sale at origin VAT", () => {
    const decision = decideOrderTax(
      order({ destinationCountry: "AT" }),
      config(),
    );

    expect(decision.ok).toBe(true);
    expect(decision.treatment).toBe("EU_DISTANCE_SALE");
    expect(decision.lines[0]?.rateKey).toBe("22");
  });

  it("does not replace a surprising Shopify rate with the table's: Austria 10% is used and noted", () => {
    const decision = decideOrderTax(
      order({
        destinationCountry: "AT",
        lines: [
          line({
            lineId: "1",
            unitPriceMinor: 11000,
            taxLines: [tax("10", 1000)],
          }),
        ],
      }),
      config({
        ossEnabled: true,
        mappings: [
          ...config().mappings,
          { rateKey: "10", metakockaTaxFactor: "0.1", enabled: true },
        ],
      }),
    );

    // 10% is an Austrian reduced rate in the table, so no note at all.
    expect(decision.ok).toBe(true);
    expect(decision.lines[0]?.rateKey).toBe("10");
    expect(decision.lines[0]?.source).toBe("SHOPIFY");

    const unusual = decideOrderTax(
      order({
        destinationCountry: "AT",
        lines: [
          line({
            lineId: "1",
            unitPriceMinor: 11100,
            taxLines: [tax("11", 1100)],
          }),
        ],
      }),
      config({
        ossEnabled: true,
        mappings: [
          ...config().mappings,
          { rateKey: "11", metakockaTaxFactor: "0.11", enabled: true },
        ],
      }),
    );
    expect(unusual.ok).toBe(true);
    expect(unusual.lines[0]?.rateKey).toBe("11");
    expect(unusual.issues.map((issue) => [issue.kind, issue.severity])).toEqual(
      [["rate_mismatch", "warning"]],
    );
  });
});

describe("zero is not one thing", () => {
  it("EU business with a VAT number and no VAT charged is reverse charge, not export", () => {
    const decision = decideOrderTax(
      order({
        destinationCountry: "DE",
        customer: {
          isBusiness: true,
          vatNumber: "DE123456789",
          taxExempt: false,
        },
        lines: [line({ lineId: "1", unitPriceMinor: 10000, taxLines: [] })],
      }),
      config(),
    );

    expect(decision.ok).toBe(true);
    expect(decision.customerKind).toBe("b2b");
    expect(decision.treatment).toBe("EU_REVERSE_CHARGE");
    expect(decision.lines[0]).toMatchObject({
      rateKey: "0",
      taxMinor: 0,
      taxableMinor: 10000,
      metakockaTaxFactor: "0",
    });
    expect(decision.lines[0]?.zeroReason).toContain("DE123456789");
  });

  it("a VAT number alone does not make VAT zero: Shopify charged it, so it stands", () => {
    const decision = decideOrderTax(
      order({
        destinationCountry: "DE",
        customer: {
          isBusiness: true,
          vatNumber: "DE123456789",
          taxExempt: false,
        },
        lines: [
          line({
            lineId: "1",
            unitPriceMinor: 11900,
            taxLines: [tax("19", 1900)],
          }),
        ],
      }),
      config({ ossEnabled: true }),
    );

    expect(decision.ok).toBe(true);
    expect(decision.treatment).toBe("EU_OSS");
    expect(decision.lines[0]?.taxMinor).toBe(1900);
  });

  it("outside the EU with no tax charged waits for the export policy, then files at 0%", () => {
    const held = decideOrderTax(
      order({
        destinationCountry: "CH",
        lines: [line({ lineId: "1", unitPriceMinor: 10000 })],
      }),
      config(),
    );
    expect(held.ok).toBe(false);
    expect(blocking(held)).toEqual(["treatment_unknown"]);
    expect(held.issues[0]?.message).toContain("Switzerland");

    const exported = decideOrderTax(
      order({
        destinationCountry: "CH",
        lines: [line({ lineId: "1", unitPriceMinor: 10000 })],
      }),
      config({ nonEuNoTaxPolicy: "export" }),
    );
    expect(exported.ok).toBe(true);
    expect(exported.treatment).toBe("NON_EU_EXPORT");
    expect(exported.lines[0]?.rateKey).toBe("0");
  });

  it("an explicit 0% tax line outside the EU is an export whatever the policy says", () => {
    const decision = decideOrderTax(
      order({
        destinationCountry: "US",
        lines: [
          line({ lineId: "1", unitPriceMinor: 10000, taxLines: [tax("0", 0)] }),
        ],
      }),
      config(),
    );
    expect(decision.ok).toBe(true);
    expect(decision.treatment).toBe("NON_EU_EXPORT");
  });

  it("a tax-exempt buyer is TAX_EXEMPT", () => {
    const decision = decideOrderTax(
      order({
        customer: { isBusiness: false, vatNumber: null, taxExempt: true },
        lines: [
          line({ lineId: "1", unitPriceMinor: 10000, taxLines: [tax("0", 0)] }),
        ],
      }),
      config(),
    );
    expect(decision.ok).toBe(true);
    expect(decision.treatment).toBe("TAX_EXEMPT");
  });

  it("a non-taxable line is NO_TAX and needs the 0% mapping", () => {
    const decision = decideOrderTax(
      order({
        lines: [
          line({ lineId: "1", taxLines: [tax("22", 2200)] }),
          line({ lineId: "2", unitPriceMinor: 500, taxable: false }),
        ],
      }),
      config(),
    );
    expect(decision.ok).toBe(true);
    expect(decision.treatment).toBe("MIXED");
    expect(decision.lines[1]).toMatchObject({
      treatment: "NO_TAX",
      rateKey: "0",
      metakockaTaxFactor: "0",
    });

    const unmappedZero = decideOrderTax(
      order({
        lines: [line({ lineId: "2", unitPriceMinor: 500, taxable: false })],
      }),
      config({
        mappings: config().mappings.filter((row) => row.rateKey !== "0"),
      }),
    );
    expect(unmappedZero.ok).toBe(false);
    expect(blocking(unmappedZero)).toEqual(["mapping_missing"]);
  });

  it("an explicit 0% on a domestic sale is zero-rated goods", () => {
    const decision = decideOrderTax(
      order({
        lines: [
          line({ lineId: "1", unitPriceMinor: 10000, taxLines: [tax("0", 0)] }),
        ],
      }),
      config(),
    );
    expect(decision.ok).toBe(true);
    expect(decision.treatment).toBe("ZERO_RATED");
  });
});

describe("when Shopify charges no tax at all", () => {
  it("a home sale takes the configured home rate, computed decimal-safe on the gross", () => {
    const decision = decideOrderTax(
      order({ lines: [line({ lineId: "1", unitPriceMinor: 20900 })] }),
      config(),
    );

    expect(decision.ok).toBe(true);
    expect(decision.treatment).toBe("DOMESTIC_VAT");
    expect(decision.source).toBe("COUNTRY_DEFAULT");
    // 209.00 gross at 22% → 171.31 net, 37.69 VAT (docs/metakocka-verification.md).
    expect(decision.lines[0]).toMatchObject({
      rateKey: "22",
      taxableMinor: 17131,
      taxMinor: 3769,
      metakockaTaxFactor: "0.22",
    });
    // Not comparable to Shopify's zero, so not a reconciliation failure.
    expect(decision.totals.reconciled).toBe(true);
  });

  it("on a tax-exclusive shop the same fallback is computed on the net", () => {
    const decision = decideOrderTax(
      order({
        taxesIncluded: false,
        lines: [line({ lineId: "1", unitPriceMinor: 17131 })],
      }),
      config(),
    );
    expect(decision.lines[0]).toMatchObject({
      taxableMinor: 17131,
      taxMinor: 3769,
    });
  });

  it("an EU consumer sale takes the home rate only when the fallback reaches the EU", () => {
    const held = decideOrderTax(
      order({
        destinationCountry: "AT",
        lines: [line({ lineId: "1", unitPriceMinor: 10000 })],
      }),
      config({ fallbackScope: "domestic" }),
    );
    expect(held.ok).toBe(false);
    expect(blocking(held)).toEqual(["treatment_unknown"]);
    expect(held.issues[0]?.message).toContain("cross-border EU");

    const origin = decideOrderTax(
      order({
        destinationCountry: "AT",
        lines: [line({ lineId: "1", unitPriceMinor: 10000 })],
      }),
      config({ fallbackScope: "eu" }),
    );
    expect(origin.ok).toBe(true);
    expect(origin.treatment).toBe("EU_DISTANCE_SALE");
    expect(origin.lines[0]?.source).toBe("COUNTRY_DEFAULT");
  });

  it("with no home rate configured the order is held", () => {
    const decision = decideOrderTax(
      order({ lines: [line({ lineId: "1", unitPriceMinor: 10000 })] }),
      config({ domesticRateKey: null }),
    );
    expect(decision.ok).toBe(false);
    expect(decision.issues[0]?.message).toContain("no home VAT rate");
  });

  it("never stands in when tax was charged elsewhere on the order", () => {
    const decision = decideOrderTax(
      order({
        lines: [
          line({ lineId: "1", taxLines: [tax("22", 2200)] }),
          line({ lineId: "2", unitPriceMinor: 5000, taxLines: [] }),
        ],
      }),
      config(),
    );
    expect(decision.ok).toBe(false);
    expect(blocking(decision)).toEqual(["data_insufficient"]);
    expect(decision.lines[1]?.treatment).toBe("UNKNOWN");
  });

  it("a missing destination is a blocking gap, not a home sale", () => {
    const decision = decideOrderTax(
      order({
        destinationCountry: null,
        billingCountry: null,
        lines: [line({ lineId: "1", unitPriceMinor: 10000 })],
      }),
      config(),
    );
    expect(decision.ok).toBe(false);
    expect(blocking(decision)).toEqual(["destination_missing"]);
    expect(decision.jurisdiction).toBe("unknown");
  });
});

describe("mixed rates, discounts and shipping", () => {
  it("keeps each line at its own rate and never invents an order-level one", () => {
    const decision = decideOrderTax(
      order({
        lines: [
          line({
            lineId: "a",
            unitPriceMinor: 12200,
            taxLines: [tax("22", 2200)],
          }),
          line({
            lineId: "b",
            unitPriceMinor: 10950,
            taxLines: [tax("9.5", 950)],
          }),
          line({
            lineId: "c",
            unitPriceMinor: 10500,
            taxLines: [tax("5", 500)],
          }),
        ],
      }),
      config({
        mappings: [
          ...config().mappings,
          { rateKey: "5", metakockaTaxFactor: "0.05", enabled: true },
        ],
      }),
    );

    expect(decision.ok).toBe(true);
    expect(decision.treatment).toBe("DOMESTIC_VAT");
    expect(decision.rateKeys).toEqual(["5", "9.5", "22"]);
    expect(
      decision.lines.map((entry) => [entry.rateKey, entry.metakockaTaxFactor]),
    ).toEqual([
      ["22", "0.22"],
      ["9.5", "0.095"],
      ["5", "0.05"],
    ]);
    expect(decision.totals.taxMinor).toBe(3650);
  });

  it("taxes a discounted line on what the customer paid after the discount", () => {
    const decision = decideOrderTax(
      order({
        lines: [
          line({
            lineId: "1",
            quantity: 2,
            unitPriceMinor: 12200,
            discountMinor: 2440,
            taxLines: [tax("22", 3960)],
          }),
        ],
      }),
      config(),
    );
    expect(decision.lines[0]).toMatchObject({
      taxableMinor: 18000,
      taxMinor: 3960,
    });
  });

  it("a 100% discounted line is free and blocks nothing", () => {
    const decision = decideOrderTax(
      order({
        lines: [
          line({ lineId: "1", taxLines: [tax("22", 2200)] }),
          line({
            lineId: "free",
            unitPriceMinor: 3000,
            discountMinor: 3000,
            taxLines: [],
          }),
        ],
      }),
      config(),
    );
    expect(decision.ok).toBe(true);
    expect(decision.lines[1]).toMatchObject({
      taxMinor: 0,
      taxableMinor: 0,
      rateKey: "0",
    });
  });

  it("taxed shipping uses Shopify's own shipping tax lines", () => {
    const decision = decideOrderTax(
      order({
        shipping: { amountMinor: 610, taxLines: [tax("22", 110)] },
      }),
      config(),
    );
    expect(decision.ok).toBe(true);
    expect(decision.shipping).toMatchObject({
      rateKey: "22",
      taxMinor: 110,
      taxableMinor: 500,
      source: "SHOPIFY",
      treatment: "DOMESTIC_VAT",
    });
    expect(decision.totals.taxMinor).toBe(2310);
  });

  it("untaxed shipping on a taxed order stays untaxed rather than borrowing a product rate", () => {
    const decision = decideOrderTax(
      order({ shipping: { amountMinor: 500, taxLines: [] } }),
      config(),
    );
    expect(decision.ok).toBe(true);
    expect(decision.shipping).toMatchObject({
      rateKey: "0",
      taxMinor: 0,
      treatment: "NO_TAX",
    });
  });

  it("shipping tax reported only in the order total is derived when one rate explains it exactly", () => {
    const decision = decideOrderTax(
      order({
        shipping: { amountMinor: 610, taxLines: null },
        totalTaxMinor: 2310,
      }),
      config(),
    );
    expect(decision.ok).toBe(true);
    expect(decision.shipping).toMatchObject({
      rateKey: "22",
      taxMinor: 110,
      source: "FALLBACK",
    });
    expect(decision.totals.reconciled).toBe(true);
  });

  it("shipping tax nothing explains is a blocking gap", () => {
    const decision = decideOrderTax(
      order({
        shipping: { amountMinor: 610, taxLines: null },
        totalTaxMinor: 2300,
      }),
      config(),
    );
    expect(decision.ok).toBe(false);
    expect(blocking(decision)).toEqual(["data_insufficient"]);
  });

  it("shipping follows the taxable goods, not a non-taxable gift card beside them", () => {
    const decision = decideOrderTax(
      order({
        lines: [
          line({ lineId: "1", unitPriceMinor: 20900 }),
          line({ lineId: "gift", unitPriceMinor: 5000, taxable: false }),
        ],
        shipping: { amountMinor: 610, taxLines: [] },
      }),
      config(),
    );
    expect(decision.ok).toBe(true);
    expect(decision.shipping).toMatchObject({
      rateKey: "22",
      taxMinor: 110,
      treatment: "DOMESTIC_VAT",
    });
  });

  it("shipping with nothing to inherit from is a blocking gap, never an invented rate", () => {
    const decision = decideOrderTax(
      order({
        lines: [
          line({ lineId: "1", sku: "A", unitPriceMinor: 20900 }),
          line({ lineId: "2", sku: "B", unitPriceMinor: 10000 }),
        ],
        shipping: { amountMinor: 610, taxLines: [] },
      }),
      config({
        overrides: [
          {
            id: "o",
            scope: "sku",
            match: "B",
            treatment: null,
            rateKey: "9.5",
            reason: "books",
            enabled: true,
          },
        ],
      }),
    );
    expect(decision.ok).toBe(false);
    expect(blocking(decision)).toEqual(["data_insufficient"]);
    expect(decision.shipping?.metakockaTaxFactor).toBeNull();
  });

  it("shipping follows the goods when nothing on the order was taxed", () => {
    const decision = decideOrderTax(
      order({
        lines: [line({ lineId: "1", unitPriceMinor: 20900 })],
        shipping: { amountMinor: 610, taxLines: [] },
      }),
      config(),
    );
    expect(decision.ok).toBe(true);
    expect(decision.shipping).toMatchObject({
      rateKey: "22",
      taxMinor: 110,
      source: "FALLBACK",
      treatment: "DOMESTIC_VAT",
    });
  });
});

describe("mapping and reconciliation", () => {
  it("an unmapped rate is the one exception it should be, naming the rate", () => {
    const decision = decideOrderTax(
      order({
        lines: [
          line({
            lineId: "1",
            unitPriceMinor: 10950,
            taxLines: [tax("9.5", 950)],
          }),
        ],
      }),
      config({
        mappings: config().mappings.filter((row) => row.rateKey !== "9.5"),
      }),
    );

    expect(decision.ok).toBe(false);
    expect(blocking(decision)).toEqual(["mapping_missing"]);
    expect(decision.lines[0]).toMatchObject({
      mapping: "missing",
      metakockaTaxFactor: null,
    });
    expect(decision.issues[0]?.message).toBe(
      "line SKU-1 uses a VAT rate of 9.5%, but no MetaKocka mapping exists for 9.5%. Map it on the Taxes & VAT page before orders using this rate can be sent.",
    );
  });

  it("the mapped factor is what the merchant configured, not a recomputation", () => {
    const decision = decideOrderTax(
      order(),
      config({
        mappings: [
          { rateKey: "22", metakockaTaxFactor: "0.2200", enabled: true },
        ],
      }),
    );
    expect(decision.lines[0]?.metakockaTaxFactor).toBe("0.2200");
  });

  it("holds an order whose line taxes do not add up to Shopify's total", () => {
    const decision = decideOrderTax(order({ totalTaxMinor: 2800 }), config());
    expect(decision.ok).toBe(false);
    expect(blocking(decision)).toEqual(["reconciliation_failed"]);
    expect(decision.totals).toMatchObject({
      differenceMinor: -600,
      reconciled: false,
    });
  });

  it("allows a cent of rounding per taxed line and no more", () => {
    const within = decideOrderTax(order({ totalTaxMinor: 2201 }), config());
    expect(within.ok).toBe(true);

    const beyond = decideOrderTax(order({ totalTaxMinor: 2203 }), config());
    expect(beyond.ok).toBe(false);
  });

  it("records the configuration version it was decided under", () => {
    expect(decideOrderTax(order(), config({ version: 41 })).configVersion).toBe(
      41,
    );
  });
});

describe("overrides", () => {
  it("a country override answers an unknown zero, visibly", () => {
    const decision = decideOrderTax(
      order({
        destinationCountry: "CH",
        lines: [line({ lineId: "1", unitPriceMinor: 10000 })],
      }),
      config({
        overrides: [
          {
            id: "ovr-ch",
            scope: "country",
            match: "CH",
            treatment: "NON_EU_EXPORT",
            rateKey: null,
            reason: "Goods leave the EU through the Swiss agent",
            enabled: true,
          },
        ],
      }),
    );

    expect(decision.ok).toBe(true);
    expect(decision.treatment).toBe("NON_EU_EXPORT");
    expect(decision.lines[0]).toMatchObject({
      rateKey: "0",
      overrideId: "ovr-ch",
    });
    expect(decision.lines[0]?.zeroReason).toContain("Swiss agent");
  });

  it("a SKU override sets the rate and is recorded as a product rule", () => {
    const decision = decideOrderTax(
      order({
        lines: [
          line({
            lineId: "1",
            sku: "BOOK-1",
            unitPriceMinor: 10950,
            taxLines: [tax("22", 1975)],
          }),
        ],
      }),
      config({
        overrides: [
          {
            id: "ovr-book",
            scope: "sku",
            match: "BOOK-1",
            treatment: null,
            rateKey: "9.5",
            reason: "Printed books are at the reduced rate",
            enabled: true,
          },
        ],
      }),
    );

    expect(decision.ok).toBe(true);
    expect(decision.lines[0]).toMatchObject({
      rateKey: "9.5",
      source: "PRODUCT_RULE",
      taxMinor: 950,
      taxableMinor: 10000,
      overrideId: "ovr-book",
      treatment: "DOMESTIC_VAT",
    });
    // A rate override is this app's arithmetic, so Shopify's total is not compared.
    expect(decision.totals.reconciled).toBe(true);
  });

  it("a disabled override does nothing", () => {
    const decision = decideOrderTax(
      order({
        destinationCountry: "CH",
        lines: [line({ lineId: "1", unitPriceMinor: 10000 })],
      }),
      config({
        overrides: [
          {
            id: "ovr-ch",
            scope: "country",
            match: "CH",
            treatment: "NON_EU_EXPORT",
            rateKey: null,
            reason: "old",
            enabled: false,
          },
        ],
      }),
    );
    expect(decision.ok).toBe(false);
  });

  it("a treatment override cannot paper over tax Shopify charged without a breakdown", () => {
    const decision = decideOrderTax(
      order({
        lines: [
          line({ lineId: "1", taxLines: [tax("22", 2200)] }),
          line({ lineId: "2", sku: "X", unitPriceMinor: 5000, taxLines: [] }),
        ],
      }),
      config({
        overrides: [
          {
            id: "o",
            scope: "sku",
            match: "X",
            treatment: "ZERO_RATED",
            rateKey: null,
            reason: "r",
            enabled: true,
          },
        ],
      }),
    );
    expect(decision.ok).toBe(false);
    expect(blocking(decision)).toEqual(["data_insufficient"]);
  });
});

describe("multi-currency", () => {
  it("carries the presentment currency through and never mixes it", () => {
    const decision = decideOrderTax(
      order({
        currency: "USD",
        destinationCountry: "US",
        lines: [
          line({ lineId: "1", unitPriceMinor: 10000, taxLines: [tax("0", 0)] }),
        ],
      }),
      config(),
    );
    expect(decision.currency).toBe("USD");
    expect(decision.treatment).toBe("NON_EU_EXPORT");
  });
});
