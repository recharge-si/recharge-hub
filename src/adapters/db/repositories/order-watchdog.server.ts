import { prisma } from "~/adapters/db/client.server";
import type { WatchedOrder } from "~/domain/orders/watchdog";
import type { OrderTransferSettings } from "~/domain/orders/transfer";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * What the order watchdog reads (`jobs/handlers/watch-orders`). Our own
 * database only: the watchdog never asks Shopify or MetaKocka anything.
 */

export interface WatchdogShop {
  activatedAt: Date | null;
  transfer: OrderTransferSettings;
  settingsChangedAt: Date | null;
}

export async function getWatchdogShop(principal: Principal): Promise<WatchdogShop | null> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: {
      setupCompletedAt: true,
      salesOrderSetting: {
        select: { transferOrders: true, transferOrdersSince: true, updatedAt: true },
      },
    },
  });
  if (!shop) return null;
  const setting = shop.salesOrderSetting;
  return {
    activatedAt: shop.setupCompletedAt,
    // No row means the defaults, and the default is on (SALES_ORDER_DEFAULTS).
    transfer: {
      transferOrders: setting?.transferOrders ?? true,
      transferOrdersSince: setting?.transferOrdersSince ?? null,
    },
    settingsChangedAt: setting?.updatedAt ?? null,
  };
}

export interface WatchdogOrder {
  id: string;
  orderNumber: string;
  watched: WatchedOrder;
  /** Whether the watchdog's own exception is open on it now. */
  flagged: boolean;
}

/**
 * The orders worth a look, oldest first:
 *
 *  - every order the watchdog has flagged and not yet seen cleared, whenever
 *    it arrived, so a flag is always re-judged;
 *  - and every live order received inside the window that is not yet both
 *    written and verified. "Not yet old enough" is narrowed here by
 *    `receivedBefore`, which is safe because the clock never starts before
 *    the order arrived.
 *
 * The window's floor is what keeps a first run from raising an order from
 * before this check existed — or before `sync_state` did — that nobody is
 * going to send now.
 */
export async function listWatchdogOrders(
  principal: Principal,
  input: { receivedAfter: Date; receivedBefore: Date; limit: number },
): Promise<WatchdogOrder[]> {
  const rows = await prisma.order.findMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      OR: [
        { exceptions: { some: { kind: "order_not_transferred", status: "open" } } },
        {
          receivedAt: { gte: input.receivedAfter, lt: input.receivedBefore },
          cancelledAt: null,
          shopifyDeletedAt: null,
          redactedAt: null,
          OR: [
            { documents: { none: {} } },
            { documents: { some: { status: { not: "written" } } } },
            { syncState: "pending" },
          ],
        },
      ],
    },
    select: {
      id: true,
      shopifyOrderNumber: true,
      receivedAt: true,
      cancelledAt: true,
      shopifyDeletedAt: true,
      redactedAt: true,
      syncState: true,
      documents: { select: { status: true } },
      exceptions: { where: { status: "open" }, select: { kind: true } },
    },
    orderBy: { receivedAt: "asc" },
    take: input.limit,
  });

  return rows.map((row) => ({
    id: row.id,
    orderNumber: row.shopifyOrderNumber,
    flagged: row.exceptions.some((e) => e.kind === "order_not_transferred"),
    watched: {
      receivedAt: row.receivedAt,
      cancelled: row.cancelledAt !== null,
      deleted: row.shopifyDeletedAt !== null,
      redacted: row.redactedAt !== null,
      documents: row.documents,
      syncState: row.syncState,
      otherOpenExceptions: row.exceptions.filter(
        (e) => e.kind !== "order_not_transferred",
      ).length,
    },
  }));
}

/**
 * Paid orders this app holds that MetaKocka has no document for — while
 * transfer is off, exactly the ones waiting on the switch.
 */
export async function countPaidOrdersWithoutDocument(principal: Principal): Promise<number> {
  return prisma.order.count({
    where: {
      shop: { domain: shopDomainOf(principal) },
      financialStatus: "paid",
      cancelledAt: null,
      shopifyDeletedAt: null,
      redactedAt: null,
      documents: { none: {} },
    },
  });
}
