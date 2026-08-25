import type {
  InventoryWriter,
  StockDirection,
  SupplySource,
  SupplySourceKind,
} from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * Supply sources and the cached MetaKocka warehouse list (CLAUDE.md §6).
 * Every query is filtered by shop here, so route code cannot forget (§9).
 */

export type { SupplySource };

async function shopIdFor(principal: Principal): Promise<string> {
  const domain = shopDomainOf(principal);
  const shop = await prisma.shop.findUnique({
    where: { domain },
    select: { id: true },
  });
  if (!shop) throw new Error(`No shop record for ${domain}`);
  return shop.id;
}

export async function listSupplySources(
  principal: Principal,
): Promise<SupplySource[]> {
  return prisma.supplySource.findMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    orderBy: [{ priority: "asc" }, { code: "asc" }],
  });
}

export async function findSupplySource(
  principal: Principal,
  id: string,
): Promise<SupplySource | null> {
  return prisma.supplySource.findFirst({
    where: { id, shop: { domain: shopDomainOf(principal) } },
  });
}

export interface SupplySourceInput {
  code: string;
  name: string;
  kind: SupplySourceKind;
  shopifyLocationId: string | null;
  inventoryWriter: InventoryWriter;
  /** Which side holds the true stock, and therefore which way it is copied. */
  stockDirection: StockDirection;
  /** True when `stockDirection` came from the shop default (CLAUDE.md §7). */
  stockDirectionInherited: boolean;
  metakockaWarehouse: string | null;
  metakockaWarehouseMkId: string | null;
  metakockaProfitCenter: string | null;
  /** True when `metakockaProfitCenter` came from the shop default. */
  profitCenterInherited: boolean;
  priority: number;
  leadTimeDays: number;
  defaultDeliveryType: string | null;
  canSplit: boolean;
  enabled: boolean;
}

/**
 * Who may write inventory into the Shopify location, given which way stock is
 * copied (CLAUDE.md §7).
 *
 * Derived rather than asked. Section 7 makes this app the writer for exactly
 * one case, and offering the merchant a choice that section 7 then refuses
 * would be a validation error for a decision they were never really given.
 * Shared so the settings form and the shop-default recompute cannot drift.
 */
export function writerForDirection(
  direction: StockDirection,
): InventoryWriter {
  if (direction === "mk_to_shopify") return "metakocka";
  if (direction === "shopify_to_mk") return "manual";
  return "external";
}

export async function upsertSupplySource(
  principal: Principal,
  id: string | null,
  input: SupplySourceInput,
): Promise<SupplySource> {
  const shopId = await shopIdFor(principal);

  if (id) {
    // updateMany keeps the shop filter on the write, so an id from another
    // tenant updates nothing rather than the wrong row.
    const { count } = await prisma.supplySource.updateMany({
      where: { id, shopId },
      data: input,
    });
    if (count === 0) throw new Error("Supply source not found");

    const updated = await prisma.supplySource.findFirst({
      where: { id, shopId },
    });
    return updated!;
  }

  return prisma.supplySource.create({ data: { shopId, ...input } });
}

/**
 * Releases a source's Shopify location and stops it syncing, keeping the row.
 *
 * Used when a location changes hands: two sources holding one location is the
 * state section 7 forbids, so the old one lets go before the new one claims it.
 * Deleting instead would take the audit trail and any allocation that
 * referenced the source with it, and those outlive the mapping.
 *
 * The inheritance flags are left exactly as they were. A location reconnected
 * later should behave the way the merchant last configured it, not revert to
 * following a default they had overridden.
 */
export async function detachSupplySource(
  principal: Principal,
  id: string,
): Promise<void> {
  await prisma.supplySource.updateMany({
    where: { id, shop: { domain: shopDomainOf(principal) } },
    data: {
      shopifyLocationId: null,
      stockDirection: "none",
      inventoryWriter: "external",
      enabled: false,
    },
  });
}

export async function deleteSupplySource(
  principal: Principal,
  id: string,
): Promise<void> {
  await prisma.supplySource.deleteMany({
    where: { id, shop: { domain: shopDomainOf(principal) } },
  });
}

export async function codeIsTaken(
  principal: Principal,
  code: string,
  exceptId: string | null,
): Promise<boolean> {
  const existing = await prisma.supplySource.findFirst({
    where: { code, shop: { domain: shopDomainOf(principal) } },
    select: { id: true },
  });

  return existing !== null && existing.id !== exceptId;
}

/* -------------------------------------------------------------------------- */
/* Cached MetaKocka warehouses                                                */
/* -------------------------------------------------------------------------- */

export interface CachedWarehouse {
  mkId: string;
  mark: string;
  name: string;
  isMain: boolean;
  isActive: boolean;
  syncedAt: Date;
}

export async function listCachedWarehouses(
  principal: Principal,
): Promise<CachedWarehouse[]> {
  const rows = await prisma.metakockaWarehouse.findMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    orderBy: [{ isMain: "desc" }, { mark: "asc" }],
  });

  return rows.map((row) => ({
    mkId: row.mkId,
    mark: row.mark,
    name: row.name,
    isMain: row.isMain,
    isActive: row.isActive,
    syncedAt: row.syncedAt,
  }));
}

