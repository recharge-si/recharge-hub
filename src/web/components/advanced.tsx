import { useState, type ReactNode } from "react";

/**
 * A setting that is right almost always and wrong occasionally, folded away at
 * the foot of the card it belongs to.
 *
 * The alternative to this is worse in both directions: leaving such a setting
 * in the flow makes every merchant read a question almost none of them need to
 * answer, and removing it strands the ones who do. So it stays where it
 * belongs, under the heading that gives it meaning, one click down.
 *
 * Closed, it still answers itself. `summary` says what the setting currently
 * is, so nobody has to open it to find out — opening is for changing, not for
 * checking.
 *
 * Built from a divider, a button and a line, because Polaris has no disclosure
 * element. The chevron is what makes it read as one rather than as a stray
 * word — the locations page already opens its own advanced settings this way,
 * and an unadorned tertiary button is indistinguishable from a label.
 */
export interface AdvancedProps {
  /** What the folded settings currently say, in one short sentence. */
  summary: string;
  children: ReactNode;
}

export function Advanced({ summary, children }: AdvancedProps) {
  const [open, setOpen] = useState(false);

  return (
    <s-stack direction="block" gap="small-300">
      <s-divider />
      <s-stack direction="inline" gap="small-300" alignItems="center">
        <s-button
          type="button"
          variant="secondary"
          icon={open ? "chevron-up" : "chevron-down"}
          accessibilityLabel={
            open ? "Hide advanced settings" : "Show advanced settings"
          }
          onClick={() => setOpen((now) => !now)}
        >
          Advanced
        </s-button>
        {open ? null : <s-text color="subdued">{summary}</s-text>}
      </s-stack>
      {open ? children : null}
    </s-stack>
  );
}
