import { describe, expect, it } from "vitest";

import type { ReadinessComponent } from "~/domain/readiness";
import { attentionGroups } from "~/web/lib/exceptions";
import {
  ago,
  homeAttention,
  salesOverview,
  storeOperations,
  translationsFacts,
  type HomeFigures,
  type SalesOverview,
} from "~/web/lib/home";

/**
 * What the home page says (docs/BUILD_SPEC.md § 2.7): problems by area and
 * never by record, a summary per part of the store that follows what is
 * switched on, and the sales summary saying what is live and what is next.
 */
function component(
  key: ReadinessComponent["key"],
  status: ReadinessComponent["status"],
  summary = "",
  reason: string | null = null,
): ReadinessComponent {
  return {
    key,
    title: key,
    status,
    summary,
    reason,
    action: { label: `Open ${key}`, href: `/app/${key}` },
    required: true,
  };
}

describe("attentionGroups", () => {
  it("folds kinds into areas, largest first, with a filtered link", () => {
    const groups = attentionGroups([
      { kind: "translation_failed", count: 1842 },
      { kind: "insufficient_stock", count: 20 },
      { kind: "metakocka_write_failed", count: 11 },
      { kind: "sku_not_in_metakocka", count: 10 },
    ]);
    expect(groups.map((g) => [g.area, g.count, g.href])).toEqual([
      ["translations", 1842, "/app/exceptions?area=translations"],
      ["orders", 31, "/app/exceptions?area=orders"],
      ["products", 10, "/app/exceptions?area=products"],
    ]);
  });

  it("renders no row for an area with nothing open", () => {
    expect(attentionGroups([{ kind: "sale_apply_failed", count: 0 }])).toEqual(
      [],
    );
    expect(attentionGroups([])).toEqual([]);
  });

  it("puts a kind it does not know under background work, never drops it", () => {
    const [group] = attentionGroups([{ kind: "something_new", count: 2 }]);
    expect(group?.area).toBe("background");
    expect(group?.count).toBe(2);
  });
});

describe("homeAttention", () => {
  const components = [
    component("metakocka", "ready"),
    component("payments", "needs_attention", "", "No fallback payment type."),
    component("taxes", "needs_attention", "", "3 orders are held."),
  ];

  it("leaves readiness to the setup banner until setup is finished", () => {
    const attention = homeAttention({ components, activated: false }, []);
    expect(attention.setup).toEqual([]);
  });

  it("states a setting once, dropping it where an area row already counts it", () => {
    const attention = homeAttention({ components, activated: true }, [
      { kind: "tax_mapping_missing", count: 3 },
    ]);
    expect(attention.setup.map((problem) => problem.key)).toEqual(["payments"]);
    expect(attention.setup[0]?.text).toBe("No fallback payment type.");
    expect(attention.groups.map((group) => group.area)).toEqual(["taxes"]);
    expect(attention.total).toBe(3);
  });
});

describe("translationsFacts", () => {
  it("reads coverage and the last sync from stored state", () => {
    expect(
      translationsFacts({
        coverageRows: [
          { locale: "de", fields: 100, translated: 90 },
          { locale: "it", fields: 100, translated: 70 },
        ],
        languages: [
          { locale: "de", lastSuccessfulSyncAt: "2026-09-28T10:00:00.000Z" },
          { locale: "it", lastSuccessfulSyncAt: "2026-09-28T12:00:00.000Z" },
        ],
        activeSyncs: 0,
      }),
    ).toEqual({
      coverage: 80,
      languages: 2,
      syncing: false,
      lastSyncAt: "2026-09-28T12:00:00.000Z",
    });
  });

  it("has no coverage before anything was counted", () => {
    expect(
      translationsFacts({ coverageRows: [], languages: [], activeSyncs: 0 })
        .coverage,
    ).toBeNull();
  });
});

