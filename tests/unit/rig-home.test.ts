import { describe, expect, it } from "vitest";

import { rigTile, storeOperations, type HomeFigures } from "~/web/lib/home";

/**
 * The Rig builder line on Home (docs/ui-conventions.md): facts stated once,
 * no tone unless something is wrong, nothing at all while the builder is off.
 */
const now = new Date("2026-10-29T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

describe("rigTile", () => {
  it("states builds, plain share and the last exhaustion", () => {
    const tile = rigTile(
      { buildsToday: 12, plain: { plain: 12, of: 50 }, lastExhaustedAt: hoursAgo(3) },
      now,
    );
    expect(tile.key).toBe("rig");
    expect(tile.href).toBe("/app/product-setup/settings");
    expect(tile.lines).toEqual([
      { text: "12 builds today" },
      { text: "Plain wording in 24% of the last 50 explanations" },
      { text: "AI pool was full 3 hours ago", tone: "caution" },
    ]);
  });

  it("is calm when healthy: no tone, no line for what never happened", () => {
    const tile = rigTile(
      { buildsToday: 0, plain: { plain: 0, of: 0 }, lastExhaustedAt: null },
      now,
    );
    expect(tile.lines).toEqual([{ text: "No builds today" }]);
  });

  it("says one build in the singular and an old exhaustion without a tone", () => {
    const tile = rigTile(
      { buildsToday: 1, plain: { plain: 0, of: 8 }, lastExhaustedAt: hoursAgo(72) },
      now,
    );
    expect(tile.lines).toEqual([
      { text: "1 build today" },
      { text: "Plain wording in 0% of the last 8 explanations" },
      { text: "AI pool was full 3 days ago" },
    ]);
  });
});

describe("storeOperations with the rig builder", () => {
  const figures: HomeFigures = {
    counts: { receivedToday: 0, writtenToday: 0, stockUpdatesToday: 0, waiting: 0 },
    lastMetakockaWriteAt: null,
    lastStockSyncAt: null,
    lastStockSyncOk: null,
    lastCatalogueMatchAt: null,
    lastOrderSyncAt: null,
    ordersAwaitingPayment: 0,
  };
  const base = {
    components: [],
    figures,
    productSync: { enabled: false, lastRunAt: null },
    translations: {
      languages: 0,
      coverage: null,
      syncing: false,
      lastSyncAt: null,
    },
    sales: { active: [], next: null, onSale: 0, needsDecision: 0, failed: 0, total: 0 },
    timeZone: "UTC",
    formatDate: () => "",
    now,
  };
  const keys = (rig?: Parameters<typeof rigTile>[0] | null) =>
    storeOperations({ ...base, ...(rig !== undefined ? { rig } : {}) }).map((t) => t.key);

  it("has no rig tile when the builder is off or unmentioned", () => {
    expect(keys(null)).not.toContain("rig");
    expect(keys()).not.toContain("rig");
  });

  it("adds one when the builder is on", () => {
    expect(
      keys({ buildsToday: 2, plain: { plain: 0, of: 0 }, lastExhaustedAt: null }),
    ).toContain("rig");
  });
});
