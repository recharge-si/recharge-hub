import type { StockDirection } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import { writerForDirection } from "~/adapters/db/repositories/supply-source.server";
import { planDefaultWriteThrough } from "~/domain/supply/defaults";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * Shop-level stock and profit centre defaults (CLAUDE.md §7).
 *
 * Where stock is counted is almost always one answer for a whole store, and the
 * warehouse screen used to ask it once per warehouse. These are the answers a
 * supply source inherits, and `stockDirectionInherited` / `profitCenterInherited`
 * on the source record whether it did.
 *
 * **The effective value stays materialised on the source.** The sync engine and
 * the order writer read `supplySource.stockDirection` and
 * `supplySource.metakockaProfitCenter` exactly as they did before this existed,
 * with no default to resolve. Changing a default therefore has to write through
 * to the sources that inherit it, which is what `saveSupplyDefaults` does. The
 * alternative — a nullable column meaning "ask the shop" — pushes that
 * resolution into every reader, including the two places where getting it wrong
 * publishes the wrong stock.
 */

export interface SupplyDefaults {
  defaultStockDirection: StockDirection;
  defaultProfitCenter: string | null;
}

/** Section 7 calls MetaKocka-counted the normal case, so that is the fallback. */
export const FALLBACK_DEFAULTS: SupplyDefaults = {
  defaultStockDirection: "mk_to_shopify",
  defaultProfitCenter: null,
};

async function shopIdFor(principal: Principal): Promise<string> {
  const domain = shopDomainOf(principal);
  const shop = await prisma.shop.findUnique({
    where: { domain },
    select: { id: true },
  });
  if (!shop) throw new Error(`No shop record for ${domain}`);
  return shop.id;
}

export async function getSupplyDefaults(
  principal: Principal,
): Promise<SupplyDefaults> {
  const row = await prisma.supplySetting.findFirst({
    where: { shop: { domain: shopDomainOf(principal) } },
    select: { defaultStockDirection: true, defaultProfitCenter: true },
  });

  return row ?? FALLBACK_DEFAULTS;
}

export interface SaveDefaultsResult {
  /** Sources whose effective settings were rewritten to follow the default. */
  updated: number;
  /**
   * Names of inherited sources left alone because taking the default would
   * have made them a second writer for their Shopify location. Never silently
   * dropped: the caller tells the merchant.
   */
  blocked: string[];
}

/**
 * Saves the defaults and writes them through to every source that inherits.
 *
 * Two rules survive the write-through, because they are the two that cannot be
 * expressed as a default:
 *
 *  - A source with no Shopify location gets `none` whatever the default says.
 *    There is nowhere to copy stock to or from. It stays flagged as inheriting,
 *    so connecting a location later picks the default up.
 *  - A location has one writer (§7). If two inherited sources point at the same
 *    location and the default is `mk_to_shopify`, applying it to both would put
 *    them in a loop overwriting each other. The first keeps the claim, the rest
 *    are left as they are and named in the result.
 */
export async function saveSupplyDefaults(
  principal: Principal,
  defaults: SupplyDefaults,
): Promise<SaveDefaultsResult> {
  const shopId = await shopIdFor(principal);

  const sources = await prisma.supplySource.findMany({
    where: { shopId },
    select: {
      id: true,
      name: true,
      shopifyLocationId: true,
      stockDirection: true,
      stockDirectionInherited: true,
    },
    orderBy: [{ priority: "asc" }, { code: "asc" }],
  });

  // The two §7 rules that survive a default live in domain/supply/defaults.ts,
  // where they can be tested without a database.
  const { writes, blocked } = planDefaultWriteThrough(
    sources,
    defaults.defaultStockDirection,
  );

  await prisma.$transaction([
    prisma.supplySetting.upsert({
      where: { shopId },
      create: { shopId, ...defaults },
      update: defaults,
    }),

    ...writes.map((write) =>
      prisma.supplySource.updateMany({
        where: { id: write.id, shopId },
        data: {
          stockDirection: write.direction,
          inventoryWriter: writerForDirection(write.direction),
        },
      }),
    ),

    prisma.supplySource.updateMany({
      where: { shopId, profitCenterInherited: true },
      data: { metakockaProfitCenter: defaults.defaultProfitCenter },
    }),
  ]);

  return { updated: writes.length, blocked };
}