describe("storeOperations", () => {
  const now = new Date("2026-09-28T12:00:00.000Z");
  const figures: HomeFigures = {
    counts: {
      receivedToday: 23,
      writtenToday: 21,
      stockUpdatesToday: 147,
      waiting: 2,
    },
    lastMetakockaWriteAt: "2026-09-28T11:55:00.000Z",
    lastStockSyncAt: "2026-09-28T11:57:00.000Z",
    lastStockSyncOk: true,
    lastCatalogueMatchAt: "2026-09-28T11:00:00.000Z",
    lastOrderSyncAt: "2026-09-28T11:50:00.000Z",
    ordersAwaitingPayment: 0,
  };
  const noSales: SalesOverview = {
    active: [],
    next: null,
    onSale: 0,
    needsDecision: 0,
    failed: 0,
    total: 0,
  };
  const ready = [
    component("metakocka", "ready", "Connected to company 6789"),
    component("orders", "ready", "Automatic"),
    component("payments", "ready"),
    component("stock", "ready", "MetaKocka to Shopify for 1 location"),
    component("warehouses", "ready", "1 location connected"),
    component("products", "optional", "4,734 of 4,734 SKUs matched"),
  ];
  const build = (overrides: Partial<Parameters<typeof storeOperations>[0]>) =>
    storeOperations({
      components: ready,
      figures,
      productSync: { enabled: true, lastRunAt: "2026-09-28T10:00:00.000Z" },
      translations: {
        coverage: 86,
        languages: 3,
        syncing: false,
        lastSyncAt: "2026-09-28T11:30:00.000Z",
      },
      sales: noSales,
      timeZone: "UTC",
      formatDate: (iso) => iso.slice(0, 10),
      now,
      ...overrides,
    });
  const lines = (tiles: ReturnType<typeof storeOperations>, key: string) =>
    tiles.find((tile) => tile.key === key)?.lines.map((line) => line.text);

  it("gives the six areas, three lines at most, uncoloured when healthy", () => {
    const tiles = build({});
    expect(tiles.map((tile) => tile.key)).toEqual([
      "metakocka",
      "orders",
      "inventory",
      "products",
      "translations",
      "sales",
    ]);
    for (const tile of tiles) {
      expect(tile.lines.length).toBeLessThanOrEqual(3);
      expect(tile.lines.every((line) => line.tone === undefined)).toBe(true);
    }
    expect(lines(tiles, "metakocka")).toEqual([
      "Connected to company 6789",
      "Last sent 5 min ago",
    ]);
    expect(lines(tiles, "orders")).toEqual([
      "23 received today · 21 sent",
      "2 waiting to be sent",
      "Checked with Shopify 10 min ago",
    ]);
    expect(lines(tiles, "inventory")).toEqual([
      "MetaKocka to Shopify for 1 location",
      "Synced 3 min ago",
      "147 products updated today",
    ]);
    expect(lines(tiles, "products")).toEqual([
      "4,734 of 4,734 SKUs matched",
      "Matched 1 hour ago",
      "Names sent 2 hours ago",
    ]);
    expect(lines(tiles, "translations")).toEqual([
      "86% translated · 3 languages",
      "Last sync 30 min ago",
    ]);
    expect(lines(tiles, "sales")).toEqual(["No active campaign"]);
  });

  it("says order transfer is off in one line and links to its setting", () => {
    const tiles = build({
      components: ready.map((entry) =>
        entry.key === "orders" ? component("orders", "disabled") : entry,
      ),
    });
    const orders = tiles.find((tile) => tile.key === "orders");
    expect(orders?.lines.map((line) => line.text)).toEqual([
      "Order transfer is off",
    ]);
    expect(orders?.href).toBe("/app/orders/settings");
  });

  it("counts the paid orders waiting while order transfer is off", () => {
    const tiles = build({
      components: ready.map((entry) =>
        entry.key === "orders" ? component("orders", "disabled") : entry,
      ),
      figures: {
        ...figures,
        counts: { ...figures.counts, paidWithoutDocument: 7 },
      },
    });
    const orders = tiles.find((tile) => tile.key === "orders");
    expect(orders?.lines).toEqual([
      { text: "Order transfer is off" },
      { text: "7 paid orders waiting for transfer", tone: "caution" },
    ]);
  });

  it("colours only a line that states a problem", () => {
    const tiles = build({
      figures: { ...figures, lastStockSyncOk: false, ordersAwaitingPayment: 4 },
    });
    const toned = tiles.flatMap((tile) =>
      tile.lines.filter((line) => line.tone).map((line) => line.text),
    );
    expect(toned).toEqual([
      "4 paid, payment not yet in MetaKocka",
      "Last run failed, 3 min ago",
    ]);
  });

  it("names the live campaign and links straight to it", () => {
    const tiles = build({
      sales: {
        ...noSales,
        active: [
          {
            id: "c1",
            name: "Summer Sale",
            discount: "20% off",
            onSale: 1284,
            endsAt: "2026-10-03T00:00:00.000Z",
          },
        ],
        onSale: 1284,
        total: 1,
      },
    });
    const sale = tiles.find((tile) => tile.key === "sales");
    expect(sale?.href).toBe("/app/sales/c1");
    expect(sale?.lines.map((line) => line.text)).toEqual([
      "Summer Sale",
      "1,284 variants on sale · ends 2026-10-03",
    ]);
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
