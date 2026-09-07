/**
 * A short ranked breakdown — which warehouses the last fortnight's sales orders
 * were filed against.
 *
 * A row, a bar and a number, built from `s-box` and Polaris tokens. No chart
 * library, for the same reason `order-chart` has none: a second design system
 * inside a Polaris page is a rejection reason (docs/BUILD_SPEC.md section 2.6),
 * and this is five rows.
 *
 * The bar is decorative and the number is the content, so the bar is hidden
 * from assistive technology and the row reads as "Glavno skladisce, 18 orders".
 * Fixed row height, so the block does not reflow as the figures change
 * (section 2.5 budgets CLS at 0.1).
 */
export interface DistributionRow {
  name: string;
  count: number;
}

export function DistributionBars({
  rows,
  /** What one unit is, for the row's own label: "order", "product". */
  unit = "order",
  empty,
}: {
  rows: DistributionRow[];
  unit?: string;
  empty: string;
}) {
  if (rows.length === 0) {
    return <s-text color="subdued">{empty}</s-text>;
  }

  const peak = Math.max(1, ...rows.map((row) => row.count));

  return (
    <s-stack direction="block" gap="small-300">
      {rows.map((row) => (
        <s-stack key={row.name} direction="block" gap="small-500">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
            <s-text>{row.name}</s-text>
            <s-text color="subdued">
              {`${row.count} ${row.count === 1 ? unit : `${unit}s`}`}
            </s-text>
          </s-grid>

          <s-box
            background="subdued"
            borderRadius="base"
            minBlockSize="6px"
            inlineSize="100%"
            accessibilityVisibility="hidden"
          >
            <s-box
              background="strong"
              borderRadius="base"
              minBlockSize="6px"
              inlineSize={`${Math.max(2, Math.round((row.count / peak) * 100))}%`}
            />
          </s-box>
        </s-stack>
      ))}
    </s-stack>
  );
}
