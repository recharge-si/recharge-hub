import { prisma } from "~/adapters/db/client.server";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * The numbers behind the home page (CLAUDE.md §2.7).
 *
 * BFS rejects a static welcome card: the home page has to be dynamic and
 * diagnostic, showing setup state, whether syncing is working, and real
 * metrics. §2.7 names them — orders received today, automatically allocated,
 * awaiting attention, last successful MetaKocka write, last reconciliation and
 * its result, open exceptions by type — so this returns exactly those rather
 * than whatever happened to be easy to count.
 *
 * Every figure comes from our own database. §2.5 forbids a page load awaiting
 * MetaKocka, and this is the page most likely to be opened first.
 */

export interface DashboardCounts {
  receivedToday: number;
  allocatedToday: number;
  needsAttention: number;
  writtenToday: number;
}

export interface DaySeriesPoint {
  /** ISO date, midnight UTC. */
  date: string;
  received: number;
  written: number;
  needsAttention: number;
}

export interface DashboardData {
  counts: DashboardCounts;
  /** Newest last, so a chart reads left to right. */
  series: DaySeriesPoint[];
  openExceptionsByKind: { kind: string; count: number }[];
  lastMetakockaWriteAt: string | null;
  lastStockSyncAt: string | null;
  lastStockSyncOk: boolean | null;
  /**
   * When orders were last checked against Shopify, and how many are not in
   * step.
   *
   * §2.7 asks the home page to say whether syncing is working, and order sync
   * is the part with no other symptom when it stops: an order that is paid in
   * Shopify and unpaid in the ERP looks completely normal on both screens. The
   * two figures below are how that becomes visible.
   */
  lastOrderSyncAt: string | null;
  ordersAwaitingPayment: number;
  totalOrders: number;
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/**
 * @param now injected rather than read here, so the page and its tests agree
 *   about what "today" means.
 */
export async function getDashboard(
  principal: Principal,
  now: Date,
  days = 14,
): Promise<DashboardData> {
  const domain = shopDomainOf(principal);
  const today = startOfUtcDay(now);
  const windowStart = new Date(today);
  windowStart.setUTCDate(windowStart.getUTCDate() - (days - 1));

  const [
    receivedToday,
    allocatedToday,
    needsAttention,
    writtenToday,
    totalOrders,
    recentOrders,
    exceptionGroups,
    lastDocument,
    lastStockEvent,
    lastOrderSync,
    ordersAwaitingPayment,
  ] = await Promise.all([
    prisma.order.count({
      where: {
        shop: { domain },
        shopifyDeletedAt: null,
        receivedAt: { gte: today },
      },
    }),
    prisma.order.count({
      where: {
        shop: { domain },
        receivedAt: { gte: today },
        status: { in: ["allocated", "written"] },
      },
    }),
    prisma.order.count({
      where: {
        shop: { domain },
        shopifyDeletedAt: null,
        status: "needs_attention",
      },
    }),
    prisma.order.count({
      where: {
        shop: { domain },
        shopifyDeletedAt: null,
        receivedAt: { gte: today },
        status: "written",
      },
    }),
    prisma.order.count({ where: { shop: { domain }, shopifyDeletedAt: null } }),

    // One read for the whole chart window, bucketed in memory. A group-by per
    // day would be several round trips for a page that must paint quickly.
    prisma.order.findMany({
      where: {
        shop: { domain },
        shopifyDeletedAt: null,
        receivedAt: { gte: windowStart },
      },
      select: { receivedAt: true, status: true },
    }),

    prisma.exception.groupBy({
      by: ["kind"],
      where: { shop: { domain }, status: "open" },
      _count: { _all: true },
    }),

    prisma.metakockaDocument.findFirst({
      where: { shop: { domain }, status: "written" },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),

    prisma.eventLog.findFirst({
      where: {
        shop: { domain },
        event: {
          in: [
            "inventory.synced",
            "inventory.written_to_metakocka",
            "inventory.sync_skipped",
          ],
        },
      },
      orderBy: { at: "desc" },
      select: { at: true, event: true },
    }),

    prisma.shop.findUnique({
      where: { domain },
      select: { ordersReconciledThrough: true },
    }),

    // Paid in Shopify, written to MetaKocka, and MetaKocka has not been told.
    // Zero is the only healthy number; anything else is money the merchant is
    // about to reconcile by hand.
    prisma.order.count({
      where: {
        shop: { domain },
        shopifyDeletedAt: null,
        financialStatus: "paid",
        documents: { some: { status: "written", paymentMarkedAt: null } },
      },
    }),
  ]);

  const buckets = new Map<string, DaySeriesPoint>();
  for (let index = 0; index < days; index += 1) {
    const day = new Date(windowStart);
    day.setUTCDate(day.getUTCDate() + index);
    const key = day.toISOString().slice(0, 10);
    buckets.set(key, {
      date: key,
      received: 0,
      written: 0,
      needsAttention: 0,
    });
  }

  for (const order of recentOrders) {
    const key = order.receivedAt.toISOString().slice(0, 10);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.received += 1;
    if (order.status === "written") bucket.written += 1;
    if (order.status === "needs_attention") bucket.needsAttention += 1;
  }

  return {
    counts: { receivedToday, allocatedToday, needsAttention, writtenToday },
    series: [...buckets.values()],
    openExceptionsByKind: exceptionGroups.map((group) => ({
      kind: group.kind,
      count: group._count._all,
    })),
    lastMetakockaWriteAt: lastDocument?.updatedAt.toISOString() ?? null,
    lastStockSyncAt: lastStockEvent?.at.toISOString() ?? null,
    lastStockSyncOk: lastStockEvent
      ? lastStockEvent.event !== "inventory.sync_skipped"
      : null,
    lastOrderSyncAt: lastOrderSync?.ordersReconciledThrough?.toISOString() ?? null,
    ordersAwaitingPayment,
    totalOrders,
  };
}
