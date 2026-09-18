import {
  isExpectedRate,
  mappingFor,
  ossActive,
  registrationFor,
} from "~/domain/tax/config";
import { countryName, isEuVatArea } from "~/domain/tax/eu";
import {
  formatRateKey,
  rateKeyToPpm,
  sameRate,
  sumRateKeys,
  taxInGrossMinor,
  taxOnNetMinor,
} from "~/domain/tax/rates";
import type {
  CustomerKind,
  Jurisdiction,
  LineTaxDecision,
  NormalizedOrderTax,
  OrderLineTaxInput,
  RateKey,
  ShippingTaxInput,
  TaxConfig,
  TaxDecision,
  TaxIssue,
  TaxIssueKind,
  TaxLineInput,
  TaxOverrideConfig,
  TaxSource,
  TaxTreatment,
} from "~/domain/tax/types";

/**
 * The tax engine: one Shopify order in, one explainable decision out.
 *
 * Pure (docs/BUILD_SPEC.md §5). No clock, no database, no MetaKocka field
 * names beyond the `tax_factor` string the mapping supplies.
 *
 * **Shopify's transaction tax is primary.** When Shopify supplies a rate and an
 * amount for a line, that is what the line is filed with — the country tables
 * only say whether it was expected. The engine never replaces a rate Shopify
 * gave with one from a table, however much they agree.
 *
 * **What it does decide is the treatment** — domestic, OSS, reverse charge,
 * export, exempt, non-taxable — from the destination, the buyer and the
 * merchant's registrations, because a rate on its own does not say what kind
 * of VAT event happened, and 0% in particular says nothing at all.
 *
 * **When Shopify supplies no rate** it falls back only where the configuration
 * allows: the home rate on a home or EU consumer sale (which is what a shop
 * below the OSS threshold owes), export at 0% outside the EU when the merchant
 * has said so. Everything else is an issue, and a blocking issue means no
 * document. §3 verified that MetaKocka accepts `tax_factor: "0"` and files a
 * financially wrong line without a word, so an unexplained zero is never sent.
 */

const NON_TAXABLE_ZERO = "Shopify marks the line as not taxable";

interface Context {
  config: TaxConfig;
  order: NormalizedOrderTax;
  destination: string | null;
  jurisdiction: Jurisdiction;
  customerKind: CustomerKind;
  issues: TaxIssue[];
}

function upper(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toUpperCase();
  return trimmed ? trimmed : null;
}

function jurisdictionOf(config: TaxConfig, destination: string | null): Jurisdiction {
  if (!destination) return "unknown";
  if (destination === config.domesticCountry.toUpperCase()) return "domestic";
  if (isEuVatArea(destination)) return "eu";
  return "non_eu";
}

function customerKindOf(order: NormalizedOrderTax): CustomerKind {
  if (order.customer.vatNumber || order.customer.isBusiness) return "b2b";
  if (order.destinationCountry === null && order.billingCountry === null) {
    return "unknown";
  }
  return "b2c";
}

