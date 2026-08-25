/**
 * What a change to the shop's stock default means for each supply source.
 *
 * Pure (CLAUDE.md §5): no database, no clock, no MetaKocka. The repository
 * loads the sources, calls this, and writes what it returns.
 *
 * The decision is worth isolating because it is where two rules from §7 meet,
 * and both of them are easy to lose in a query:
 *
 *  - A source with no Shopify location has nowhere to copy stock to or from,
 *    whatever the default says. It stays flagged as inheriting, so connecting a
 *    location later picks the default up on the next save.
 *  - A Shopify location has exactly one writer. Applying a `mk_to_shopify`
 *    default to two sources pointing at the same location would put them in a
 *    loop overwriting each other's numbers, which is the failure §7 exists to
 *    prevent.
 *
 * A source that explicitly chose `mk_to_shopify` outranks a default, so its
 * claim on a location is counted first and is never disturbed here. The
 * defaults are what the merchant has not thought about; the overrides are what
 * they have.
 */

export type StockDirection = "mk_to_shopify" | "shopify_to_mk" | "none";

export interface SourceSnapshot {
  id: string;
  /** Shown to the merchant when a source has to be left alone. */
  name: string;
  shopifyLocationId: string | null;
  stockDirection: StockDirection;
  stockDirectionInherited: boolean;
}

export interface DefaultWriteThrough {
  /** Sources to rewrite, with the direction each should end up holding. */
  writes: { id: string; direction: StockDirection }[];
  /**
   * Names of inherited sources left exactly as they were, because taking the
   * default would have made them a second writer for their location. Never
   * dropped silently: the caller says so.
   */
  blocked: string[];
}

export function planDefaultWriteThrough(
  sources: SourceSnapshot[],
  defaultDirection: StockDirection,
): DefaultWriteThrough {
  const claimed = new Set(
    sources
      .filter(
        (source) =>
          !source.stockDirectionInherited &&
          source.stockDirection === "mk_to_shopify" &&
          source.shopifyLocationId !== null,
      )
      .map((source) => source.shopifyLocationId as string),
  );

  const writes: DefaultWriteThrough["writes"] = [];
  const blocked: string[] = [];

  for (const source of sources) {
    if (!source.stockDirectionInherited) continue;

    if (source.shopifyLocationId === null) {
      writes.push({ id: source.id, direction: "none" });
      continue;
    }

    if (defaultDirection === "mk_to_shopify") {
      if (claimed.has(source.shopifyLocationId)) {
        blocked.push(source.name);
        continue;
      }
      claimed.add(source.shopifyLocationId);
    }

    writes.push({ id: source.id, direction: defaultDirection });
  }

  return { writes, blocked };
}
