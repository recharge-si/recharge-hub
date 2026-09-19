import { describe, expect, it } from "vitest";

import { effectiveCountryRates } from "~/domain/tax/config";
import { decideOrderTax } from "~/domain/tax/decide";
import { computeTaxDiagnostics, requiredRates } from "~/domain/tax/diagnostics";
import { reverseTaxForRefund } from "~/domain/tax/refunds";
import type { NormalizedOrderTax, TaxConfig } from "~/domain/tax/types";

const AT_ORDER: NormalizedOrderTax = {
  currency: "EUR",
  taxesIncluded: true,
  totalTaxMinor: 4110,
  orderTaxLines: [],
  destinationCountry: "AT",
  billingCountry: "AT",
  customer: { isBusiness: false, vatNumber: null, taxExempt: false },
  lines: [
    {
      lineId: "L1",
      sku: "MAST",
      quantity: 2,
      unitPriceMinor: 12000,
      discountMinor: 0,
      taxable: true,
      taxLines: [{ rateKey: "20", amountMinor: 4000, title: "AT VAT" }],
    },
  ],
  shipping: {
    amountMinor: 660,
    taxLines: [{ rateKey: "20", amountMinor: 110, title: "AT VAT" }],
  },
};

const OSS_2026: TaxConfig = {
  version: 7,
  domesticCountry: "SI",
  domesticRateKey: "22",
  fallbackScope: "domestic",
  nonEuNoTaxPolicy: "review",
  ossEnabled: true,
  registrations: [
    { kind: "oss", country: "SI", vatNumber: "SI12345678", enabled: true },
  ],
  countryRates: effectiveCountryRates([]),
  mappings: [
    { rateKey: "0", metakockaTaxFactor: "0", enabled: true },
    { rateKey: "22", metakockaTaxFactor: "0.22", enabled: true },
    { rateKey: "20", metakockaTaxFactor: "0.2", enabled: true },
  ],
  overrides: [],
};

describe("a refund reverses the original treatment", () => {
  const decision = decideOrderTax(AT_ORDER, OSS_2026);
  const quantities = new Map([["L1", 2]]);

  it("was an OSS sale at 20% when it happened", () => {
    expect(decision.ok).toBe(true);
    expect(decision.treatment).toBe("EU_OSS");
    expect(decision.configVersion).toBe(7);
  });

  it("uses Shopify's refunded amounts when it states them", () => {
    const breakdown = reverseTaxForRefund(decision, quantities, {
      refundId: "R1",
      createdAt: "2027-03-01T10:00:00Z",
      totalRefundedMinor: 12000,
      lines: [
        { lineId: "L1", quantity: 1, subtotalMinor: 12000, taxMinor: 2000 },
      ],
      shipping: null,
    });

    expect(breakdown.configVersion).toBe(7);
    expect(breakdown.entries[0]).toMatchObject({
      rateKey: "20",
      treatment: "EU_OSS",
      taxableMinor: 10000,
      taxMinor: 2000,
      basis: "shopify",
    });
    expect(breakdown.totals).toEqual([
      {
        rateKey: "20",
        treatment: "EU_OSS",
        taxableMinor: 10000,
        taxMinor: 2000,
      },
    ]);
  });

  it("takes a quantity share of the snapshot when Shopify states nothing", () => {
    const breakdown = reverseTaxForRefund(decision, quantities, {
      refundId: "R2",
      createdAt: null,
      totalRefundedMinor: 12000,
      lines: [
        { lineId: "L1", quantity: 1, subtotalMinor: null, taxMinor: null },
      ],
      shipping: { amountMinor: 660, taxMinor: null },
    });

    expect(breakdown.entries[0]).toMatchObject({
      taxableMinor: 10000,
      taxMinor: 2000,
      basis: "snapshot",
    });
    expect(breakdown.shipping).toMatchObject({
      taxableMinor: 550,
      taxMinor: 110,
      treatment: "EU_OSS",
    });
    expect(breakdown.totalTaxMinor).toBe(2110);
  });

  it("is decided from the snapshot even after the configuration has moved on", () => {
    // Six months later Austria is at a different rate and OSS has been switched
    // off. The refund still reverses 20% OSS, because the decision says so.
    const breakdown = reverseTaxForRefund(decision, quantities, {
      refundId: "R3",
      createdAt: null,
      totalRefundedMinor: 24000,
      lines: [
        { lineId: "L1", quantity: 2, subtotalMinor: null, taxMinor: null },
      ],
      shipping: null,
    });
    expect(breakdown.totals[0]).toMatchObject({
      rateKey: "20",
      treatment: "EU_OSS",
      taxMinor: 4000,
    });
  });

  it("reports a refund line the snapshot has no decision for rather than guessing", () => {
    const breakdown = reverseTaxForRefund(decision, quantities, {
      refundId: "R4",
      createdAt: null,
      totalRefundedMinor: 100,
      lines: [{ lineId: "L9", quantity: 1, subtotalMinor: 100, taxMinor: 0 }],
      shipping: null,
    });
    expect(breakdown.entries).toEqual([]);
    expect(breakdown.unmatchedLineIds).toEqual(["L9"]);
  });
});