function money(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

function issue(
  ctx: Context,
  kind: TaxIssueKind,
  severity: TaxIssue["severity"],
  message: string,
  lineIds: string[],
  detail: Record<string, unknown> = {},
): void {
  // One issue per (kind, message): a ten-line order with one unmapped rate is
  // one problem, and the merchant reads it once.
  const existing = ctx.issues.find(
    (entry) => entry.kind === kind && entry.message === message,
  );
  if (existing) {
    for (const id of lineIds) {
      if (!existing.lineIds.includes(id)) existing.lineIds.push(id);
    }
    return;
  }
  ctx.issues.push({ kind, severity, message, lineIds: [...lineIds], detail });
}

/** Takes one line out of every issue, dropping issues that were only about it. */
function withdrawIssuesFor(ctx: Context, lineId: string): void {
  ctx.issues = ctx.issues.flatMap((entry) => {
    if (!entry.lineIds.includes(lineId)) return [entry];
    const remaining = entry.lineIds.filter((id) => id !== lineId);
    return remaining.length === 0 ? [] : [{ ...entry, lineIds: remaining }];
  });
}

function issueKindsFor(ctx: Context, lineId: string): TaxIssueKind[] {
  return [
    ...new Set(
      ctx.issues
        .filter((entry) => entry.lineIds.includes(lineId))
        .map((entry) => entry.kind),
    ),
  ];
}

function lineTotal(line: OrderLineTaxInput): number {
  return Math.max(0, line.quantity * line.unitPriceMinor - line.discountMinor);
}

/** Tax computed from a rate on the order's price basis. */
function computedTax(amountMinor: number, rateKey: RateKey, taxesIncluded: boolean): number {
  const ppm = rateKeyToPpm(rateKey) ?? 0;
  return taxesIncluded
    ? taxInGrossMinor(amountMinor, ppm)
    : taxOnNetMinor(amountMinor, ppm);
}

function isPositive(rateKey: RateKey | null): boolean {
  return rateKey !== null && (rateKeyToPpm(rateKey) ?? 0) > 0;
}

/** The rate Shopify's tax lines add up to, and what they charged. */
function shopifyRate(taxLines: TaxLineInput[]): {
  rateKey: RateKey | null;
  taxMinor: number;
} {
  if (taxLines.length === 0) return { rateKey: null, taxMinor: 0 };
  return {
    rateKey: sumRateKeys(taxLines.map((line) => line.rateKey)),
    taxMinor: taxLines.reduce((sum, line) => sum + line.amountMinor, 0),
  };
}

interface Classified {
  treatment: TaxTreatment;
  zeroReason: string | null;
}

/**
 * What kind of VAT event a positive rate is, given where the goods go and who
 * the merchant is registered as.
 */
function classifyPositiveRate(
  ctx: Context,
  rateKey: RateKey,
  lineId: string,
  label: string,
): Classified {
  const { config, destination, jurisdiction } = ctx;
  const where = countryName(destination);
  const rate = formatRateKey(rateKey);

  switch (jurisdiction) {
    case "domestic": {
      if (!isExpectedRate(config, destination, rateKey)) {
        issue(
          ctx,
          "rate_mismatch",
          "warning",
          `Shopify charged ${rate} on ${label} shipped to ${where}, which is not a rate configured for ${where}. Shopify's rate was used; check the EU VAT rates page if that is unexpected.`,
          [lineId],
          { country: destination, rateKey },
        );
      }
      return { treatment: "DOMESTIC_VAT", zeroReason: null };
    }

    case "eu": {
      const expectedHere = isExpectedRate(config, destination, rateKey);
      const homeRate = sameRate(rateKey, config.domesticRateKey);
      const local = registrationFor(config, "local", destination);
      const oss = ossActive(config);

      if (local && expectedHere) {
        return { treatment: "EU_LOCAL_REGISTRATION", zeroReason: null };
      }
      if (oss && expectedHere) return { treatment: "EU_OSS", zeroReason: null };

      if (homeRate) {
        /*
         * The home rate on a cross-border consumer sale is origin VAT — what
         * a shop below the EU-wide distance-selling threshold charges. With
         * OSS on it is still Shopify's decision, but worth a word.
         */
        if (oss) {
          issue(
            ctx,
            "rate_mismatch",
            "warning",
            `Shopify charged the home rate ${rate} on ${label} shipped to ${where} although OSS is enabled. Shopify's rate was used and the line is recorded as a distance sale at the home rate; check the market's tax settings in Shopify if OSS should apply.`,
            [lineId],
            { country: destination, rateKey },
          );
        }
        return { treatment: "EU_DISTANCE_SALE", zeroReason: null };
      }

      if (local || oss) {
        issue(
          ctx,
          "rate_mismatch",
          "warning",
          `Shopify charged ${rate} on ${label} shipped to ${where}, which is not a rate configured for ${where}. Shopify's rate was used; add it on the EU VAT rates page if it is a reduced rate you expect.`,
          [lineId],
          { country: destination, rateKey },
        );
        return {
          treatment: local ? "EU_LOCAL_REGISTRATION" : "EU_OSS",
          zeroReason: null,
        };
      }

      issue(
        ctx,
        "registration_error",
        "blocking",
        `Shopify charged ${where} VAT at ${rate} on ${label}, but neither EU OSS nor a ${where} VAT registration is configured, so this app cannot say how that VAT is reported. Enable OSS or add the registration on the Taxes & VAT page, then reconcile the order again.`,
        [lineId],
        { country: destination, rateKey },
      );
      return { treatment: "UNKNOWN", zeroReason: null };
    }

    case "non_eu": {
      if (registrationFor(config, "local", destination)) {
        return { treatment: "NON_EU_LOCAL_REGISTRATION", zeroReason: null };
      }
      issue(
        ctx,
        "registration_error",
        "blocking",
        `Shopify charged tax at ${rate} on ${label} shipped to ${where}, outside the EU, and no ${where} registration is configured to file it under. Add the registration on the Taxes & VAT page if you are registered there, or check the market's tax settings in Shopify, then reconcile the order again.`,
        [lineId],
        { country: destination, rateKey },
      );
      return { treatment: "UNKNOWN", zeroReason: null };
    }

    case "unknown": {
      if (sameRate(rateKey, config.domesticRateKey)) {
        issue(
          ctx,
          "destination_missing",
          "warning",
          `The order has no shipping or billing country. Shopify charged the home rate ${rate} on ${label}, so it is recorded as home-country VAT.`,
          [lineId],
          {},
        );
        return { treatment: "DOMESTIC_VAT", zeroReason: null };
      }
      issue(
        ctx,
        "destination_missing",
        "blocking",
        `The order has no shipping or billing country, and Shopify charged ${rate} on ${label}, which is not the home rate, so the VAT treatment cannot be told. Add the address in Shopify or enter the customer details on the order page, then reconcile the order again.`,
        [lineId],
        { rateKey },
      );
      return { treatment: "UNKNOWN", zeroReason: null };
    }
  }
}

/**
 * What a zero means: a tax line at 0% Shopify said out loud (`explicit`), or
 * no tax at all on an order. UNKNOWN here means "no reason found", which the
 * caller may still answer with the configured fallback.
 */
function classifyZero(
  ctx: Context,
  lineId: string,
  label: string,
  explicit: boolean,
): Classified {
  const { config, order, jurisdiction, customerKind, destination } = ctx;
  const where = countryName(destination);

  if (order.customer.taxExempt) {
    return {
      treatment: "TAX_EXEMPT",
      zeroReason: "Shopify marks the buyer as tax exempt",
    };
  }

  if (jurisdiction === "eu" && customerKind === "b2b" && order.customer.vatNumber) {
    return {
      treatment: "EU_REVERSE_CHARGE",
      zeroReason: `EU business buyer with VAT number ${order.customer.vatNumber}, cross-border supply, no VAT charged by Shopify`,
    };
  }

  if (jurisdiction === "non_eu") {
    if (explicit || config.nonEuNoTaxPolicy === "export") {
      return {
        treatment: "NON_EU_EXPORT",
        zeroReason: explicit
          ? `Shopify charged 0% on a sale shipped to ${where}, outside the EU`
          : `No tax charged by Shopify on a sale shipped to ${where}, outside the EU; the export policy files it at 0%`,
      };
    }
    issue(
      ctx,
      "treatment_unknown",
      "blocking",
      `Shopify charged no tax on ${label} shipped to ${where}, outside the EU, and this app is set to ask before filing a sale outside the EU at 0%. Choose the export policy on the Taxes & VAT page, or add an override for ${where}, then reconcile the order again.`,
      [lineId],
      { country: destination },
    );
    return { treatment: "UNKNOWN", zeroReason: null };
  }

  if (jurisdiction === "unknown") {
    issue(
      ctx,
      "destination_missing",
      "blocking",
      `Shopify charged no tax on ${label} and the order has no shipping or billing country, so this app cannot tell whether that zero is an export, an exemption or a gap. Add the address in Shopify or enter the customer details on the order page, then reconcile the order again.`,
      [lineId],
      {},
    );
    return { treatment: "UNKNOWN", zeroReason: null };
  }

  if (explicit) {
    return {
      treatment: "ZERO_RATED",
      zeroReason: `Shopify applied a 0% tax rate to ${label}`,
    };
  }

  return { treatment: "UNKNOWN", zeroReason: null };
}

/**
 * The home rate standing in for a rate Shopify did not give, where the
 * configuration allows it. Null, with the issue raised, where it does not.
 */
function fallbackFor(
  ctx: Context,
  lineId: string,
  label: string,
): { rateKey: RateKey; treatment: TaxTreatment } | null {
  const { config, jurisdiction, destination } = ctx;

  const allowed =
    config.domesticRateKey !== null &&
    ((jurisdiction === "domestic" && config.fallbackScope !== "none") ||
      (jurisdiction === "eu" && config.fallbackScope === "eu"));

  if (allowed) {
    return {
      rateKey: config.domesticRateKey!,
      treatment: jurisdiction === "domestic" ? "DOMESTIC_VAT" : "EU_DISTANCE_SALE",
    };
  }

  const where = countryName(destination);
  issue(
    ctx,
    "treatment_unknown",
    "blocking",
    config.domesticRateKey === null
      ? `Shopify charged no tax on ${label} shipped to ${where}, and no home VAT rate is configured to stand in for it. Set the domestic VAT rate on the Taxes & VAT page, then reconcile the order again.`
      : `Shopify charged no tax on ${label} shipped to ${where}, and the home rate is not allowed to stand in for a ${jurisdiction === "eu" ? "cross-border EU" : "home"} sale under the current fallback setting. Widen the fallback on the Taxes & VAT page, fix the market's tax settings in Shopify, or add an override for ${where}, then reconcile the order again.`,
    [lineId],
    { country: destination, fallbackScope: config.fallbackScope },
  );
  return null;
}

function overrideFor(ctx: Context, sku: string): TaxOverrideConfig | null {
  const enabled = ctx.config.overrides.filter((entry) => entry.enabled);
  const trimmed = sku.trim();
  const bySku =
    trimmed === ""
      ? null
      : enabled.find(
          (entry) => entry.scope === "sku" && entry.match.trim() === trimmed,
        );
  if (bySku) return bySku;
  return (
    enabled.find(
      (entry) =>
        entry.scope === "country" &&
        ctx.destination !== null &&
        entry.match.trim().toUpperCase() === ctx.destination,
    ) ?? null
  );
}

/** Attaches the MetaKocka mapping, or the issue that it is missing. */
function withMapping(ctx: Context, decision: LineTaxDecision, label: string): LineTaxDecision {
  if (decision.rateKey === null || decision.treatment === "UNKNOWN") {
    return {
      ...decision,
      mapping: "not_applicable",
      metakockaTaxFactor: null,
      issues: issueKindsFor(ctx, decision.lineId),
    };
  }

  const mapping = mappingFor(ctx.config, decision.rateKey);
  if (!mapping) {
    const rate = formatRateKey(decision.rateKey);
    issue(
      ctx,
      "mapping_missing",
      "blocking",
      `${label} uses a VAT rate of ${rate}, but no MetaKocka mapping exists for ${rate}. Map it on the Taxes & VAT page before orders using this rate can be sent.`,
      [decision.lineId],
      { rateKey: decision.rateKey },
    );
  }

  return {
    ...decision,
    mapping: mapping ? "mapped" : "missing",
    metakockaTaxFactor: mapping?.metakockaTaxFactor ?? null,
    issues: issueKindsFor(ctx, decision.lineId),
  };
}

interface LineBase {
  lineId: string;
  sku: string;
  label: string;
  /** The line's value after its own discount, on the order's price basis. */
  amountMinor: number;
  taxable: boolean;
  /** Null when Shopify did not report tax lines for this at all. */
  taxLines: TaxLineInput[] | null;
}

function decideLine(ctx: Context, base: LineBase): LineTaxDecision {
  const { order } = ctx;
  const override = overrideFor(ctx, base.sku);
  const shopify = shopifyRate(base.taxLines ?? []);

  let rateKey: RateKey | null = null;
  let source: TaxSource = "SHOPIFY";
  let taxMinor = 0;
  let classified: Classified;
  let insufficient = false;

  if (override?.rateKey != null) {
    /*
     * An intentional override of the rate itself. Never silent: the line
     * carries the override's id and the order page names it.
     */
    rateKey = override.rateKey;
    source = override.scope === "sku" ? "PRODUCT_RULE" : "MANUAL_OVERRIDE";
    taxMinor = computedTax(base.amountMinor, rateKey, order.taxesIncluded);
    classified = override.treatment
      ? {
          treatment: override.treatment,
          zeroReason: isPositive(rateKey) ? null : `Override "${override.reason}"`,
        }
      : isPositive(rateKey)
        ? classifyPositiveRate(ctx, rateKey, base.lineId, base.label)
        : { treatment: "ZERO_RATED", zeroReason: `Override "${override.reason}" sets 0%` };
  } else if (!base.taxable) {
    rateKey = "0";
    classified = { treatment: "NO_TAX", zeroReason: NON_TAXABLE_ZERO };
  } else if (shopify.rateKey !== null) {
    rateKey = shopify.rateKey;
    taxMinor = shopify.taxMinor;
    classified = isPositive(rateKey)
      ? classifyPositiveRate(ctx, rateKey, base.lineId, base.label)
      : classifyZero(ctx, base.lineId, base.label, true);
  } else if (base.amountMinor === 0) {
    // Free after its discount. There is no tax to get wrong, and Shopify
    // does not always bother to say so with a tax line.
    rateKey = "0";
    classified = {
      treatment: "NO_TAX",
      zeroReason: "the line is free after its discount",
    };
  } else if (order.totalTaxMinor > 0 && base.taxLines !== null) {
    /*
     * Shopify charged tax on this order and said nothing about this line.
     * §3: the rate is undeterminable, and a guess files the wrong VAT.
     */
    insufficient = true;
    issue(
      ctx,
      "data_insufficient",
      "blocking",
      `Shopify charged tax on this order but gave no tax breakdown for ${base.label}, so the rate for that line cannot be determined. Check the line in Shopify, then reconcile the order again.`,
      [base.lineId],
      {},
    );
    classified = { treatment: "UNKNOWN", zeroReason: null };
  } else {
    classified = classifyZero(ctx, base.lineId, base.label, false);
    if (classified.treatment !== "UNKNOWN") {
      rateKey = "0";
    } else if (issueKindsFor(ctx, base.lineId).length === 0) {
      const fallback = fallbackFor(ctx, base.lineId, base.label);
      if (fallback) {
        rateKey = fallback.rateKey;
        source = "COUNTRY_DEFAULT";
        taxMinor = computedTax(base.amountMinor, rateKey, order.taxesIncluded);
        classified = { treatment: fallback.treatment, zeroReason: null };
      }
    }
  }

  if (override && override.rateKey == null && override.treatment && !insufficient) {
    /*
     * An override of the treatment alone. The rate stays whatever it was; a
     * line that had no answer now has one, so the issue raised for it is
     * withdrawn — that is what the override is for.
     */
    if (rateKey === null) {
      rateKey = "0";
      withdrawIssuesFor(ctx, base.lineId);
    }
    classified = {
      treatment: override.treatment,
      zeroReason: taxMinor === 0 ? `Override "${override.reason}"` : null,
    };
  }

  const taxableMinor = order.taxesIncluded
    ? base.amountMinor - taxMinor
    : base.amountMinor;

  return withMapping(
    ctx,
    {
      lineId: base.lineId,
      sku: base.sku,
      rateKey,
      treatment: classified.treatment,
      source,
      zeroReason: classified.zeroReason,
      taxableMinor,
      taxMinor,
      metakockaTaxFactor: null,
      mapping: "not_applicable",
      overrideId: override?.id ?? null,
      issues: [],
    },
    base.label,
  );
}

function shippingDecision(
  ctx: Context,
  amountMinor: number,
  fields: Pick<LineTaxDecision, "rateKey" | "treatment" | "source" | "zeroReason">,
  taxMinor: number,
): LineTaxDecision {
  return withMapping(
    ctx,
    {
      lineId: "shipping",
      sku: "",
      ...fields,
      taxableMinor: ctx.order.taxesIncluded ? amountMinor - taxMinor : amountMinor,
      taxMinor,
      metakockaTaxFactor: null,
      mapping: "not_applicable",
      overrideId: null,
      issues: [],
    },
    "shipping",
  );
}

/**
 * Shipping, which is its own supply and taxed by Shopify on its own terms.
 *
 * With tax lines it is read exactly like a product line. Without them, and
 * with tax charged elsewhere on the order, the residual between Shopify's
 * order tax and the lines' tax is what shipping was taxed, and it is adopted
 * only when it equals what one of the order's own rates would produce — a
 * derivation, not a guess, and one the reconciliation below then confirms.
 */
function decideShipping(
  ctx: Context,
  shipping: ShippingTaxInput,
  lines: LineTaxDecision[],
): LineTaxDecision | null {
  if (shipping.amountMinor <= 0) return null;
  const { order } = ctx;

  if (shipping.taxLines !== null && shipping.taxLines.length > 0) {
    return decideLine(ctx, {
      lineId: "shipping",
      sku: "",
      label: "shipping",
      amountMinor: shipping.amountMinor,
      taxable: true,
      taxLines: shipping.taxLines,
    });
  }

  if (order.totalTaxMinor === 0) {
    // Nothing on the order was taxed. Shipping goes the way the goods went.
    const decided = lines.filter((line) => line.treatment !== "UNKNOWN");
    const rates = [...new Set(decided.map((line) => line.rateKey ?? "0"))];
    const treatments = [...new Set(decided.map((line) => line.treatment))];
    const template = decided[0];

    if (template && rates.length === 1 && treatments.length === 1) {
      const rateKey = rates[0]!;
      return shippingDecision(
        ctx,
        shipping.amountMinor,
        {
          rateKey,
          treatment: template.treatment,
          source: template.source === "SHOPIFY" ? "SHOPIFY" : "FALLBACK",
          zeroReason: template.zeroReason,
        },
        computedTax(shipping.amountMinor, rateKey, order.taxesIncluded),
      );
    }

    // The goods could not be decided either, or disagree; their issues cover
    // the order and shipping waits with them.
    return {
      lineId: "shipping",
      sku: "",
      rateKey: null,
      treatment: "UNKNOWN",
      source: "FALLBACK",
      zeroReason: null,
      taxableMinor: shipping.amountMinor,
      taxMinor: 0,
      metakockaTaxFactor: null,
      mapping: "not_applicable",
      overrideId: null,
      issues: decided.length === 0 ? ["treatment_unknown"] : ["data_insufficient"],
    };
  }

  // Tax was charged on the order. What is left after the lines is shipping's.
  const linesTax = lines.reduce(
    (sum, line) => sum + (line.source === "SHOPIFY" ? line.taxMinor : 0),
    0,
  );
  const residual = order.totalTaxMinor - linesTax;

  if (shipping.taxLines !== null && residual <= 0) {
    // Shopify reported no tax lines on shipping and nothing is left over: it
    // charged no tax on shipping, and says so.
    return shippingDecision(
      ctx,
      shipping.amountMinor,
      {
        rateKey: "0",
        treatment: "NO_TAX",
        source: "SHOPIFY",
        zeroReason: "Shopify charged no tax on shipping",
      },
      0,
    );
  }

  const candidates = [
    ...new Set(
      lines.map((line) => line.rateKey).filter((key): key is string => key !== null),
    ),
  ];
  const match = candidates.find(
    (rateKey) =>
      computedTax(shipping.amountMinor, rateKey, order.taxesIncluded) === residual,
  );
  const template = match === undefined ? undefined : lines.find((line) => line.rateKey === match);

  if (match !== undefined && template && residual > 0) {
    return shippingDecision(
      ctx,
      shipping.amountMinor,
      {
        rateKey: match,
        treatment: template.treatment,
        source: "FALLBACK",
        zeroReason: null,
      },
      residual,
    );
  }

  issue(
    ctx,
    "data_insufficient",
    "blocking",
    `Shopify charged tax on this order but gave no tax breakdown for shipping, and the ${money(residual, order.currency)} left after the lines matches none of the order's rates, so the shipping VAT cannot be determined. Check the shipping tax in Shopify, then reconcile the order again.`,
    ["shipping"],
    { residualMinor: residual },
  );
  return {
    lineId: "shipping",
    sku: "",
    rateKey: null,
    treatment: "UNKNOWN",
    source: "SHOPIFY",
    zeroReason: null,
    taxableMinor: shipping.amountMinor,
    taxMinor: 0,
    metakockaTaxFactor: null,
    mapping: "not_applicable",
    overrideId: null,
    issues: ["data_insufficient"],
  };
}

/**
 * How far the lines' Shopify-reported tax may drift from the order's: one
 * minor unit per taxed line, for the rounding of each, and never more than
 * five. A material difference is an error, not a rounding.
 */
function tolerance(taxedLines: number): number {
  return Math.max(1, Math.min(taxedLines, 5));
}

export function decideOrderTax(order: NormalizedOrderTax, config: TaxConfig): TaxDecision {
  const destination = upper(order.destinationCountry) ?? upper(order.billingCountry);
  const ctx: Context = {
    config,
    order,
    destination,
    jurisdiction: jurisdictionOf(config, destination),
    customerKind: customerKindOf(order),
    issues: [],
  };

  const lines = order.lines.map((line, index) =>
    decideLine(ctx, {
      lineId: line.lineId,
      sku: line.sku,
      label: line.sku ? `line ${line.sku}` : `line ${index + 1}`,
      amountMinor: lineTotal(line),
      taxable: line.taxable,
      taxLines: line.taxLines,
    }),
  );

  const shipping = order.shipping ? decideShipping(ctx, order.shipping, lines) : null;

  const all = shipping ? [...lines, shipping] : lines;
  const taxMinor = all.reduce((sum, line) => sum + line.taxMinor, 0);
  const taxableMinor = all.reduce((sum, line) => sum + line.taxableMinor, 0);

  /*
   * Shopify's own line taxes against Shopify's own order tax. Only comparable
   * when every taxed line came from Shopify: a fallback rate is this app's
   * arithmetic on an order Shopify taxed at nothing, and the two are not the
   * same number by construction.
   */
  const comparable = all.every(
    (line) => line.source === "SHOPIFY" || line.treatment === "UNKNOWN",
  );
  const differenceMinor = taxMinor - order.totalTaxMinor;
  const taxed = all.filter((line) => line.taxMinor !== 0).length;
  const blockedAlready = ctx.issues.some((entry) => entry.severity === "blocking");
  let reconciled = true;

  if (comparable && !blockedAlready && Math.abs(differenceMinor) > tolerance(taxed)) {
    reconciled = false;
    issue(
      ctx,
      "reconciliation_failed",
      "blocking",
      `The tax on this order's lines adds up to ${money(taxMinor, order.currency)}, but Shopify reports ${money(order.totalTaxMinor, order.currency)} for the order. The two must agree before it is sent. Check the order's taxes in Shopify, then reconcile the order again.`,
      [],
      { taxMinor, shopifyTaxMinor: order.totalTaxMinor, differenceMinor },
    );
  }

  const treatments = [...new Set(all.map((line) => line.treatment))];
  const sources = [...new Set(all.map((line) => line.source))];
  const rateKeys = [
    ...new Set(all.map((line) => line.rateKey).filter((key): key is string => key !== null)),
  ].sort((a, b) => (rateKeyToPpm(a) ?? 0) - (rateKeyToPpm(b) ?? 0));

  return {
    configVersion: config.version,
    currency: order.currency,
    taxesIncluded: order.taxesIncluded,
    destinationCountry: destination,
    jurisdiction: ctx.jurisdiction,
    customerKind: ctx.customerKind,
    vatNumber: order.customer.vatNumber,
    treatment: treatments.length === 1 ? treatments[0]! : "MIXED",
    source: sources.length === 1 ? sources[0]! : "MIXED",
    lines,
    shipping,
    totals: {
      taxableMinor,
      taxMinor,
      shopifyTaxMinor: order.totalTaxMinor,
      differenceMinor,
      reconciled,
    },
    rateKeys,
    issues: ctx.issues,
    ok: !ctx.issues.some((entry) => entry.severity === "blocking"),
  };
}
