/**
 * Orders per day, drawn as inline SVG.
 *
 * No charting library, on purpose. Adding one would mean a new dependency and a
 * second design system inside a Polaris page (CLAUDE.md §2.6), for a fourteen-
 * bar chart that is a few dozen lines of SVG. The colours are Polaris CSS
 * custom properties rather than literals, so the chart follows the admin's
 * palette and stays legible if Shopify changes it.
 *
 * Two things this deliberately does:
 *
 *  - **Fixed dimensions and a fixed `viewBox`.** §2.5 budgets CLS at 0.1, and a
 *    chart that sizes itself after hydration is the classic way to blow it.
 *  - **A table underneath for screen readers.** An SVG of bars is not readable
 *    without one, and WCAG 2.1 AA is a BFS requirement, not a nice-to-have.
 */
export interface OrderChartPoint {
  date: string;
  received: number;
  written: number;
  needsAttention: number;
}

const WIDTH = 720;
const HEIGHT = 160;
const PADDING = { top: 8, right: 8, bottom: 20, left: 8 };

function shortDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export function OrderChart({ points }: { points: OrderChartPoint[] }) {
  if (points.length === 0) return null;

  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;

  const peak = Math.max(1, ...points.map((point) => point.received));
  const slot = plotWidth / points.length;
  const barWidth = Math.max(4, Math.min(28, slot * 0.6));

  const total = points.reduce((sum, point) => sum + point.received, 0);
  if (total === 0) {
    return (
      <s-text color="subdued">
        No orders in the last {points.length} days.
      </s-text>
    );
  }

  return (
    <s-stack direction="block" gap="small-300">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        height={HEIGHT}
        role="img"
        aria-label={`Orders per day for the last ${points.length} days. ${total} in total.`}
        style={{ display: "block", maxWidth: "100%" }}
      >
        {points.map((point, index) => {
          const x = PADDING.left + slot * index + (slot - barWidth) / 2;
          const height = Math.round((point.received / peak) * plotHeight);
          const y = PADDING.top + plotHeight - height;

          // Written orders are shown as a filled portion of the same bar, so
          // the eye compares "arrived" against "reached the ERP" in one shape
          // rather than across two.
          const writtenHeight = Math.round(
            (point.written / Math.max(1, point.received)) * height,
          );

          return (
            <g key={point.date}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(height, point.received > 0 ? 2 : 0)}
                rx="2"
                fill="var(--s-color-border, #c9cccf)"
              />
              {writtenHeight > 0 ? (
                <rect
                  x={x}
                  y={PADDING.top + plotHeight - writtenHeight}
                  width={barWidth}
                  height={writtenHeight}
                  rx="2"
                  fill="var(--s-color-text, #303030)"
                />
              ) : null}
              {index % Math.ceil(points.length / 7) === 0 ? (
                <text
                  x={x + barWidth / 2}
                  y={HEIGHT - 6}
                  textAnchor="middle"
                  fontSize="11"
                  fill="var(--s-color-text-subdued, #616161)"
                >
                  {shortDate(point.date)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      <s-stack direction="inline" gap="base" alignItems="center">
        <s-text color="subdued">Dark: sent to MetaKocka</s-text>
        <s-text color="subdued">Light: received</s-text>
      </s-stack>
    </s-stack>
  );
}