describe("diagnostics", () => {
  it("reads READY when everything in use is mapped", () => {
    const diagnostics = computeTaxDiagnostics({
      config: OSS_2026,
      observed: [
        { rateKey: "20", orders: 3, countries: ["AT"], lastSeenAt: null },
      ],
      openExceptions: [],
      recentWarnings: [],
      decidedOrders: 3,
    });

    expect(diagnostics.status).toBe("ready");
    expect(diagnostics.unmappedRates).toEqual([]);
    expect(
      diagnostics.checks.map((check) => [check.key, check.status]),
    ).toEqual([
      ["domestic", "ok"],
      ["oss", "ok"],
      ["registrations", "ok"],
      ["mappings", "ok"],
      ["fallback", "ok"],
      ["exceptions", "ok"],
    ]);
    expect(diagnostics.checks[0]?.summary).toBe("Slovenia 22%");
    expect(diagnostics.checks[1]?.summary).toBe(
      "Enabled, identified in Slovenia",
    );
  });

  it("names an observed rate with no mapping and points at the mapping page", () => {
    const diagnostics = computeTaxDiagnostics({
      config: OSS_2026,
      observed: [
        { rateKey: "9.5", orders: 2, countries: ["SI"], lastSeenAt: null },
      ],
      openExceptions: [{ kind: "tax_mapping_missing", count: 2 }],
      recentWarnings: [],
      decidedOrders: 5,
    });

    expect(diagnostics.status).toBe("needs_attention");
    expect(diagnostics.unmappedRates).toEqual(["9.5"]);
    const mappings = diagnostics.checks.find(
      (check) => check.key === "mappings",
    );
    expect(mappings?.status).toBe("attention");
    expect(mappings?.reason).toContain("Orders use 9.5%");
    expect(mappings?.action).toEqual({
      label: "Configure mapping",
      href: "/app/settings/taxes/mappings",
    });
    expect(diagnostics.blockedOrders).toBe(2);
  });

  it("requires the home rate, zero and every override rate to be mapped before any order", () => {
    expect(requiredRates(OSS_2026)).toEqual(["0", "22"]);
    const missingDomestic = computeTaxDiagnostics({
      config: { ...OSS_2026, domesticRateKey: null },
      observed: [],
      openExceptions: [],
      recentWarnings: [],
      decidedOrders: 0,
    });
    expect(missingDomestic.checks[0]?.status).toBe("attention");
  });

  it("warns about a fallback that reaches the EU while OSS is on", () => {
    const diagnostics = computeTaxDiagnostics({
      config: { ...OSS_2026, fallbackScope: "eu" },
      observed: [],
      openExceptions: [],
      recentWarnings: [{ kind: "rate_mismatch", count: 1 }],
      decidedOrders: 1,
    });
    expect(diagnostics.status).toBe("ready");
    expect(
      diagnostics.checks.find((check) => check.key === "fallback")?.status,
    ).toBe("warning");
    expect(
      diagnostics.checks.find((check) => check.key === "warnings")?.status,
    ).toBe("warning");
  });
});
