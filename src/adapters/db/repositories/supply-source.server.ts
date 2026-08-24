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
  metakockaWarehouse: string | null;
  metakockaProfitCenter: string | null;
  priority: number;
  leadTimeDays: number;
  defaultDeliveryType: string | null;
  canSplit: boolean;
  enabled: boolean;
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

/**
 * Replaces the cached list with what MetaKocka just returned. Warehouses removed
 * in MetaKocka disappear here too, so a supply source can no longer point at one
 * that is gone.
 */
export async function replaceCachedWarehouses(
  principal: Principal,
  warehouses: WarehouseSnapshot[],
): Promise<void> {
  const shopId = await shopIdFor(principal);
  const now = new Date();

  await prisma.$transaction([
    prisma.metakockaWarehouse.deleteMany({
      where: { shopId, mark: { notIn: warehouses.map((w) => w.mark) } },
    }),
    ...warehouses.map((w) =>
      prisma.metakockaWarehouse.upsert({
        where: { shopId_mark: { shopId, mark: w.mark } },
        create: { shopId, syncedAt: now, ...w },
        update: { syncedAt: now, ...w },
      }),
    ),
  ]);
}
