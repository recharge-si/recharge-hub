import { mappingFor, ossActive, registrationFor } from "~/domain/tax/config";
import { countryName } from "~/domain/tax/eu";
import { formatRateKey, sameRate } from "~/domain/tax/rates";
import type { RateKey, TaxConfig, TaxIssueKind } from "~/domain/tax/types";

/**
 * Tax diagnostics: what is configured, what the orders have actually used,
 * and what stands between the two (§38 of the brief).
 *
 * Pure, like readiness, and for the same reason: it is shown on the Taxes &
 * VAT page, folded into readiness for Home and Settings, and must cost one
 * batch of small queries and no integration call. The facts come from our own
 * tables — the configuration, the rates recent orders were decided with, and
 * the open tax exceptions.
 *
 * Every check says what is wrong *and* where to fix it. A check with nothing
 * wrong is a calm sentence, never a green badge (docs/ui-conventions.md).
 */

export const TAX_ROUTES = {
  overview: "/app/settings/taxes",
  registrations: "/app/settings/taxes/registrations",
  rates: "/app/settings/taxes/rates",
  mappings: "/app/settings/taxes/mappings",
  overrides: "/app/settings/taxes/overrides",
  exceptions: "/app/exceptions",
} as const;

export interface ObservedRate {
  rateKey: RateKey;
  /** Orders in the window that used it. */
  orders: number;
  countries: string[];
  lastSeenAt: string | null;
}

export interface TaxDiagnosticsFacts {
  config: TaxConfig;
  /** Rates orders in the recent window were decided with. */
  observed: ObservedRate[];
  /** Open tax exceptions, by exception kind. */
  openExceptions: { kind: string; count: number }[];
  /** Warnings recorded on recent decisions, by issue kind. */
  recentWarnings: { kind: TaxIssueKind; count: number }[];
  /** How many recent orders were decided at all. */
  decidedOrders: number;
}

export type TaxCheckStatus = "ok" | "warning" | "attention";

export interface TaxCheck {
  key:
    | "domestic"
    | "oss"
    | "registrations"
    | "mappings"
    | "fallback"
    | "exceptions"
    | "warnings";
  status: TaxCheckStatus;
  title: string;
  /** What it currently is, in one line. */
  summary: string;
  /** Why it needs attention, and what to do. Null when nothing is wrong. */
  reason: string | null;
  action: { label: string; href: string } | null;
}

export interface TaxDiagnostics {
  status: "ready" | "needs_attention";
  checks: TaxCheck[];
  /** Rates in use with no mapping — the single most common blocker. */
  unmappedRates: RateKey[];
  /** How many orders are held by open tax exceptions. */
  blockedOrders: number;
}

const TAX_EXCEPTION_KINDS = new Set([
  "tax_mapping_missing",
  "tax_treatment_unknown",
  "tax_reconciliation_failed",
  "tax_data_insufficient",
  "vat_registration_configuration_error",
  "tax_undeterminable",
]);

