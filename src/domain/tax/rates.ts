import type { RateKey } from "~/domain/tax/types";

/**
 * Rates as integers, so 9.5%, 0.095 and "9.50" are one value.
 *
 * A rate is held as parts per million of the base: 22% is 220 000, 9.5% is
 * 95 000. Shopify reports rates as decimals with up to four places (0.0925),
 * MetaKocka takes `tax_factor` as a decimal string, and merchants type
 * percentages. All three go through here, and nothing downstream compares
 * floating-point numbers to decide whether two rates are the same.
 *
 * Money arithmetic is BigInt over minor units (docs/BUILD_SPEC.md §15, §31 of
 * the brief): `gross × 10^6 / (10^6 + ppm)` cannot lose a cent to a double.
 */

const SCALE = 1_000_000n;

/** Parses "22", "9,5", "0.095" (as a factor) or 0.22 into ppm. Null when nonsense. */
function parseDecimal(raw: string | number): bigint | null {
  const text = String(raw).trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;

  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = text.replace("-", "").split(".");
  // Six places of the *value* is what SCALE holds; anything finer is rounded.
  const digits = `${whole}${fraction.padEnd(6, "0").slice(0, 6)}`;
  let value = BigInt(digits);
  const seventh = fraction.charAt(6);
  if (seventh !== "" && Number(seventh) >= 5) value += 1n;
  return negative ? -value : value;
}

/** A percentage ("22", "9.5") to ppm of the base. Null when unreadable or out of range. */
export function percentToPpm(percent: string | number): number | null {
  const parsed = parseDecimal(percent);
  if (parsed === null) return null;
  // Percent has two more places than a factor: 22 → 0.22 → 220 000 ppm.
  const ppm = parsed / 100n;
  if (ppm < 0n || ppm > SCALE) return null;
  return Number(ppm);
}

/** A factor ("0.22", 0.095) to ppm. Null when unreadable or out of range. */
export function factorToPpm(factor: string | number): number | null {
  const parsed = parseDecimal(factor);
  if (parsed === null || parsed < 0n || parsed > SCALE) return null;
  return Number(parsed);
}

/** ppm to the canonical percentage string: 220 000 → "22", 95 000 → "9.5". */
export function ppmToRateKey(ppm: number): RateKey {
  const whole = Math.trunc(ppm / 10_000);
  const fraction = (ppm % 10_000)
    .toString()
    .padStart(4, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** ppm to the `tax_factor` decimal string MetaKocka takes: 220 000 → "0.22". */
export function ppmToFactor(ppm: number): string {
  const whole = Math.trunc(ppm / 1_000_000);
  const fraction = (ppm % 1_000_000)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** Canonical key from a percentage the merchant typed. Null when invalid. */
export function rateKeyFromPercent(percent: string | number): RateKey | null {
  const ppm = percentToPpm(percent);
  return ppm === null ? null : ppmToRateKey(ppm);
}

/** Canonical key from a Shopify decimal rate or a MetaKocka factor. */
export function rateKeyFromFactor(factor: string | number): RateKey | null {
  const ppm = factorToPpm(factor);
  return ppm === null ? null : ppmToRateKey(ppm);
}

/** The ppm behind a canonical key. Null when the key is not one. */
export function rateKeyToPpm(rateKey: RateKey): number | null {
  return percentToPpm(rateKey);
}

/** "22" → "0.22". Null when the key is not a rate. */
export function rateKeyToFactor(rateKey: RateKey): string | null {
  const ppm = rateKeyToPpm(rateKey);
  return ppm === null ? null : ppmToFactor(ppm);
}

/** "22" → "22%", "9.5" → "9.5%". */
export function formatRateKey(rateKey: RateKey): string {
  return `${rateKey}%`;
}

/** Whether two keys, factors or percentages name the same rate. */
export function sameRate(a: RateKey | null, b: RateKey | null): boolean {
  if (a === null || b === null) return false;
  const left = rateKeyToPpm(a);
  const right = rateKeyToPpm(b);
  return left !== null && left === right;
}

/** Sum of several rate keys, for a line carrying stacked tax lines. */
export function sumRateKeys(keys: RateKey[]): RateKey | null {
  let total = 0;
  for (const key of keys) {
    const ppm = rateKeyToPpm(key);
    if (ppm === null) return null;
    total += ppm;
  }
  return ppmToRateKey(total);
}

/**
 * Half-up, away from zero, on a BigInt division.
 *
 * Away from zero rather than toward +∞ so a refund (the same figures with the
 * sign flipped) rounds to exactly the negation of the sale — `domain/money/tax`
 * explains why a one-cent difference on a credit note is a reconciliation for a
 * person.
 */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n % d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** The tax inside a gross amount at `ppm`: 20900 at 220 000 → 3769 (209.00 → 37.69). */
export function taxInGrossMinor(grossMinor: number, ppm: number): number {
  if (ppm <= 0) return 0;
  const gross = BigInt(Math.trunc(grossMinor));
  const net = divideRounded(gross * SCALE, SCALE + BigInt(ppm));
  return nonNegativeZero(Number(gross - net));
}

/** `-0` compares equal to 0 and is not the same value to Object.is or a Map. */
function nonNegativeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/** The tax on a net amount at `ppm`: 17131 at 220 000 → 3769. */
export function taxOnNetMinor(netMinor: number, ppm: number): number {
  if (ppm <= 0) return 0;
  const net = BigInt(Math.trunc(netMinor));
  return nonNegativeZero(Number(divideRounded(net * BigInt(ppm), SCALE)));
}
