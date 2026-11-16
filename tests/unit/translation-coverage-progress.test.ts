import { describe, expect, it } from "vitest";

import type { CoverageScan } from "~/adapters/db/repositories/translation-coverage-scan.server";
import { describeCoverageScan } from "~/adapters/translations/syncs.server";

/**
 * What the pages say about the coverage count (docs/translations.md
 * § Coverage): how far a running count is, that a count with no pass for a
 * while has stopped, and what a finished count could not read.
 */

const NOW = new Date("2026-09-26T12:00:00Z");

function scan(overrides: Partial<CoverageScan> = {}): CoverageScan {
  return {
    runId: "r1",
    status: "running",
    typesTotal: 12,
    typesDone: 3,
    currentType: "PRODUCT_OPTION",
    resourcesRead: 1200,
    expectedResources: 2400,
    unread: [],
    error: null,
    startedAt: new Date(NOW.getTime() - 5 * 60_000),
    heartbeatAt: new Date(NOW.getTime() - 20_000),
    finishedAt: null,
    ...overrides,
  };
}

describe("describeCoverageScan", () => {
  it("says nothing when no count ever ran", () => {
    expect(describeCoverageScan(null, NOW).state).toBe("idle");
  });

  it("measures a running count against the last count's resources", () => {
    expect(describeCoverageScan(scan(), NOW)).toMatchObject({
      state: "counting",
      percent: 50,
      reading: "Product option",
    });
  });

  it("falls back to kinds of content on a first count, and never claims 100% before it ends", () => {
    expect(
      describeCoverageScan(scan({ expectedResources: null }), NOW).percent,
    ).toBe(25);
    expect(
      describeCoverageScan(scan({ resourcesRead: 5000 }), NOW).percent,
    ).toBe(99);
  });

  it("calls a count with no pass for a quarter of an hour stopped", () => {
    const stalled = describeCoverageScan(
      scan({ heartbeatAt: new Date(NOW.getTime() - 16 * 60_000) }),
      NOW,
    );
    expect(stalled.state).toBe("stalled");
    expect(stalled.message).toContain("Count again");
  });

  it("reports what a finished count could not read", () => {
    expect(
      describeCoverageScan(
        scan({
          status: "done",
          error: "Some content could not be read from Shopify.",
        }),
        NOW,
      ),
    ).toMatchObject({ state: "problem" });
    expect(describeCoverageScan(scan({ status: "done" }), NOW).state).toBe(
      "idle",
    );
  });
});
