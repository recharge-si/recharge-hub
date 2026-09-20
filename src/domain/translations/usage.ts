/**
 * The usage page's vocabulary and arithmetic (docs/translations.md § AI
 * usage): the reporting periods, how the trend is bucketed and a share of a
 * total. Pure: the sums are the repository's, the clock is the web layer's
 * (`web/lib/usage`), and nothing here carries a price.
 */
export const USAGE_PERIODS = ["today", "month", "last30", "all"] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

export const USAGE_PERIOD_LABEL: Record<UsagePeriod, string> = {
  today: "Today",
  month: "This month",
  last30: "Last 30 days",
  all: "All time",
};

export function isUsagePeriod(value: string): value is UsagePeriod {
  return (USAGE_PERIODS as readonly string[]).includes(value);
}

export type TrendBucket = "day" | "month";

/**
 * How the trend is bucketed for the period: a bar a day for a month, a bar a
 * month for all time, and no trend at all for a single day.
 */
export function trendBucketFor(period: UsagePeriod): TrendBucket | null {
  if (period === "today") return null;
  return period === "all" ? "month" : "day";
}

/**
 * A part of a total as a percentage with one decimal, or null when there is
 * no total to be a share of. A tiny non-zero share rounds to 0.1 rather than
 * 0, so a row that cost something never reads as costing nothing.
 */
export function sharePercent(
  part: bigint | number,
  total: bigint | number,
): number | null {
  const whole = Number(total);
  if (whole <= 0) return null;
  const share = (Number(part) / whole) * 100;
  if (share > 0 && share < 0.1) return 0.1;
  return Math.round(share * 10) / 10;
}

export function formatShare(share: number | null): string {
  if (share === null) return "—";
  return `${Number.isInteger(share) ? share : share.toFixed(1)}%`;
}
