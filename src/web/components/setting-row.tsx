import type { ReactNode } from "react";

/**
 * One row: what the setting is called, what it says now, and the control that
 * changes it.
 *
 * The shape the settings pages are built from. Three of these under one heading
 * read as a column of answers a merchant can scan; the same three as paragraphs
 * with buttons after them read as three cards that happen to be next to each
 * other.
 *
 * The action stacks under the label on a narrow screen (§2.6), by container
 * query rather than viewport, because a card is narrower than the window it is
 * in.
 */
export function SettingRow({
  label,
  summary,
  tone = "auto",
  action = null,
}: {
  label: string;
  summary: string;
  tone?: "auto" | "critical";
  action?: ReactNode;
}) {
  return (
    <s-grid
      gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr auto"
      gap="base"
      alignItems="center"
    >
      <s-stack direction="block" gap="small-500">
        <s-text type="strong">{label}</s-text>
        <s-text color="subdued" tone={tone}>
          {summary}
        </s-text>
      </s-stack>
      {action ? <s-stack direction="inline">{action}</s-stack> : null}
    </s-grid>
  );
}
