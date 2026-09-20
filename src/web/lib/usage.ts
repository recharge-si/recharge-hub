import type { TrendBucket, UsagePeriod } from "~/domain/translations/usage";

/**
 * The usage page's calendar (docs/translations.md § AI usage): where a
 * period starts and which buckets its trend has. Here rather than in
 * `domain/` because it handles dates; every period is measured in UTC, the
 * clock every `ai_usage` row was stamped in, so "today" is the same day the
 * row says it is.
 */

/** The first instant of the period, or null for all time. */
export function usagePeriodStart(period: UsagePeriod, now: Date): Date | null {
  if (period === "all") return null;
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  if (period === "month") start.setUTCDate(1);
  // Thirty days including today, so a month of daily bars is a month wide.
  if (period === "last30") start.setUTCDate(start.getUTCDate() - 29);
  return start;
}

export interface TrendPoint {
  /** The bucket's first instant, ISO. */
  at: string;
  requests: number;
  totalTokens: number;
  costMicros: bigint;
}

/**
 * The trend with a point for every bucket from `from` to `to`, so a day with
 * no requests is an empty slot in the chart rather than a missing bar. `from`
 * null means "from the first point" (all time).
 */
export function fillTrend(
  points: readonly TrendPoint[],
  bucket: TrendBucket,
  from: Date | null,
  to: Date,
): TrendPoint[] {
  const known = new Map(
    points.map((point) => [
      bucketStart(new Date(point.at), bucket).toISOString(),
      point,
    ]),
  );
  const earliest = points[0];
  const first = from ?? (earliest ? new Date(earliest.at) : to);
  const cursor = bucketStart(first, bucket);
  const end = bucketStart(to, bucket);
  const filled: TrendPoint[] = [];
  while (cursor.getTime() <= end.getTime()) {
    const at = cursor.toISOString();
    filled.push(
      known.get(at) ?? { at, requests: 0, totalTokens: 0, costMicros: 0n },
    );
    if (bucket === "day") cursor.setUTCDate(cursor.getUTCDate() + 1);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return filled;
}

function bucketStart(at: Date, bucket: TrendBucket): Date {
  const start = new Date(at);
  start.setUTCHours(0, 0, 0, 0);
  if (bucket === "month") start.setUTCDate(1);
  return start;
}
