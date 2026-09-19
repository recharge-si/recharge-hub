import { describe, expect, it } from "vitest";

import {
  editability,
  nextStatus,
  phaseFor,
  resolveConflict,
  restoreComplete,
  windowsOverlap,
  type CampaignAction,
  type CampaignStatus,
} from "~/domain/sales";

/** docs/sale-campaigns.md § Campaign state machine and § Conflicts. */
describe("campaign state machine", () => {
  const cases: Array<[CampaignStatus, CampaignAction, CampaignStatus | null]> =
    [
      ["draft", "activate", "active"],
      ["draft", "schedule", "scheduled"],
      ["draft", "cancel", "cancelled"],
      ["draft", "pause", null],
      ["scheduled", "activate", "active"],
      ["scheduled", "unschedule", "draft"],
      ["scheduled", "cancel", "cancelled"],
      ["active", "pause", "paused"],
      ["active", "end", "completed"],
      ["active", "cancel", null],
      ["active", "activate", null],
      ["paused", "resume", "active"],
      ["paused", "end", "completed"],
      ["paused", "cancel", "cancelled"],
      ["completed", "resume", null],
      ["cancelled", "activate", null],
    ];

  it.each(cases)("%s + %s → %s", (from, action, to) => {
    expect(nextStatus(from, action)).toBe(to);
  });

  it("freezes what is on sale while prices are out", () => {
    expect(editability("draft")).toBe("full");
    expect(editability("paused")).toBe("full");
    expect(editability("active")).toBe("limited");
    expect(editability("completed")).toBe("none");
  });

  it("does not call a restore complete while a row is still moving or failed", () => {
    expect(
      restoreComplete({ restored: 10, released: 2, skipped: 1, review: 1 }),
    ).toBe(true);
    expect(restoreComplete({ restored: 10, restore_failed: 1 })).toBe(false);
    expect(restoreComplete({ restored: 10, applied: 1 })).toBe(false);
  });

  it("derives the phase from the rows and the run", () => {
    expect(phaseFor("active", { pending: 5 }, "apply")).toBe("applying");
    expect(phaseFor("active", { applied: 5 }, null)).toBe("applied");
    expect(phaseFor("active", { applied: 5, failed: 1 }, null)).toBe(
      "partially_applied",
    );
    expect(phaseFor("completed", { restored: 5, review: 1 }, null)).toBe(
      "needs_attention",
    );
    expect(phaseFor("completed", { restored: 5 }, null)).toBe("idle");
  });
});

describe("resolveConflict", () => {
  const a = { id: "a", priority: 10, createdAtMs: 1000, discountBp: 1000 };
  const b = { id: "b", priority: 20, createdAtMs: 2000, discountBp: 2000 };

  it("prevents by default", () => {
    expect(resolveConflict("prevent", a, b)).toBe("refuse");
  });

  it("lets the higher priority win and refuses a tie", () => {
    expect(resolveConflict("priority", b, a)).toBe("challenger");
    expect(resolveConflict("priority", a, b)).toBe("holder");
    expect(resolveConflict("priority", a, { ...b, priority: 10 })).toBe(
      "refuse",
    );
  });

  it("lets the largest discount win and keeps the holder on a tie", () => {
    expect(resolveConflict("largest_discount", b, a)).toBe("challenger");
    expect(resolveConflict("largest_discount", a, b)).toBe("holder");
    expect(
      resolveConflict("largest_discount", a, { ...b, discountBp: 1000 }),
    ).toBe("holder");
  });

  it("lets the newest win", () => {
    expect(resolveConflict("newest", b, a)).toBe("challenger");
    expect(resolveConflict("newest", a, b)).toBe("holder");
  });

  it("knows when two schedules can be live together", () => {
    expect(
      windowsOverlap({ startsAt: 0, endsAt: 10 }, { startsAt: 5, endsAt: 15 }),
    ).toBe(true);
    expect(
      windowsOverlap({ startsAt: 0, endsAt: 10 }, { startsAt: 10, endsAt: 15 }),
    ).toBe(false);
    expect(
      windowsOverlap(
        { startsAt: null, endsAt: null },
        { startsAt: 5, endsAt: 15 },
      ),
    ).toBe(true);
    expect(
      windowsOverlap(
        { startsAt: 20, endsAt: null },
        { startsAt: 5, endsAt: 15 },
      ),
    ).toBe(false);
  });
});
