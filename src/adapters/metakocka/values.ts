import { z } from "zod";

/**
 * MetaKocka's wire values, normalised at the boundary (CLAUDE.md section 3).
 *
 * Numbers arrive as strings. Booleans arrive as the strings "true" and "false".
 * Dates are inconsistent: ISO-with-offset in most fields, dd.mm.yyyy in
 * `mark_paid`. Decimal commas appear in the documented examples
 * (`"gross_weight": "0,8"`).
 *
 * No raw MetaKocka value may reach domain code, so every one of these is a Zod
 * transform used inside the response schemas rather than a helper called later.
 */

/** "true" / "false" as strings, which is how MetaKocka sends booleans. */
export const mkBoolean = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0", ""])])
  .transform((value) => {
    if (typeof value === "boolean") return value;
    return value === "true" || value === "1";
  });

function normaliseDecimalString(raw: string): string {
  const value = raw.trim();

  // "1.234,56": dot groups thousands, comma is the decimal separator.
  if (value.includes(".") && value.includes(",")) {
    return value.replace(/\./g, "").replace(",", ".");
  }

  // "0,8": comma is the decimal separator.
  return value.replace(",", ".");
}

/**
 * A decimal that is safe to hold as a JS number: quantities, weights, factors.
 * Never use this for money -- see `mkMinorUnits`.
 */
export const mkDecimal = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    if (typeof value === "number") return value;

    const parsed = Number(normaliseDecimalString(value));
    if (!Number.isFinite(parsed)) {
      ctx.addIssue({
        code: "custom",
        message: `Expected a decimal, received ${JSON.stringify(value)}`,
      });
      return z.NEVER;
    }
    return parsed;
  });

export const mkInteger = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const parsed =
      typeof value === "number" ? value : Number(normaliseDecimalString(value));

    if (!Number.isInteger(parsed)) {
      ctx.addIssue({
        code: "custom",
        message: `Expected an integer, received ${JSON.stringify(value)}`,
      });
      return z.NEVER;
    }
    return parsed;
  });

/**
 * Money, as integer minor units (CLAUDE.md section 15: never float).
 *
 * The conversion is done on the digit string rather than by multiplying a
 * parsed float, because 19.99 * 100 is 1998.9999999999998 and a rounding step
 * there is exactly the one-cent drift section 8.6 forbids.
 */
export function toMinorUnits(raw: string | number, decimals = 2): number {
  const value = normaliseDecimalString(String(raw));

  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(value);
  if (!match) {
    throw new RangeError(`Not a decimal amount: ${JSON.stringify(raw)}`);
  }

  const [, sign = "", whole = "0", fraction = ""] = match;

  // Pad to the required precision, then round half-up on the first dropped digit.
  const padded = fraction.padEnd(decimals + 1, "0");
  const kept = padded.slice(0, decimals);
  const nextDigit = Number(padded[decimals] ?? "0");

  const magnitude =
    BigInt(`${whole || "0"}${kept}`) + BigInt(nextDigit >= 5 ? 1 : 0);
  const signed = sign === "-" ? -magnitude : magnitude;

  if (
    signed > BigInt(Number.MAX_SAFE_INTEGER) ||
    signed < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new RangeError(`Amount out of safe integer range: ${String(raw)}`);
  }

  return Number(signed);
}

export const mkMinorUnits = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    try {
      return toMinorUnits(value);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: `Expected a monetary amount, received ${JSON.stringify(value)}`,
      });
      return z.NEVER;
    }
  });

const ISO_DATE_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})(Z|[+-]\d{2}:\d{2})?$/;
const DOTTED_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;

/**
 * The common case: `"2024-09-12+02:00"`, a date with an offset and no time.
 * `new Date()` does not parse that shape reliably, so it is matched explicitly.
 */
export function parseMkDate(raw: string): Date {
  const value = raw.trim();

  const iso = ISO_DATE_WITH_OFFSET.exec(value);
  if (iso) {
    const [, year, month, day, offset] = iso;
    const parsed = new Date(`${year}-${month}-${day}T00:00:00${offset ?? "Z"}`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  // `mark_paid.date` only, but tolerated anywhere rather than failing a whole
  // document over one field.
  const dotted = DOTTED_DATE.exec(value);
  if (dotted) {
    const [, day, month, year] = dotted;
    const parsed = new Date(
      `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}T00:00:00Z`,
    );
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const fallback = new Date(value);
  if (!Number.isNaN(fallback.getTime())) return fallback;

  throw new RangeError(`Unrecognised MetaKocka date: ${JSON.stringify(raw)}`);
}

export const mkDate = z.string().transform((value, ctx) => {
  try {
    return parseMkDate(value);
  } catch {
    ctx.addIssue({
      code: "custom",
      message: `Unrecognised date ${JSON.stringify(value)}`,
    });
    return z.NEVER;
  }
});

/**
 * Outbound only. `mark_paid.date` is dd.mm.yyyy while the rest of the same
 * payload is ISO (CLAUDE.md section 8.7), so it is formatted explicitly at the
 * boundary rather than by whatever `toLocaleDateString` does on the host.
 */
export function formatMkDottedDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${date.getUTCFullYear()}`;
}