function list(values: string[], limit = 4): string {
  if (values.length <= limit) return values.join(", ");
  return `${values.slice(0, limit).join(", ")} and ${values.length - limit} more`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The rates the configuration itself needs mapped, before any order does. */
export function requiredRates(config: TaxConfig): RateKey[] {
  const keys: RateKey[] = ["0"];
  if (config.domesticRateKey) keys.push(config.domesticRateKey);
  for (const override of config.overrides) {
    if (override.enabled && override.rateKey) keys.push(override.rateKey);
  }
  return [...new Set(keys)];
}

export function computeTaxDiagnostics(facts: TaxDiagnosticsFacts): TaxDiagnostics {
  const { config } = facts;
  const checks: TaxCheck[] = [];

  /* Domestic VAT ----------------------------------------------------------- */
  const home = countryName(config.domesticCountry);
  if (config.domesticRateKey) {
    checks.push({
      key: "domestic",
      status: "ok",
      title: "Domestic VAT",
      summary: `${home} ${formatRateKey(config.domesticRateKey)}`,
      reason: null,
      action: { label: "Edit", href: TAX_ROUTES.registrations },
    });
  } else {
    checks.push({
      key: "domestic",
      status: "attention",
      title: "Domestic VAT",
      summary: `${home}, no rate set`,
      reason:
        "Orders Shopify charges no tax on have nothing to stand in for the rate, and MetaKocka refuses a line without one. Set the home VAT rate.",
      action: { label: "Set the rate", href: TAX_ROUTES.registrations },
    });
  }

  /* OSS -------------------------------------------------------------------- */
  const oss = registrationFor(config, "oss");
  checks.push({
    key: "oss",
    status: "ok",
    title: "EU OSS",
    summary: ossActive(config)
      ? oss
        ? `Enabled, identified in ${countryName(oss.country)}`
        : "Enabled"
      : "Off",
    reason: null,
    action: { label: "Edit", href: TAX_ROUTES.registrations },
  });

  /* Registrations ---------------------------------------------------------- */
  const registrations = config.registrations.filter((row) => row.enabled);
  checks.push({
    key: "registrations",
    status: "ok",
    title: "VAT registrations",
    summary:
      registrations.length === 0
        ? "None recorded"
        : list(
            registrations.map(
              (row) =>
                `${countryName(row.country)} (${row.kind === "oss" ? "OSS" : row.kind})`,
            ),
          ),
    reason: null,
    action: { label: "Edit", href: TAX_ROUTES.registrations },
  });

  /* Mappings --------------------------------------------------------------- */
  const needed = [
    ...new Set([...requiredRates(config), ...facts.observed.map((row) => row.rateKey)]),
  ];
  const unmappedRates = needed.filter((rateKey) => mappingFor(config, rateKey) === null);
  const mapped = config.mappings.filter((row) => row.enabled).length;

  if (unmappedRates.length === 0) {
    checks.push({
      key: "mappings",
      status: "ok",
      title: "MetaKocka mappings",
      summary:
        mapped === 0
          ? "No rates mapped yet"
          : `${mapped} ${plural(mapped, "rate", "rates")} mapped, every rate in use covered`,
      reason: null,
      action: { label: "Edit", href: TAX_ROUTES.mappings },
    });
  } else {
    const observedUnmapped = unmappedRates.filter((rateKey) =>
      facts.observed.some((row) => sameRate(row.rateKey, rateKey)),
    );
    checks.push({
      key: "mappings",
      status: "attention",
      title: "MetaKocka mappings",
      summary: `${list(unmappedRates.map(formatRateKey))} not mapped`,
      reason:
        observedUnmapped.length > 0
          ? `Orders use ${list(observedUnmapped.map(formatRateKey))} and no MetaKocka mapping exists for ${observedUnmapped.length === 1 ? "it" : "them"}. Those orders cannot be sent until the ${plural(observedUnmapped.length, "rate is", "rates are")} mapped.`
          : `The configuration expects ${list(unmappedRates.map(formatRateKey))} but no MetaKocka mapping exists for ${unmappedRates.length === 1 ? "it" : "them"}. An order using ${unmappedRates.length === 1 ? "that rate" : "those rates"} would be held.`,
      action: { label: "Configure mapping", href: TAX_ROUTES.mappings },
    });
  }

  /* Fallback --------------------------------------------------------------- */
  const fallback =
    config.fallbackScope === "none"
      ? "Never"
      : config.fallbackScope === "domestic"
        ? `Home orders only`
        : `Home and EU consumer orders`;
  const nonEu = config.nonEuNoTaxPolicy === "export" ? "filed as export at 0%" : "held for review";
  const ossAndWideFallback = config.fallbackScope === "eu" && ossActive(config);
  checks.push({
    key: "fallback",
    status: ossAndWideFallback ? "warning" : "ok",
    title: "When Shopify charges no tax",
    summary: `Home rate stands in: ${fallback.toLowerCase()}. Outside the EU: ${nonEu}.`,
    reason: ossAndWideFallback
      ? "OSS is enabled, so Shopify should be charging destination VAT on EU orders. An EU order with no tax would still be filed at the home rate under this setting; that is a Shopify market to check rather than a rate to send."
      : null,
    action: { label: "Edit", href: TAX_ROUTES.registrations },
  });

  /* Exceptions ------------------------------------------------------------- */
  const open = facts.openExceptions.filter((row) => TAX_EXCEPTION_KINDS.has(row.kind));
  const blockedOrders = open.reduce((sum, row) => sum + row.count, 0);
  if (blockedOrders > 0) {
    checks.push({
      key: "exceptions",
      status: "attention",
      title: "Orders held for tax",
      summary: `${blockedOrders} ${plural(blockedOrders, "order", "orders")} waiting`,
      reason:
        "Each one names what could not be determined and what to change. Nothing is sent to MetaKocka for them until it is resolved.",
      action: { label: "Review orders", href: TAX_ROUTES.exceptions },
    });
  } else {
    checks.push({
      key: "exceptions",
      status: "ok",
      title: "Orders held for tax",
      summary:
        facts.decidedOrders === 0
          ? "No orders decided yet"
          : `None of the last ${facts.decidedOrders} ${plural(facts.decidedOrders, "order", "orders")}`,
      reason: null,
      action: null,
    });
  }

  /* Warnings --------------------------------------------------------------- */
  const warnings = facts.recentWarnings.reduce((sum, row) => sum + row.count, 0);
  if (warnings > 0) {
    const mismatches = facts.recentWarnings.find((row) => row.kind === "rate_mismatch")?.count ?? 0;
    checks.push({
      key: "warnings",
      status: "warning",
      title: "Rates worth a look",
      summary: `${warnings} ${plural(warnings, "note", "notes")} on recent orders`,
      reason:
        mismatches > 0
          ? `${mismatches} ${plural(mismatches, "order", "orders")} used a Shopify rate that differs from the rates configured for the destination. Shopify's rate was used each time; check the EU VAT rates page if a rate is missing there, or the market's tax settings in Shopify.`
          : "Recent orders carried notes that did not stop them. The order pages state each one.",
      action: { label: "Open EU VAT rates", href: TAX_ROUTES.rates },
    });
  }

  return {
    status: checks.some((check) => check.status === "attention") ? "needs_attention" : "ready",
    checks,
    unmappedRates,
    blockedOrders,
  };
}
