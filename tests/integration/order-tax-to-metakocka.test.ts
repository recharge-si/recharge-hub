import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildSalesOrderBody } from "~/adapters/metakocka/documents";
import { parseOrder, type ParsedOrder } from "~/adapters/shopify/order-payload";
import { splitOrderMoney } from "~/domain/money/split";
import { effectiveCountryRates } from "~/domain/tax/config";
import { decideOrderTax } from "~/domain/tax/decide";
import { reverseTaxForRefund } from "~/domain/tax/refunds";
import type { TaxConfig, TaxDecision } from "~/domain/tax/types";

/**
 * The tax pipeline, end to end and off the network (§58 of the brief):
 *
 * ```text
 * recorded Shopify webhook
 *   → parseOrder (Shopify adapter, normalises the tax)
 *   → decideOrderTax (domain, classifies and maps)
 *   → splitOrderMoney (domain, one document per warehouse)
 *   → buildSalesOrderBody (MetaKocka adapter, price basis + tax_factor)
 *   → the exact request body, asserted field by field
 * ```
 *
 * The seam this protects is the one no single-module test sees: that the
 * parser's normalised tax is what the engine consumes, that the engine's
 * mapped factor is what the document builder sends, and that a split order
 * keeps every line at its own rate on whichever document it lands on.
 */

const PAYLOAD: unknown = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "tests/fixtures/shopify/orders_create_mixed_tax.json"),
    "utf8",
  ),
);

/** A Slovenian shop with a German registration, all rates in use mapped. */
function config(overrides: Partial<TaxConfig> = {}): TaxConfig {
  return {
    version: 12,
    domesticCountry: "SI",
    domesticRateKey: "22",
    fallbackScope: "domestic",
    nonEuNoTaxPolicy: "review",
    ossEnabled: true,
    registrations: [
      { kind: "domestic", country: "SI", vatNumber: "SI12345678", enabled: true },
      { kind: "oss", country: "SI", vatNumber: null, enabled: true },
    ],
    countryRates: effectiveCountryRates([]),
    mappings: [
      { rateKey: "0", metakockaTaxFactor: "0", enabled: true },
      { rateKey: "22", metakockaTaxFactor: "0.22", enabled: true },
      { rateKey: "9.5", metakockaTaxFactor: "0.095", enabled: true },
    ],
    overrides: [],
    ...overrides,
  };
}

/**
 * What the write job does with a decision: one body per warehouse, each line
 * carrying the factor the decision mapped for it, shipping on its own line
 * with its own factor.
 */
function bodiesFor(
  order: ParsedOrder,
  decision: TaxDecision,
  allocation: Record<string, { own: number; partner: number }>,
) {
  const factorFor = (lineId: string) =>
    decision.lines.find((line) => line.lineId === lineId)?.metakockaTaxFactor ?? null;

  const perSource = (["own", "partner"] as const).map((source) => ({
    sourceId: source,
    sourceCode: source === "own" ? "GLAVNO" : "PARTNER1",
    kind: source,
    lineTotalMinor: order.lines.reduce(
      (sum, line) =>
        sum + (allocation[line.shopifyLineItemId]?.[source] ?? 0) * line.unitPriceWithTaxMinor,
      0,
    ),
  }));

  const shares = splitOrderMoney({
    perSource,
    orderTotalMinor: order.totalMinor,
    shippingMinor: order.shippingMinor,
    discountMinor: order.discountMinor,
  });

  return (["own", "partner"] as const).map((source) => {
    const share = shares.find((entry) => entry.sourceId === source)!;
    const lines = order.lines
      .filter((line) => (allocation[line.shopifyLineItemId]?.[source] ?? 0) > 0)
      .map((line) => ({
        code: line.sku,
        amount: allocation[line.shopifyLineItemId]![source],
        priceWithTaxMinor: line.unitPriceWithTaxMinor,
        taxFactor: factorFor(line.shopifyLineItemId),
      }));

    return {
      share,
      body: buildSalesOrderBody({
        countCode: `SH-${order.orderNumber}-${source === "own" ? "GLAVNO" : "PARTNER1"}`,
        buyerOrder: `SH-${order.orderNumber}`,
        docDate: order.createdAt!,
        currencyCode: order.currency,
        taxesIncluded: order.taxesIncluded,
        partner: order.partner!,
        warehouse: source === "own" ? "glavno" : "partner",
        lines,
        shippingLine:
          share.shippingMinor > 0
            ? {
                code: "POSTNINA",
                amountMinor: share.shippingMinor,
                taxFactor: decision.shipping?.metakockaTaxFactor ?? null,
              }
            : null,
      }),
    };
  });
}

