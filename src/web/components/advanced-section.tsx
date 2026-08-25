import { useState, type ReactNode } from "react";

/**
 * The card at the foot of a settings page for everything a merchant almost
 * never needs to open.
 *
 * The sibling of `Advanced`, and the two are not interchangeable. `Advanced`
 * folds one setting away under the heading that gives it meaning, at the foot
 * of that heading's own card. This is the other case: settings that belong to
 * the page rather than to any one card, collected in a card of their own and
 * closed until asked for. It exists because a page grows — each new rarely-used
 * setting goes inside as another group, rather than as another card the
 * ordinary merchant has to scroll past.
 *
 * Closed, it still answers itself: `summary` says what the settings inside
 * currently are, so opening is for changing rather than for checking. That is
 * the same rule `Advanced` follows, and the reason neither is a bare
 * disclosure with a chevron and nothing else.
 *
 * The heading is fixed rather than a prop, because "Advanced settings" at the
 * bottom of a settings page is a place the merchant learns once and expects to
 * find in the same words on the next page.
 */
export interface AdvancedSectionProps {
  /** What the settings inside currently say, in one short sentence. */
  summary: string;
  children: ReactNode;
}

export function AdvancedSection({ summary, children }: AdvancedSectionProps) {
  const [open, setOpen] = useState(false);

  return (
    <s-section heading="Advanced settings">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small-300" alignItems="center">
          {/*
           * "Show" rather than "Show advanced settings": the card's own
           * heading is directly above it and says the rest. The full sentence
           * is still on the button for anyone who reaches it without the
           * heading, which is what accessibilityLabel is for.
           */}
          <s-button
            type="button"
            variant="secondary"
            icon={open ? "chevron-up" : "chevron-down"}
            accessibilityLabel={
              open ? "Hide advanced settings" : "Show advanced settings"
            }
            onClick={() => setOpen((now) => !now)}
          >
            {open ? "Hide" : "Show"}
          </s-button>
          {open ? null : <s-text color="subdued">{summary}</s-text>}
        </s-stack>
        {open ? children : null}
      </s-stack>
    </s-section>
  );
}
