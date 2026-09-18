/**
 * The tax domain's vocabulary (docs/BUILD_SPEC.md §8.6, §3 on `tax_factor`).
 *
 * Everything an order's VAT decision is made of, named once. Nothing in here
 * knows what Shopify calls a field or what MetaKocka calls a code: the Shopify
 * adapter produces a `NormalizedOrderTax`, the engine turns it into a
 * `TaxDecision`, and the MetaKocka adapter reads the decision's mapped factor.
 * That is the whole pipeline, and this file is the contract between its stages.
 */

/**
 * What kind of VAT event a line is. Not a rate: 0% means five different things
 * to an accountant, and collapsing them is how a reverse-charge supply gets
 * reported as an export.
 */
export const TAX_TREATMENTS = [
  /** Home-country VAT on a home-country sale. */
  "DOMESTIC_VAT",
  /** Destination-country VAT reported through the One Stop Shop. */
  "EU_OSS",
  /** Home-country VAT on a cross-border EU consumer sale, below the OSS threshold. */
  "EU_DISTANCE_SALE",
  /** 0%: a VAT-registered EU business buyer accounts for the VAT itself. */
  "EU_REVERSE_CHARGE",
  /** Destination-country VAT under the merchant's own registration there. */
  "EU_LOCAL_REGISTRATION",
  /** Tax under a registration outside the EU (the UK, Switzerland, Norway...). */
  "NON_EU_LOCAL_REGISTRATION",
  /** 0% because the goods themselves are zero-rated. */
  "ZERO_RATED",
  /** 0% because the buyer is exempt. */
  "TAX_EXEMPT",
  /** 0% because the goods leave the EU. */
  "NON_EU_EXPORT",
  /** Tax collected at import, on the customer's side. Recorded, never sent. */
  "IMPORT",
  /** Not a taxable supply at all: a non-taxable line. */
  "NO_TAX",
  /** A person said so. */
  "MANUAL_OVERRIDE",
  /** Could not be told. Always an exception, never a document. */
  "UNKNOWN",
] as const;

export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

/** Where a line's rate came from, in order of trust. */
export const TAX_SOURCES = [
  /** Shopify's own transaction tax. The normal case and the authoritative one. */
  "SHOPIFY",
  /** The configured home-country rate, applied because Shopify charged none. */
  "COUNTRY_DEFAULT",
  /** A per-SKU override. */
  "PRODUCT_RULE",
  /** A per-country or per-treatment override. */
  "MANUAL_OVERRIDE",
  /** Inherited from the order's other lines (shipping with no rate of its own). */
  "FALLBACK",
] as const;

export type TaxSource = (typeof TAX_SOURCES)[number];

/**
 * A rate, as the canonical percentage string: "22", "9.5", "0", "20.5".
 *
 * A string rather than a number because 9.5 and 0.095 and "9.50" are the same
 * rate and must compare equal as a mapping key. `domain/tax/rates` is the only
 * thing that makes one.
 */
export type RateKey = string;

/** One tax line as Shopify reports it, normalised. */
export interface TaxLineInput {
  rateKey: RateKey;
  /** Tax charged on this line at this rate, minor units, presentment currency. */
  amountMinor: number;
  title: string | null;
}

export interface OrderLineTaxInput {
  lineId: string;
  sku: string;
  quantity: number;
  /** Unit price as Shopify holds it (gross or net per `taxesIncluded`). */
  unitPriceMinor: number;
  /** Line discount, positive, minor units. */
  discountMinor: number;
  /** Whether Shopify considers the line taxable at all. */
  taxable: boolean;
  taxLines: TaxLineInput[];
}

export interface ShippingTaxInput {
  /** What the customer paid for shipping after shipping discounts. */
  amountMinor: number;
  /**
   * Shopify's tax lines on shipping. An empty list means Shopify reported
   * none; null means the payload did not describe shipping lines at all.
   */
  taxLines: TaxLineInput[] | null;
}

/**
 * Everything the engine needs, in one shape, with no Shopify field names.
 *
 * Every amount is in the presentment currency (§8.6). The adapter that builds
 * this is responsible for never mixing the shop currency in.
 */
export interface NormalizedOrderTax {
  currency: string;
  taxesIncluded: boolean;
  /** Shopify's tax total for the order as it stands now. */
  totalTaxMinor: number;
  /** Order-level tax lines, for reconciliation and diagnostics. */
  orderTaxLines: TaxLineInput[];
  /** ISO 3166-1 alpha-2 of the shipping address, or the billing one. */
  destinationCountry: string | null;
  billingCountry: string | null;
  customer: {
    isBusiness: boolean;
    /** A VAT identifier Shopify carried, if any. Presence proves nothing. */
    vatNumber: string | null;
    /** Shopify's own exemption flag on the order or customer. */
    taxExempt: boolean;
  };
  lines: OrderLineTaxInput[];
  shipping: ShippingTaxInput | null;
}

export type VatRegistrationKind = "domestic" | "oss" | "local";

