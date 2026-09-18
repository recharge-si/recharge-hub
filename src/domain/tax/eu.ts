import type { CountryRateConfig, RateKey } from "~/domain/tax/types";

/**
 * The EU VAT area and its reference rates.
 *
 * **This is configuration and validation data, not a tax engine.** Shopify's
 * transaction tax is what an order is filed with; these numbers say what the
 * app *expects* for a destination so a surprising rate can be flagged, and they
 * are what a merchant edits when a country changes its rate. Every value can
 * be overridden per shop, and every override is stored with its origin.
 *
 * Standard rates as published by the European Commission, checked September
 * 2026. Reduced rates are listed where a webshop is likely to meet them
 * (books, food, children's goods); a rate missing here is not a wrong rate, it
 * is one the merchant adds.
 */

/** ISO 3166-1 alpha-2 codes of the EU member states. */
export const EU_MEMBER_STATES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE",
] as const;

export type EuMemberState = (typeof EU_MEMBER_STATES)[number];

/**
 * Territories in the EU VAT area for goods that Shopify may report under a
 * code of their own. Northern Ireland stays in the VAT area for goods under
 * the Windsor Framework, and MetaKocka names it separately (§3).
 */
const EU_VAT_AREA_EXTRA = ["XI"] as const;

const EU_SET: ReadonlySet<string> = new Set([
  ...EU_MEMBER_STATES,
  ...EU_VAT_AREA_EXTRA,
]);

/** Whether a destination is inside the EU VAT area for goods. */
export function isEuVatArea(country: string | null | undefined): boolean {
  if (!country) return false;
  return EU_SET.has(country.trim().toUpperCase());
}

export const COUNTRY_NAMES: Record<string, string> = {
  AT: "Austria",
  BE: "Belgium",
  BG: "Bulgaria",
  HR: "Croatia",
  CY: "Cyprus",
  CZ: "Czechia",
  DK: "Denmark",
  EE: "Estonia",
  FI: "Finland",
  FR: "France",
  DE: "Germany",
  GR: "Greece",
  HU: "Hungary",
  IE: "Ireland",
  IT: "Italy",
  LV: "Latvia",
  LT: "Lithuania",
  LU: "Luxembourg",
  MT: "Malta",
  NL: "Netherlands",
  PL: "Poland",
  PT: "Portugal",
  RO: "Romania",
  SK: "Slovakia",
  SI: "Slovenia",
  ES: "Spain",
  SE: "Sweden",
  XI: "Northern Ireland",
  GB: "United Kingdom",
  CH: "Switzerland",
  NO: "Norway",
  US: "United States",
};

export function countryName(code: string | null | undefined): string {
  if (!code) return "Unknown";
  const upper = code.trim().toUpperCase();
  return COUNTRY_NAMES[upper] ?? upper;
}

interface ReferenceEntry {
  standard: RateKey;
  reduced?: RateKey[];
  superReduced?: RateKey;
  parking?: RateKey;
}

const REFERENCE: Record<EuMemberState, ReferenceEntry> = {
  AT: { standard: "20", reduced: ["10", "13"], parking: "13" },
  BE: { standard: "21", reduced: ["6", "12"], parking: "12" },
  BG: { standard: "20", reduced: ["9"] },
  HR: { standard: "25", reduced: ["5", "13"] },
  CY: { standard: "19", reduced: ["5", "9"] },
  CZ: { standard: "21", reduced: ["12"] },
  DK: { standard: "25" },
  EE: { standard: "24", reduced: ["9", "13"] },
  FI: { standard: "25.5", reduced: ["10", "14"] },
  FR: { standard: "20", reduced: ["5.5", "10"], superReduced: "2.1" },
  DE: { standard: "19", reduced: ["7"] },
  GR: { standard: "24", reduced: ["6", "13"] },
  HU: { standard: "27", reduced: ["5", "18"] },
  IE: { standard: "23", reduced: ["9", "13.5"], superReduced: "4.8", parking: "13.5" },
  IT: { standard: "22", reduced: ["5", "10"], superReduced: "4" },
  LV: { standard: "21", reduced: ["5", "12"] },
  LT: { standard: "21", reduced: ["5", "9"] },
  LU: { standard: "17", reduced: ["8"], superReduced: "3", parking: "14" },
  MT: { standard: "18", reduced: ["5", "7"] },
  NL: { standard: "21", reduced: ["9"] },
  PL: { standard: "23", reduced: ["5", "8"] },
  PT: { standard: "23", reduced: ["6", "13"], parking: "13" },
  RO: { standard: "21", reduced: ["11"] },
  SK: { standard: "23", reduced: ["5", "19"] },
  SI: { standard: "22", reduced: ["9.5", "5"] },
  ES: { standard: "21", reduced: ["10"], superReduced: "4" },
  SE: { standard: "25", reduced: ["6", "12"] },
};

/** Every reference rate, flattened, with its origin marked. */
export function referenceCountryRates(): CountryRateConfig[] {
  const rows: CountryRateConfig[] = [];

  for (const country of EU_MEMBER_STATES) {
    const entry = REFERENCE[country];
    rows.push({
      country,
      kind: "standard",
      rateKey: entry.standard,
      label: null,
      origin: "reference",
    });
    for (const rate of entry.reduced ?? []) {
      rows.push({ country, kind: "reduced", rateKey: rate, label: null, origin: "reference" });
    }
    if (entry.superReduced) {
      rows.push({
        country,
        kind: "super_reduced",
        rateKey: entry.superReduced,
        label: null,
        origin: "reference",
      });
    }
    if (entry.parking) {
      rows.push({ country, kind: "parking", rateKey: entry.parking, label: null, origin: "reference" });
    }
  }

  // Northern Ireland follows the UK's rates inside the EU VAT area for goods.
  rows.push({ country: "XI", kind: "standard", rateKey: "20", label: null, origin: "reference" });
  rows.push({ country: "XI", kind: "reduced", rateKey: "5", label: null, origin: "reference" });

  return rows;
}

/** The reference standard rate of a country, or null outside the table. */
export function referenceStandardRate(country: string | null | undefined): RateKey | null {
  if (!country) return null;
  const upper = country.trim().toUpperCase();
  if (upper === "XI") return "20";
  const entry = (REFERENCE as Record<string, ReferenceEntry | undefined>)[upper];
  return entry?.standard ?? null;
}
