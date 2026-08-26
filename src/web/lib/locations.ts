import type { StockDirectionValue } from "~/domain/readiness";

/**
 * The vocabulary the locations screens and guided setup share.
 *
 * Kept out of `locations.server.ts` because the option value below is rendered
 * in the browser: a `.server` module is stripped from the client bundle, and a
 * constant that disappears there is a select whose "use the store default"
 * option silently becomes undefined.
 */

/**
 * The option value meaning "take the shop default".
 *
 * Filtered out of the register wherever options are built, so it can never also
 * be a real profit centre name and the reading is never ambiguous.
 */
export const INHERIT = "__use_default__";

const DIRECTIONS = ["mk_to_shopify", "shopify_to_mk", "none"] as const;

export function toDirection(raw: string): StockDirectionValue {
  return (DIRECTIONS as readonly string[]).includes(raw)
    ? (raw as StockDirectionValue)
    : "none";
}

/** Derived from the warehouse mark so nobody has to invent a code. */
export function codeForMark(mark: string): string {
  const cleaned = mark
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "SOURCE";
}
