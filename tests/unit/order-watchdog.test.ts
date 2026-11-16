import { describe, expect, it } from "vitest";

import {
  describeOverdue,
  describeWaiting,
  watchOrder,
  type WatchContext,
  type WatchedOrder,
} from "~/domain/orders/watchdog";

/**
 * The order watchdog's rule (docs/project-status.md T-11).
 *
 * The case it exists for, from production on 2026-11-16: order #1006, paid on
 * 2026-10-28, still `received` with `sync_state = pending` and no MetaKocka
 * document nineteen days later, and nothing in the app saying so. There the
 * cause was the transfer switch, which is a decision and must stay silent; the
 * same order with the switch on is exactly what must not stay silent.
 */

const HOUR = 60 * 60_000;
const now = new Date("2026-11-16T09:00:00Z");
const activatedAt = new Date("2026-10-01T08:00:00Z");

const order1006: WatchedOrder = {
  receivedAt: new Date("2026-10-28T14:12:00Z"),
  cancelled: false,
  deleted: false,
  redacted: false,
  documents: [],
  syncState: "pending",
  otherOpenExceptions: 0,
};

const on: WatchContext = {
  activatedAt,
  transfer: { transferOrders: true, transferOrdersSince: null },
  settingsChangedAt: new Date("2026-10-02T10:00:00Z"),
  thresholdMs: 2 * HOUR,
  now,
};

describe("watchOrder", () => {
  it("flags #1006 when transfer is on and nothing was ever sent", () => {
    const verdict = watchOrder(order1006, on);
    expect(verdict).toMatchObject({ kind: "overdue", problem: "not_sent" });
    if (verdict.kind !== "overdue") throw new Error("expected overdue");
    expect(describeWaiting(verdict.waitingMs)).toBe("18 days");
  });

  it("stays silent for #1006 while transfer is off, as it was in production", () => {
    expect(
      watchOrder(order1006, {
        ...on,
        transfer: { transferOrders: false, transferOrdersSince: null },
      }),
    ).toEqual({ kind: "fine", why: "held_transfer_off" });
  });

  it("stays silent for an order received while transfer was off", () => {
    expect(
      watchOrder(order1006, {
        ...on,
        transfer: {
          transferOrders: true,
          transferOrdersSince: new Date("2026-11-10T00:00:00Z"),
        },
      }),
    ).toEqual({ kind: "fine", why: "held_received_while_off" });
  });

  it("stays silent before setup is finished", () => {
    expect(watchOrder(order1006, { ...on, activatedAt: null })).toEqual({
      kind: "fine",
      why: "not_activated",
    });
  });

  it("gives every order the grace period from activation, not only from arrival", () => {
    const justActivated = new Date(now.getTime() - HOUR);
    expect(
      watchOrder(order1006, { ...on, activatedAt: justActivated }),
    ).toEqual({
      kind: "fine",
      why: "recent",
    });
  });

  it("gives a backlog the grace period after transfer is turned back on", () => {
    expect(
      watchOrder(order1006, {
        ...on,
        settingsChangedAt: new Date(now.getTime() - 30 * 60_000),
      }),
    ).toEqual({ kind: "fine", why: "recent" });
  });

  it("does not flag an order younger than the threshold", () => {
    expect(
      watchOrder(
        { ...order1006, receivedAt: new Date(now.getTime() - 90 * 60_000) },
        on,
      ),
    ).toEqual({ kind: "fine", why: "recent" });
    expect(
      watchOrder(
        { ...order1006, receivedAt: new Date(now.getTime() - 2 * HOUR) },
        on,
      ),
    ).toMatchObject({ kind: "overdue" });
  });

  it("leaves an order to the exception that already explains it", () => {
    expect(watchOrder({ ...order1006, otherOpenExceptions: 1 }, on)).toEqual({
      kind: "fine",
      why: "owned",
    });
  });

  it("is quiet for an order that is over", () => {
    for (const ended of [
      { cancelled: true },
      { deleted: true },
      { redacted: true },
    ]) {
      expect(watchOrder({ ...order1006, ...ended }, on)).toEqual({
        kind: "fine",
        why: "over",
      });
    }
  });

  it("calls an order transferred once every document is written and a verdict exists", () => {
    const written = {
      ...order1006,
      documents: [
        { status: "written" as const },
        { status: "written" as const },
      ],
    };
    for (const syncState of ["in_sync", "blocked", "inconsistent"] as const) {
      expect(watchOrder({ ...written, syncState }, on)).toEqual({
        kind: "fine",
        why: "transferred",
      });
    }
  });

  it("flags a written order whose verification never ran", () => {
    expect(
      watchOrder(
        {
          ...order1006,
          documents: [{ status: "written" }],
          syncState: "pending",
        },
        on,
      ),
    ).toMatchObject({ kind: "overdue", problem: "not_verified" });
  });

  it("flags a split order with one document still unwritten", () => {
    expect(
      watchOrder(
        {
          ...order1006,
          documents: [{ status: "written" }, { status: "pending" }],
          syncState: "in_sync",
        },
        on,
      ),
    ).toMatchObject({ kind: "overdue", problem: "not_sent" });
  });

  it("keeps holding an order MetaKocka has while the switch is off", () => {
    expect(
      watchOrder(
        { ...order1006, documents: [{ status: "failed" }] },
        {
          ...on,
          transfer: { transferOrders: false, transferOrdersSince: null },
        },
      ),
    ).toEqual({ kind: "fine", why: "held_transfer_off" });
  });
});

describe("describeOverdue", () => {
  it("says what is wrong and what to do, with the order number and no customer data", () => {
    const message = describeOverdue("#1006", {
      kind: "overdue",
      problem: "not_sent",
      waitingMs: 3 * HOUR,
    });
    expect(message).toContain("Order #1006 has waited 3 hours");
    expect(message).toContain("Retry");
  });

  it("words the unverified case differently", () => {
    expect(
      describeOverdue("#1007", {
        kind: "overdue",
        problem: "not_verified",
        waitingMs: 5 * HOUR,
      }),
    ).toContain("was written to MetaKocka");
  });
});

describe("describeWaiting", () => {
  it("rounds down to minutes, hours or days", () => {
    expect(describeWaiting(30_000)).toBe("1 minute");
    expect(describeWaiting(45 * 60_000)).toBe("45 minutes");
    expect(describeWaiting(HOUR)).toBe("1 hour");
    expect(describeWaiting(47 * HOUR)).toBe("47 hours");
    expect(describeWaiting(72 * HOUR)).toBe("3 days");
  });
});
