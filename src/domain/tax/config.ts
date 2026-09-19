import { referenceCountryRates } from "~/domain/tax/eu";
import { sameRate } from "~/domain/tax/rates";
import type {
  CountryRateConfig,
  RateKey,
  TaxConfig,
  TaxMappingConfig,
  VatRegistrationConfig,
} from "~/domain/tax/types";

/**
 * Reading a tax configuration, so the engine and the screens ask the same
 * questions the same way.
 */

/**
 * The reference table with the merchant's own rows laid over it.
 *
 * A merchant row for a (country, kind) replaces the reference row of that
 * kind; a merchant row of a kind the table has none of is added. The
 * reference is never mutated, so a merchant can always see what the app
 * expected before they changed it.
 */
export function effectiveCountryRates(
  merchant: CountryRateConfig[],
): CountryRateConfig[] {
  const reference = referenceCountryRates();
  const replaced = new Set(
    merchant.map((row) => `${row.country.toUpperCase()}:${row.kind}`),
  );

  return [
    ...reference.filter((row) => !replaced.has(`${row.country}:${row.kind}`)),
    ...merchant.map((row) => ({ ...row, country: row.country.toUpperCase() })),
  ].sort(
    (a, b) =>
      a.country.localeCompare(b.country) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.rateKey.localeCompare(b.rateKey),
  );
}

const KIND_ORDER: CountryRateConfig["kind"][] = [
  "standard",
  "reduced",
  "super_reduced",
  "parking",
  "zero",
  "other",
];

/** The rates the configuration expects for a country. */
export function ratesFor(
  config: TaxConfig,
  country: string | null,
): CountryRateConfig[] {
  if (!country) return [];
  const upper = country.toUpperCase();
  return config.countryRates.filter((row) => row.country === upper);
}

/** The configured standard rate of a country, or null. */
export function standardRateFor(
  config: TaxConfig,
  country: string | null,
): RateKey | null {
  return (
    ratesFor(config, country).find((row) => row.kind === "standard")?.rateKey ??
    null
  );
}

/** Whether a rate is one the configuration lists for the country. */
export function isExpectedRate(
  config: TaxConfig,
  country: string | null,
  rateKey: RateKey,
): boolean {
  return ratesFor(config, country).some((row) =>
    sameRate(row.rateKey, rateKey),
  );
}

/** An enabled registration of a kind, optionally in a country. */
export function registrationFor(
  config: TaxConfig,
  kind: VatRegistrationConfig["kind"],
  country?: string | null,
): VatRegistrationConfig | null {
  const upper = country?.toUpperCase() ?? null;
  return (
    config.registrations.find(
      (row) =>
        row.enabled &&
        row.kind === kind &&
        (upper === null || row.country.toUpperCase() === upper),
    ) ?? null
  );
}

/** The enabled mapping for a rate, or null. */
export function mappingFor(
  config: TaxConfig,
  rateKey: RateKey | null,
): TaxMappingConfig | null {
  if (rateKey === null) return null;
  return (
    config.mappings.find(
      (row) => row.enabled && sameRate(row.rateKey, rateKey),
    ) ?? null
  );
}

/** Whether OSS is on: the switch, or an enabled OSS registration. */
export function ossActive(config: TaxConfig): boolean {
  return config.ossEnabled || registrationFor(config, "oss") !== null;
}
