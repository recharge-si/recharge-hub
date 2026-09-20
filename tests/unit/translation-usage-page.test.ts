import { describe, expect, it } from "vitest";

import {
  formatShare,
  isUsagePeriod,
  sharePercent,
  trendBucketFor,
} from "~/domain/translations/usage";
import { fillTrend, usagePeriodStart } from "~/web/lib/usage";

/**
 * The usage page's periods, trend buckets and shares
 * (docs/translations.md § AI usage).
 */

describe("usage periods", () => {
  const now = new Date("2026-09-20T15:42:00Z");

  it("starts today, this month and the last thirty days at UTC midnight, and all time nowhere", () => {
    expect(usagePeriodStart("today", now)?.toISOString()).toBe("2026-09-20T00:00:00.000Z");
    expect(usagePeriodStart("month", now)?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    // Thirty days including today.
    expect(usagePeriodStart("last30", now)?.toISOString()).toBe("2026-08-22T00:00:00.000Z");
    expect(usagePeriodStart("all", now)).toBeNull();
  });

  it("only accepts a period it knows, and buckets the trend to fit it", () => {
    expect(isUsagePeriod("month")).toBe(true);
    expect(isUsagePeriod("yesterday")).toBe(false);
    expect(trendBucketFor("today")).toBeNull();
    expect(trendBucketFor("month")).toBe("day");
    expect(trendBucketFor("last30")).toBe("day");
    expect(trendBucketFor("all")).toBe("month");
  });
});

describe("trend", () => {
  it("fills the days nobody translated on, so the chart keeps its calendar", () => {
    const filled = fillTrend(
      [
        { at: "2026-09-02T00:00:00.000Z", requests: 3, totalTokens: 300, costMicros: 30n },
        { at: "2026-09-04T00:00:00.000Z", requests: 1, totalTokens: 100, costMicros: 10n },
      ],
      "day",
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-05T10:00:00Z"),
    );
    expect(filled.map((point) => [point.at.slice(0, 10), point.requests])).toEqual([
      ["2026-09-01", 0],
      ["2026-09-02", 3],
      ["2026-09-03", 0],
      ["2026-09-04", 1],
      ["2026-09-05", 0],
    ]);
  });

  it("runs all time from the first month with usage to the current one", () => {
    const filled = fillTrend(
      [{ at: "2026-06-01T00:00:00.000Z", requests: 9, totalTokens: 900, costMicros: 90n }],
      "month",
      null,
      new Date("2026-09-20T00:00:00Z"),
    );
    expect(filled.map((point) => point.at.slice(0, 7))).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
    expect(fillTrend([], "month", null, new Date("2026-09-20T00:00:00Z"))).toHaveLength(1);
  });
});

describe("share", () => {
  it("is a percentage with one decimal, never zero for a row that cost something, and nothing of nothing", () => {
    expect(sharePercent(25n, 100n)).toBe(25);
    expect(sharePercent(1, 3)).toBe(33.3);
    expect(sharePercent(1n, 100_000n)).toBe(0.1);
    expect(sharePercent(0n, 100n)).toBe(0);
    expect(sharePercent(5n, 0n)).toBeNull();
    expect(formatShare(25)).toBe("25%");
    expect(formatShare(33.3)).toBe("33.3%");
    expect(formatShare(null)).toBe("—");
  });
});
