import { useState, type ReactNode } from "react";

/**
 * An explanation folded away under the control it explains.
 *
 * The third member of the family with `Advanced` and `AdvancedSection`, and
 * the one that hides prose rather than settings. A settings card earns its
 * clarity by asking one question per control; the paragraph explaining why the
 * question exists at all, what MetaKocka does with the answer, and which edge
 * case made it necessary is worth keeping and worth not making everybody read
 * (docs/ui-conventions.md: explanatory prose is a last resort).
 *
 * A real button, not a line of text with a click handler: bordered, padded,
 * with a chevron that says which way it goes and a label that says what is
 * behind it. Every disclosure in this app looks like this one, so a merchant
 * learns the shape once.
 *
 * The panel is a subdued box rather than loose paragraphs, so an opened
 * explanation reads as an aside about the control above it rather than as more
 * of the card.
 */
export interface LearnMoreProps {
  /** What is behind it, in two or three words. Verb-free, sentence case. */
  label?: string;
  children: ReactNode;
}

export function LearnMore({ label = "Learn more", children }: LearnMoreProps) {
  const [open, setOpen] = useState(false);

  return (
    <s-stack direction="block" gap="small-300">
      <s-stack direction="inline">
        <s-button
          type="button"
          variant="secondary"
          icon={open ? "chevron-up" : "chevron-down"}
          accessibilityLabel={open ? `Hide: ${label}` : `Show: ${label}`}
          onClick={() => setOpen((now) => !now)}
        >
          {label}
        </s-button>
      </s-stack>

      {open ? (
        <s-box
          padding="base"
          background="subdued"
          borderRadius="base"
          borderWidth="base"
          borderStyle="solid"
          borderColor="subdued"
        >
          <s-stack direction="block" gap="small-300">
            {children}
          </s-stack>
        </s-box>
      ) : null}
    </s-stack>
  );
}
