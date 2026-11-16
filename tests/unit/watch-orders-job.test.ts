import type { Job } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  WatchdogOrder,
  WatchdogShop,
} from "~/adapters/db/repositories/order-watchdog.server";

/**
 * The watch-orders job (docs/project-status.md T-11): it raises one
 * `order_not_transferred` per overdue order through the ordinary exception
 * machinery, closes it as the app once the order reaches MetaKocka or stops
 * being owed, and never raises one for an order the transfer switch holds.
 * Repositories are replaced; the database queries are covered by
 * tests/db/order-watchdog.test.ts.
 */

const state = vi.hoisted(() => ({
  shop: null as WatchdogShop | null,
  orders: [] as WatchdogOrder[],
  listedWith: [] as Array<{
    receivedAfter: Date;
    receivedBefore: Date;
    limit: number;
  }>,
  raised: [] as Array<{
    orderId?: string | null;
    kind: string;
    message: string;
    detail?: unknown;
  }>,
  closed: [] as Array<{ orderId: string; kinds: string[] }>,
  events: [] as unknown[],
}));

vi.mock("~/adapters/db/repositories/order-watchdog.server", () => ({
  getWatchdogShop: async () => state.shop,
  listWatchdogOrders: async (
    _p: unknown,
    input: { receivedAfter: Date; receivedBefore: Date; limit: number },
  ) => {
    state.listedWith.push(input);
    return state.orders;
  },
}));
vi.mock("~/adapters/db/repositories/exception.server", () => ({
  raiseException: async (
    _p: unknown,
    input: {
      orderId?: string | null;
      kind: string;
      message: string;
      detail?: unknown;
    },
  ) => {
    state.raised.push(input);
  },
  closeExceptionsFor: async (_p: unknown, orderId: string, kinds: string[]) => {
    state.closed.push({ orderId, kinds });
  },
}));
vi.mock("~/adapters/db/repositories/event-log.server", () => ({
  appendEvent: async (_p: unknown, entry: unknown) => {
    state.events.push(entry);
  },
}));

const { handleWatchOrders, LOOKBACK_DAYS } =
  await import("~/jobs/handlers/watch-orders");

const now = new Date("2026-11-16T09:00:00Z");
const job = {
  data: { shopDomain: "recharge-test.myshopify.com" },
} as Job<unknown>;

const transferOn: WatchdogShop = {
  activatedAt: new Date("2026-10-01T08:00:00Z"),
  transfer: { transferOrders: true, transferOrdersSince: null },
  settingsChangedAt: new Date("2026-10-02T10:00:00Z"),
};
const transferOff: WatchdogShop = {
  ...transferOn,
  transfer: { transferOrders: false, transferOrdersSince: null },
};

/** #1006 as production had it: paid 2026-10-28, received, pending, no document. */
function order1006(overrides: Partial<WatchdogOrder> = {}): WatchdogOrder {
  return {
    id: "ord_1006",
    orderNumber: "#1006",
    flagged: false,
    watched: {
      receivedAt: new Date("2026-10-28T14:12:00Z"),
      cancelled: false,
      deleted: false,
      redacted: false,
      documents: [],
      syncState: "pending",
      otherOpenExceptions: 0,
    },
    ...overrides,
  };
}

beforeEach(() => {
  state.shop = transferOn;
  state.orders = [];
  state.listedWith = [];
  state.raised = [];
  state.closed = [];
  state.events = [];
});

describe("handleWatchOrders", () => {
  it("raises order_not_transferred for an order that never reached MetaKocka", async () => {
    state.orders = [order1006()];

    const result = await handleWatchOrders(job, { now });

    expect(result).toEqual({ raised: 1, cleared: 0, checked: 1 });
    expect(state.raised).toEqual([
      expect.objectContaining({
        orderId: "ord_1006",
        kind: "order_not_transferred",
        detail: expect.objectContaining({ problem: "not_sent", documents: 0 }),
      }),
    ]);
    expect(state.raised[0]?.message).toContain("Order #1006");
  });

  it("raises nothing while transfer is off, and closes a flag the switch now explains", async () => {
    state.shop = transferOff;
    state.orders = [
      order1006(),
      order1006({ id: "ord_1007", orderNumber: "#1007", flagged: true }),
    ];

    const result = await handleWatchOrders(job, { now });

    expect(state.raised).toEqual([]);
    expect(state.closed).toEqual([
      { orderId: "ord_1007", kinds: ["order_not_transferred"] },
    ]);
    expect(state.events).toEqual([
      expect.objectContaining({
        event: "exception.resolved_automatically",
        detail: expect.objectContaining({
          why: "Order transfer was turned off.",
        }),
      }),
    ]);
    expect(result.cleared).toBe(1);
  });

  it("closes the flag once the order is in MetaKocka and verified", async () => {
    state.orders = [
      order1006({
        flagged: true,
        watched: {
          ...order1006().watched,
          documents: [{ status: "written" }],
          syncState: "in_sync",
        },
      }),
    ];

    await handleWatchOrders(job, { now });

    expect(state.raised).toEqual([]);
    expect(state.closed).toEqual([
      { orderId: "ord_1006", kinds: ["order_not_transferred"] },
    ]);
  });

  it("updates an open flag in place rather than counting it as new", async () => {
    state.orders = [order1006({ flagged: true })];

    const result = await handleWatchOrders(job, { now });

    expect(state.raised).toHaveLength(1);
    expect(result.raised).toBe(0);
    expect(state.closed).toEqual([]);
  });

  it("leaves an order that another open exception already explains", async () => {
    state.orders = [
      order1006({
        watched: { ...order1006().watched, otherOpenExceptions: 2 },
      }),
      order1006({
        id: "ord_1008",
        flagged: true,
        watched: { ...order1006().watched, otherOpenExceptions: 1 },
      }),
    ];

    await handleWatchOrders(job, { now });

    expect(state.raised).toEqual([]);
    expect(state.closed).toEqual([]);
  });

  it("asks only for orders inside the window and older than the threshold", async () => {
    await handleWatchOrders(job, { now });

    expect(state.listedWith).toHaveLength(1);
    const window = state.listedWith[0]!;
    expect(window.receivedBefore.toISOString()).toBe(
      "2026-11-16T07:00:00.000Z",
    );
    expect(now.getTime() - window.receivedAfter.getTime()).toBe(
      LOOKBACK_DAYS * 24 * 60 * 60_000,
    );
  });

  it("does nothing for a shop that is gone", async () => {
    state.shop = null;
    state.orders = [order1006()];

    expect(await handleWatchOrders(job, { now })).toEqual({
      raised: 0,
      cleared: 0,
      checked: 0,
    });
    expect(state.raised).toEqual([]);
  });
});
