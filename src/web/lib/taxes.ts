import { COUNTRY_NAMES, EU_MEMBER_STATES, countryName } from "~/domain/tax/eu";
import { formatRateKey } from "~/domain/tax/rates";
import type {
  CustomerKind,
  Jurisdiction,
  TaxIssueKind,
  TaxSource,
  TaxTreatment,
} from "~/domain/tax/types";

/**
 * The tax domain in the merchant's words (docs/ui-conventions.md: one term per
 * concept, and the code's names never reach a screen).
 */

export const TREATMENT_LABEL: Record<TaxTreatment | "MIXED", string> = {
  DOMESTIC_VAT: "Domestic VAT",
  EU_OSS: "EU OSS",
  EU_DISTANCE_SALE: "EU distance sale, home rate",
  EU_REVERSE_CHARGE: "EU reverse charge",
  EU_LOCAL_REGISTRATION: "Local EU registration",
  NON_EU_LOCAL_REGISTRATION: "Local registration outside the EU",
  ZERO_RATED: "Zero-rated",
  TAX_EXEMPT: "Tax exempt",
  NON_EU_EXPORT: "Export outside the EU",
  IMPORT: "Import tax",
  NO_TAX: "Not taxable",
  MANUAL_OVERRIDE: "Manual override",
  UNKNOWN: "Not determined",
  MIXED: "Mixed",
};

export const SOURCE_LABEL: Record<TaxSource | "MIXED", string> = {
  SHOPIFY: "Shopify",
  COUNTRY_DEFAULT: "Home rate (fallback)",
  PRODUCT_RULE: "Product override",
  MANUAL_OVERRIDE: "Override",
  FALLBACK: "Inherited from the order",
  MIXED: "Mixed",
};

export const CUSTOMER_KIND_LABEL: Record<CustomerKind, string> = {
  b2c: "Consumer",
  b2b: "Business",
  unknown: "Unknown",
};

export const JURISDICTION_LABEL: Record<Jurisdiction, string> = {
  domestic: "Home country",
  eu: "EU",
  non_eu: "Outside the EU",
  unknown: "Unknown",
};

export const ISSUE_LABEL: Record<TaxIssueKind, string> = {
  mapping_missing: "MetaKocka mapping missing",
  treatment_unknown: "Treatment not determined",
  data_insufficient: "Shopify breakdown missing",
  destination_missing: "Destination missing",
  reconciliation_failed: "Tax does not add up",
  registration_error: "Registration not configured",
  rate_mismatch: "Rate differs from the configured rates",
};

/** The treatments a person may choose in an override, with what they mean. */
export const OVERRIDE_TREATMENTS: { value: TaxTreatment; label: string }[] = [
  { value: "NON_EU_EXPORT", label: TREATMENT_LABEL.NON_EU_EXPORT },
  { value: "EU_REVERSE_CHARGE", label: TREATMENT_LABEL.EU_REVERSE_CHARGE },
  { value: "TAX_EXEMPT", label: TREATMENT_LABEL.TAX_EXEMPT },
  { value: "ZERO_RATED", label: TREATMENT_LABEL.ZERO_RATED },
  { value: "NO_TAX", label: TREATMENT_LABEL.NO_TAX },
  { value: "DOMESTIC_VAT", label: TREATMENT_LABEL.DOMESTIC_VAT },
  { value: "EU_OSS", label: TREATMENT_LABEL.EU_OSS },
  { value: "EU_DISTANCE_SALE", label: TREATMENT_LABEL.EU_DISTANCE_SALE },
  { value: "EU_LOCAL_REGISTRATION", label: TREATMENT_LABEL.EU_LOCAL_REGISTRATION },
  { value: "NON_EU_LOCAL_REGISTRATION", label: TREATMENT_LABEL.NON_EU_LOCAL_REGISTRATION },
];

export interface CountryOption {
  value: string;
  label: string;
}

/** Every country the app knows a name for, EU first, sorted by name. */
export function countryOptions(): CountryOption[] {
  const eu = new Set<string>(EU_MEMBER_STATES);
  return Object.keys(COUNTRY_NAMES)
    .map((code) => ({ value: code, label: countryName(code) }))
    .sort((a, b) => {
      const aEu = eu.has(a.value) ? 0 : 1;
      const bEu = eu.has(b.value) ? 0 : 1;
      return aEu - bEu || a.label.localeCompare(b.label);
    });
}

/** "22%" for a key, "—" for none. */
export function formatRate(rateKey: string | null): string {
  return rateKey === null ? "—" : formatRateKey(rateKey);
}