export interface VatRegistrationConfig {
  kind: VatRegistrationKind;
  /** The country the registration is in. For OSS, the member state of identification. */
  country: string;
  vatNumber: string | null;
  enabled: boolean;
}

export type CountryRateKind =
  | "standard"
  | "reduced"
  | "super_reduced"
  | "parking"
  | "zero"
  | "other";

export interface CountryRateConfig {
  country: string;
  kind: CountryRateKind;
  rateKey: RateKey;
  label: string | null;
  /** Reference table shipped with the app, or the merchant's own entry. */
  origin: "reference" | "merchant";
}

export interface TaxMappingConfig {
  rateKey: RateKey;
  /** The `tax_factor` MetaKocka is sent for this rate, e.g. "0.22". */
  metakockaTaxFactor: string;
  enabled: boolean;
}

export type TaxOverrideScope = "country" | "sku";

export interface TaxOverrideConfig {
  id: string;
  scope: TaxOverrideScope;
  /** A country code for `country`, a SKU for `sku`. */
  match: string;
  /** The treatment to record. Null keeps the classified one. */
  treatment: TaxTreatment | null;
  /** The rate to apply. Null keeps Shopify's. */
  rateKey: RateKey | null;
  reason: string;
  enabled: boolean;
}

/**
 * Where the configured home rate may stand in for a rate Shopify did not give.
 * Never outside the EU: export is its own policy below.
 */
export type TaxFallbackScope = "none" | "domestic" | "eu";

/** What a non-EU destination with no Shopify tax means. */
export type NonEuNoTaxPolicy = "review" | "export";

/**
 * The whole tax configuration, versioned.
 *
 * Frozen into every order's snapshot so a refund six months later reverses the
 * treatment the order was filed under, whatever the settings say by then.
 */
export interface TaxConfig {
  version: number;
  domesticCountry: string;
  domesticRateKey: RateKey | null;
  fallbackScope: TaxFallbackScope;
  nonEuNoTaxPolicy: NonEuNoTaxPolicy;
  ossEnabled: boolean;
  registrations: VatRegistrationConfig[];
  countryRates: CountryRateConfig[];
  mappings: TaxMappingConfig[];
  overrides: TaxOverrideConfig[];
}

export type Jurisdiction = "domestic" | "eu" | "non_eu" | "unknown";

export type CustomerKind = "b2c" | "b2b" | "unknown";

export const TAX_ISSUE_KINDS = [
  /** A rate the order uses has no MetaKocka mapping. */
  "mapping_missing",
  /** The 0% or the rate could not be given a treatment. */
  "treatment_unknown",
  /** Shopify charged tax but a line has no breakdown to read the rate from. */
  "data_insufficient",
  /** No destination to decide a jurisdiction from. */
  "destination_missing",
  /** Line taxes do not add up to Shopify's order tax. */
  "reconciliation_failed",
  /** Shopify charged a destination rate this configuration has no registration for. */
  "registration_error",
  /** Shopify's rate is not one this configuration expects for the country. Informational. */
  "rate_mismatch",
] as const;

export type TaxIssueKind = (typeof TAX_ISSUE_KINDS)[number];

export interface TaxIssue {
  kind: TaxIssueKind;
  severity: "blocking" | "warning";
  /** Says what is wrong and what to do (§2.8). */
  message: string;
  /** The lines concerned, by id, or empty for an order-level issue. */
  lineIds: string[];
  detail: Record<string, unknown>;
}

export interface LineTaxDecision {
  lineId: string;
  sku: string;
  rateKey: RateKey | null;
  treatment: TaxTreatment;
  source: TaxSource;
  /** Why a zero rate is zero, in the treatment's words. Null when not zero. */
  zeroReason: string | null;
  /** Tax base, minor units, after discounts. */
  taxableMinor: number;
  taxMinor: number;
  /** The `tax_factor` to send. Null when the rate is unmapped or unknown. */
  metakockaTaxFactor: string | null;
  mapping: "mapped" | "missing" | "not_applicable";
  /** The override that decided this, if one did. */
  overrideId: string | null;
  issues: TaxIssueKind[];
}

export interface TaxDecision {
  configVersion: number;
  currency: string;
  taxesIncluded: boolean;
  destinationCountry: string | null;
  jurisdiction: Jurisdiction;
  customerKind: CustomerKind;
  vatNumber: string | null;
  /** The order's overall treatment: the one every line shares, or MIXED. */
  treatment: TaxTreatment | "MIXED";
  /** The source every line shares, or MIXED. */
  source: TaxSource | "MIXED";
  lines: LineTaxDecision[];
  shipping: LineTaxDecision | null;
  totals: {
    taxableMinor: number;
    taxMinor: number;
    shopifyTaxMinor: number;
    /** taxMinor − shopifyTaxMinor, where comparable. */
    differenceMinor: number;
    reconciled: boolean;
  };
  /** Every distinct rate the order uses, sorted, for diagnostics. */
  rateKeys: RateKey[];
  issues: TaxIssue[];
  /** True when nothing blocking was found: the order may be sent. */
  ok: boolean;
}
