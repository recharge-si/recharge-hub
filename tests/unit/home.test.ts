import { describe, expect, it } from "vitest";

import type { ReadinessComponent } from "~/domain/readiness";
import { ago, modulesOn, salesOverview } from "~/web/lib/home";

/**
 * What the home page shows follows what is switched on (docs/BUILD_SPEC.md
 * § 2.7): a shop that does not send orders gets no order figures, and the
 * sales card says what is live and what is next.
 */
function component(
  key: ReadinessComponent["key"],
  status: ReadinessComponent["status"],
): ReadinessComponent {
  return {
    key,
    title: key,
    status,
    summary: "",
    reason: null,
    action: null,
    required: true,
  };
}

describe("modulesOn", () => {
  it("drops orders and payments together when order transfer is off", () => {
    const on = modulesOn([
      component("metakocka", "ready"),
      component("orders", "disabled"),
      component("payments", "ready"),
      component("stock", "ready"),
      component("products", "optional"),
    ]);
    expect([...on].sort()).toEqual(["products", "stock"]);
  });

  it("keeps a module that needs attention, since its figures are the symptom", () => {
    const on = modulesOn([
      component("orders", "needs_attention"),
      component("payments", "disabled"),
      component("stock", "disabled"),
    ]);
    expect([...on]).toEqual(["orders"]);
  });
});

describe("salesOverview", () => {
  const base = { discount: "10% off", startsAt: null, endsAt: null };

  it("lists live campaigns by variants on sale and names the next start", () => {
    const overview = salesOverview([
      {
        ...base,
        id: "a",
        name: "Small",
        status: "active",
        counts: { applied: 3 },
      },
      {
        ...base,
        id: "b",
        name: "Big",
        status: "active",
        counts: { applied: 40, applying: 2, review: 1 },
      },
      {
        ...base,
        id: "c",
        name: "Later",
        status: "scheduled",
        startsAt: "2026-10-01T00:00:00.000Z",
        counts: {},
      },
      {
        ...base,
        id: "d",
        name: "Sooner",
        status: "scheduled",
        startsAt: "2026-09-25T00:00:00.000Z",
        counts: {},
      },
      {
        ...base,
        id: "e",
        name: "Old",
        status: "completed",
        counts: { restored: 9, failed: 2 },
      },
    ]);
    expect(overview.active.map((c) => [c.name, c.onSale])).toEqual([
      ["Big", 42],
      ["Small", 3],
    ]);
    expect(overview.next?.name).toBe("Sooner");
    expect(overview.onSale).toBe(45);
    expect(overview.needsDecision).toBe(1);
    expect(overview.failed).toBe(2);
    expect(overview.total).toBe(5);
  });

  it("is empty for a shop without campaigns", () => {
    expect(salesOverview([])).toEqual({
      active: [],
      next: null,
      onSale: 0,
      needsDecision: 0,
      failed: 0,
      total: 0,
    });
  });
});

describe("ago", () => {
  const now = new Date("2026-09-19T12:00:00Z");
  it("says it the way a person would", () => {
    expect(ago(null, now)).toBe("never");
    expect(ago("2026-09-19T11:59:50Z", now)).toBe("just now");
    expect(ago("2026-09-19T11:45:00Z", now)).toBe("15 min ago");
    expect(ago("2026-09-19T09:00:00Z", now)).toBe("3 hours ago");
    expect(ago("2026-09-17T12:00:00Z", now)).toBe("2 days ago");
  });
});
