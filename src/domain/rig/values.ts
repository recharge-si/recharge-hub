import type { MetafieldValue } from "~/domain/sales/types";

/**
 * Reading the metafield values the store really holds (docs/rig-builder.md §
 * Stored formats). Pure. Every reader answers null for a value it cannot read
 * with certainty; nothing here guesses a unit or a number.
 *
 * Shapes seen in production:
 * - `number_decimal` / `number_integer`: `"5.0"`, a plain number as text.
 * - `dimension`, `weight`, `volume`: `{"value":37.0,"unit":"CENTIMETERS"}`
 *   as a JSON string.
 * - `single_line_text_field`: `"rdm"`, `"power_box"`.
 * - `list.single_line_text_field`: `"[\"rdm\",\"sdm\"]"`.
 */

export type Quantity = "cm" | "kg" | "m2" | "l";

/** Factors from a Shopify unit name to the quantity's base unit. */
const UNITS: Readonly<Record<Quantity, Readonly<Record<string, number>>>> = {
  cm: {
    CENTIMETERS: 1,
    MILLIMETERS: 0.1,
    METERS: 100,
    INCHES: 2.54,
    FEET: 30.48,
    YARDS: 91.44,
  },
  kg: { KILOGRAMS: 1, GRAMS: 0.001, POUNDS: 0.45359237, OUNCES: 0.0283495231 },
  m2: { SQUARE_METERS: 1, SQUARE_CENTIMETERS: 0.0001, SQUARE_FEET: 0.09290304 },
  l: { LITERS: 1, MILLILITERS: 0.001, CENTILITERS: 0.01, US_GALLONS: 3.785411784 },
};

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** A plain number written as text; comma decimals are accepted. */
export function parsePlainNumber(raw: string): number | null {
  const text = raw.trim().replace(",", ".");
  if (text === "" || !/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * A number. A measurement type (`dimension`, `weight`, `volume`) carries its
 * unit and is converted to `quantity`; a unit that is not known gives null,
 * never a guess. A plain number is taken to be in the unit its key names (cm
 * for `*_cm`, and so on).
 */
export function readNumber(
  entry: MetafieldValue | undefined,
  quantity: Quantity | null = null,
): number | null {
  if (!entry || typeof entry.value !== "string") return null;
  const raw = entry.value.trim();
  if (raw === "") return null;
  if (raw.startsWith("{")) {
    const parsed = parseJson(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { value, unit } = parsed as { value?: unknown; unit?: unknown };
    const number =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? parsePlainNumber(value)
          : null;
    if (number === null || !Number.isFinite(number)) return null;
    if (quantity === null) return typeof unit === "string" ? null : number;
    if (typeof unit !== "string") return null;
    const factor = UNITS[quantity][unit.toUpperCase()];
    return factor === undefined ? null : round(number * factor);
  }
  return parsePlainNumber(raw);
}

/** A single code: trimmed and lower-cased; text with a JSON array is not a single code. */
export function readCode(entry: MetafieldValue | undefined): string | null {
  if (!entry || typeof entry.value !== "string") return null;
  const text = entry.value.trim().toLowerCase();
  if (text === "" || text.startsWith("[") || text.startsWith("{")) return null;
  return text;
}

/**
 * A list of codes: the stored JSON array, sorted and without repeats. A bare
 * code is a list of one. Anything unreadable, or an empty list, is null (no
 * data), not an empty list that would mean "compatible with nothing".
 */
export function readList(entry: MetafieldValue | undefined): string[] | null {
  if (!entry || typeof entry.value !== "string") return null;
  const raw = entry.value.trim();
  if (raw === "") return null;
  let items: unknown[];
  if (raw.startsWith("[")) {
    const parsed = parseJson(raw);
    if (!Array.isArray(parsed)) return null;
    items = parsed;
  } else if (raw.startsWith("{")) {
    return null;
  } else {
    items = [raw];
  }
  const codes = items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== "");
  return codes.length === 0 ? null : [...new Set(codes)].sort();
}