describe("a mixed-rate German business order becomes two MetaKocka documents", () => {
  const order = parseOrder(PAYLOAD);
  const decision = decideOrderTax(order.tax, config());

  it("is decided as OSS at Shopify's rates, line by line", () => {
    expect(decision.ok).toBe(true);
    expect(decision.jurisdiction).toBe("eu");
    expect(decision.customerKind).toBe("b2b");
    expect(decision.vatNumber).toBe("DE123456789");
    // Shopify charged VAT, so the VAT number changes nothing (§24).
    expect(decision.treatment).toBe("MIXED");
    expect(decision.lines.map((line) => [line.sku, line.rateKey, line.treatment, line.metakockaTaxFactor])).toEqual([
      ["MAST-490", "22", "EU_DISTANCE_SALE", "0.22"],
      ["BOOK-1", "9.5", "EU_DISTANCE_SALE", "0.095"],
      ["GIFT-CARD", "0", "NO_TAX", "0"],
    ]);
    expect(decision.shipping).toMatchObject({ rateKey: "22", taxMinor: 110, metakockaTaxFactor: "0.22" });
    expect(decision.totals).toEqual({
      taxableMinor: 21440 - 3866 + (2190 - 190) + 1200 + (610 - 110),
      taxMinor: 4166,
      shopifyTaxMinor: 4166,
      differenceMinor: 0,
      reconciled: true,
    });
  });

  it("notes that Shopify charged the home rates to Germany while OSS is on, without changing them", () => {
    // 22% and 9.5% are Slovenian rates charged on a German order. Shopify's
    // rate stands; the order page shows one note per line; nothing is blocked.
    expect(decision.issues.length).toBeGreaterThan(0);
    for (const issue of decision.issues) {
      expect([issue.kind, issue.severity]).toEqual(["rate_mismatch", "warning"]);
    }
  });

  const documents = bodiesFor(order, decision, {
    "14101": { own: 1, partner: 1 },
    "14102": { own: 1, partner: 0 },
    "14103": { own: 0, partner: 1 },
  });

  it("keeps every line at its own rate on whichever document carries it", () => {
    const [own, partner] = documents;
    expect(own!.body.product_list).toEqual([
      { code: "MAST-490", amount: "1", price_with_tax: "112.20", tax_factor: "0.22" },
      { code: "BOOK-1", amount: "1", price_with_tax: "21.90", tax_factor: "0.095" },
      // 6.10 spread by merchandise value: 134.10 of 258.30 here, the rest there.
      { code: "POSTNINA", amount: "1", price_with_tax: "3.17", tax_factor: "0.22" },
    ]);
    expect(partner!.body.product_list).toEqual([
      { code: "MAST-490", amount: "1", price_with_tax: "112.20", tax_factor: "0.22" },
      { code: "GIFT-CARD", amount: "1", price_with_tax: "12.00", tax_factor: "0" },
      { code: "POSTNINA", amount: "1", price_with_tax: "2.93", tax_factor: "0.22" },
    ]);
  });

  it("charges the shipping once across the documents, at shipping's own rate", () => {
    const shipping = documents.reduce((sum, entry) => sum + entry.share.shippingMinor, 0);
    expect(shipping).toBe(610);
    expect(documents.reduce((sum, entry) => sum + entry.share.totalMinor, 0)).toBe(order.totalMinor);
  });

  it("sends gross prices because the shop is tax-inclusive, and never doubles the VAT", () => {
    for (const { body } of documents) {
      for (const line of body.product_list) {
        expect(line).toHaveProperty("price_with_tax");
        expect(line).not.toHaveProperty("price");
      }
    }
  });

  it("reverses the refund at the rate and treatment the order was filed under", () => {
    const breakdown = reverseTaxForRefund(
      decision,
      new Map(order.lines.map((line) => [line.shopifyLineItemId, line.quantity])),
      order.refunds[0]!,
    );
    expect(breakdown.configVersion).toBe(12);
    expect(breakdown.entries[0]).toMatchObject({
      sku: "MAST-490",
      rateKey: "22",
      treatment: "EU_DISTANCE_SALE",
      taxableMinor: 10720 - 1933,
      taxMinor: 1933,
      basis: "shopify",
    });
    expect(breakdown.shipping).toMatchObject({ rateKey: "22", taxMinor: 110, taxableMinor: 500 });
    expect(breakdown.totalTaxMinor).toBe(1933 + 110);
  });
});

describe("the same order on a tax-exclusive shop", () => {
  const exclusive = JSON.parse(JSON.stringify(PAYLOAD)) as Record<string, unknown>;
  exclusive.taxes_included = false;
  const order = parseOrder(exclusive);
  const decision = decideOrderTax(order.tax, config());

  it("takes the taxable amount as the net price and sends `price`, not `price_with_tax`", () => {
    expect(decision.lines[0]).toMatchObject({ taxableMinor: 21440, taxMinor: 3866 });
    const [own] = bodiesFor(order, decision, {
      "14101": { own: 2, partner: 0 },
      "14102": { own: 1, partner: 0 },
      "14103": { own: 1, partner: 0 },
    });
    expect(own!.body.product_list[0]).toEqual({
      code: "MAST-490",
      amount: "2",
      price: "112.20",
      tax_factor: "0.22",
    });
  });
});

describe("fail closed", () => {
  const order = parseOrder(PAYLOAD);

  it("an unmapped 9.5% holds the whole order and no line carries a factor for it", () => {
    const decision = decideOrderTax(
      order.tax,
      config({ mappings: config().mappings.filter((row) => row.rateKey !== "9.5") }),
    );
    expect(decision.ok).toBe(false);
    expect(decision.issues.filter((issue) => issue.severity === "blocking").map((issue) => issue.kind)).toEqual([
      "mapping_missing",
    ]);
    expect(decision.lines[1]?.metakockaTaxFactor).toBeNull();
    // The 22% lines are still mapped; it is the order as a whole that waits.
    expect(decision.lines[0]?.metakockaTaxFactor).toBe("0.22");
  });

  it("a rate that is neither the home country's nor the destination's, with no registration, is a configuration error", () => {
    // An Austrian shop: 22% and 9.5% are neither Austrian nor German rates,
    // and nothing says how VAT to Germany is reported.
    const decision = decideOrderTax(
      order.tax,
      config({
        domesticCountry: "AT",
        domesticRateKey: "20",
        ossEnabled: false,
        registrations: [],
      }),
    );
    expect(decision.ok).toBe(false);
    expect(decision.issues[0]?.kind).toBe("registration_error");
  });

  it("a duplicate webhook decides the same order the same way", () => {
    const first = decideOrderTax(parseOrder(PAYLOAD).tax, config());
    const second = decideOrderTax(parseOrder(PAYLOAD).tax, config());
    expect(second).toEqual(first);
  });
});