export interface WarehouseSnapshot {
  mkId: string;
  mark: string;
  name: string;
  isMain: boolean;
  isActive: boolean;
  includeInStockInfo: boolean;
}

export interface WarehouseReloadResult {
  /** Sources whose warehouse is genuinely gone from MetaKocka. */
  retired: string[];
  /** Warehouses whose mark or name changed, as "old -> new". */
  renamed: string[];
}

/**
 * Replaces the cached list with what MetaKocka just returned.
 *
 * Everything here turns on one distinction: a warehouse that was **renamed** is
 * still the same warehouse, and a warehouse that was **deleted** is not.
 * MetaKocka's `mk_id` is stable across a rename and its `mark` is not, so the
 * cache is keyed on the id. Keying it on the mark, as this once did, made every
 * rename look like a deletion — the source stopped syncing, lost its Shopify
 * location and told the merchant their warehouse had vanished, when all they had
 * done was correct a typo in its name.
 *
 * So a rename follows through: the cached row keeps its identity and the supply
 * source's `metakockaWarehouse` is rewritten to the new mark, because documents
 * are addressed by mark and a stale one would file orders against the company
 * default without complaining (§3).
 *
 * A genuine deletion still retires its source. Deleting the cached row alone is
 * not enough: the source outlives it, and while it still reads `mk_to_shopify`
 * it goes on writing stock into a Shopify location for a warehouse that no
 * longer exists, and goes on holding that location's single write claim (§7)
 * against every other warehouse. A retired source keeps its row — the audit
 * trail and any allocation that referenced it outlive the warehouse — but stops
 * syncing and lets the location go.
 *
 * Returns what changed, so the caller can say so rather than rearranging the
 * merchant's configuration silently.
 */
export async function replaceCachedWarehouses(
  principal: Principal,
  warehouses: WarehouseSnapshot[],
): Promise<WarehouseReloadResult> {
  const shopId = await shopIdFor(principal);
  const now = new Date();
  const liveIds = warehouses.map((w) => w.mkId);

  const cached = await prisma.metakockaWarehouse.findMany({
    where: { shopId },
    select: { mkId: true, mark: true, name: true },
  });
  const cachedById = new Map(cached.map((row) => [row.mkId, row]));

  const renamed: string[] = [];
  const markChanges: { mkId: string; mark: string; name: string }[] = [];
  for (const warehouse of warehouses) {
    const before = cachedById.get(warehouse.mkId);
    if (!before) continue;
    if (before.mark === warehouse.mark && before.name === warehouse.name)
      continue;

    renamed.push(
      `${before.name} (${before.mark}) -> ${warehouse.name} (${warehouse.mark})`,
    );
    if (before.mark !== warehouse.mark) {
      markChanges.push({
        mkId: warehouse.mkId,
        mark: warehouse.mark,
        name: warehouse.name,
      });
    }
  }

  // Sources whose warehouse is not in the new list at all. Matched by id where
  // we have one; sources saved before ids were stored fall back to the mark.
  const marks = warehouses.map((w) => w.mark);
  const orphans = await prisma.supplySource.findMany({
    where: {
      shopId,
      OR: [{ stockDirection: { not: "none" } }, { enabled: true }],
      AND: [
        { metakockaWarehouse: { not: null } },
        {
          OR: [
            { metakockaWarehouseMkId: { not: null, notIn: liveIds } },
            {
              metakockaWarehouseMkId: null,
              metakockaWarehouse: { notIn: marks },
            },
          ],
        },
      ],
    },
    select: { id: true, name: true },
  });

  await prisma.$transaction([
    prisma.metakockaWarehouse.deleteMany({
      where: { shopId, mkId: { notIn: liveIds } },
    }),

    // Renames first, so a source that merely moved is never seen as an orphan.
    ...markChanges.map((change) =>
      prisma.supplySource.updateMany({
        where: { shopId, metakockaWarehouseMkId: change.mkId },
        data: { metakockaWarehouse: change.mark, name: change.name },
      }),
    ),

    ...(orphans.length > 0
      ? [
          prisma.supplySource.updateMany({
            where: { id: { in: orphans.map((orphan) => orphan.id) } },
            data: {
              stockDirection: "none",
              inventoryWriter: "external",
              enabled: false,
            },
          }),
        ]
      : []),

    ...warehouses.map((w) =>
      prisma.metakockaWarehouse.upsert({
        where: { shopId_mkId: { shopId, mkId: w.mkId } },
        create: { shopId, syncedAt: now, ...w },
        update: { syncedAt: now, ...w },
      }),
    ),

    // Backfill the stable id onto sources saved before it was stored, so the
    // next rename is followed rather than mistaken for a deletion.
    ...warehouses.map((w) =>
      prisma.supplySource.updateMany({
        where: {
          shopId,
          metakockaWarehouse: w.mark,
          metakockaWarehouseMkId: null,
        },
        data: { metakockaWarehouseMkId: w.mkId },
      }),
    ),
  ]);

  return { retired: orphans.map((orphan) => orphan.name), renamed };
}
