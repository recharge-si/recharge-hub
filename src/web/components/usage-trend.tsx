import { formatCount } from "~/domain/translations/estimate";
import { formatMicrosUsd } from "~/domain/translations/pricing";
import type { TrendBucket } from "~/domain/translations/usage";

/**
 * AI spend over time, drawn as inline SVG — one bar a day for a month, one a
 * month for all time.
 *
 * No charting library, for the reason `order-chart` gives none: a second
 * design system inside a Polaris page (docs/BUILD_SPEC.md section 2.6) is a
 * high price for a few dozen lines of SVG. Colours are Polaris custom
 * properties, so the chart follows the admin's palette.
 *
 * Bars are estimated cost, the figure the page is about. When nothing in the
 * period is priced (a model missing from the table) the bars are tokens
 * instead, and the legend says so, rather than a flat line of nothing. Fixed
 * dimensions and `viewBox`, so the chart does not resize after hydration
 * (section 2.5 budgets CLS); each bar carries a `<title>` so hovering says
 * the day's figures, and the whole chart is labelled for screen readers.
 */
export interface UsageTrendPoint {
  at: string;
  requests: number;
  totalTokens: number;
  /** Serialised micro-USD: bigint does not survive the loader. */
  costMicros: string;
}

const WIDTH = 720;
const HEIGHT = 150;
const PADDING = { top: 8, right: 8, bottom: 20, left: 8 };

function label(iso: string, bucket: TrendBucket): string {
  const date = new Date(iso);
  return bucket === "day"
    ? date.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      })
    : date.toLocaleDateString(undefined, {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
}

export function UsageTrend({
  points,
  bucket,
}: {
  points: UsageTrendPoint[];
  bucket: TrendBucket;
}) {
  if (points.length === 0) return null;

  const priced = points.some((point) => BigInt(point.costMicros) > 0n);
  const value = (point: UsageTrendPoint) =>
    priced ? Number(point.costMicros) : point.totalTokens;
  const peak = Math.max(1, ...points.map(value));
  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const slot = plotWidth / points.length;
  const barWidth = Math.max(3, Math.min(28, slot * 0.64));
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const total = points.reduce((sum, point) => sum + point.requests, 0);

  return (
    <s-stack direction="block" gap="small-300">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        height={HEIGHT}
        role="img"
        aria-label={`${priced ? "Estimated cost" : "Tokens"} per ${bucket} over ${points.length} ${bucket}s; ${formatCount(total)} requests in total.`}
        style={{ display: "block", maxWidth: "100%" }}
      >
        <line
          x1={PADDING.left}
          x2={WIDTH - PADDING.right}
          y1={PADDING.top + plotHeight + 0.5}
          y2={PADDING.top + plotHeight + 0.5}
          stroke="var(--s-color-border, #e3e3e3)"
        />
        {points.map((point, index) => {
          const x = PADDING.left + slot * index + (slot - barWidth) / 2;
          const height = Math.round((value(point) / peak) * plotHeight);
          const y = PADDING.top + plotHeight - height;
          const title = `${label(point.at, bucket)}: ${formatMicrosUsd(BigInt(point.costMicros))} · ${formatCount(point.totalTokens)} tokens · ${formatCount(point.requests)} requests`;
          return (
            <g key={point.at}>
              <title>{title}</title>
              {point.requests > 0 ? (
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={Math.max(height, 2)}
                  rx="2"
                  fill="var(--s-color-text, #303030)"
                />
              ) : null}
              {index % labelEvery === 0 ? (
                <text
                  x={x + barWidth / 2}
                  y={HEIGHT - 6}
                  textAnchor="middle"
                  fontSize="11"
                  fill="var(--s-color-text-subdued, #616161)"
                >
                  {label(point.at, bucket)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <s-text color="subdued">
        {priced
          ? `Estimated cost per ${bucket}. Hover a bar for its tokens and requests.`
          : `Tokens per ${bucket}; nothing in this period is priced. Hover a bar for its requests.`}
      </s-text>
    </s-stack>
  );
}
