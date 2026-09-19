import { useState } from "react";

/**
 * Section 1 of the campaign editor: the name, and the notes folded under it.
 *
 * The name is the one thing every campaign needs, so it is the only field in
 * view. Notes are for the team and most campaigns have none, so they open
 * from a disclosure that says, closed, whether there are any — the same
 * bordered-chevron shape every fold in this app uses
 * (docs/ui-conventions.md § Disclosure).
 */
export interface CampaignDetailsProps {
  name: string;
  notes: string;
  onNameChange: (name: string) => void;
  onNotesChange: (notes: string) => void;
  nameError?: string;
  disabled?: boolean;
}

export function CampaignDetails({
  name,
  notes,
  onNameChange,
  onNotesChange,
  nameError,
  disabled,
}: CampaignDetailsProps) {
  const [notesOpen, setNotesOpen] = useState(notes.trim() !== "");
  const off = disabled ? { disabled: true } : {};

  return (
    <s-section heading="1. Campaign details">
      <s-stack direction="block" gap="base">
        <s-text-field
          label="Name"
          placeholder="Autumn sale"
          value={name}
          onChange={(event) => onNameChange(event.currentTarget.value)}
          {...(nameError ? { error: nameError } : {})}
          {...off}
        />

        <s-stack direction="block" gap="small-300">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-button
              type="button"
              variant="secondary"
              icon={notesOpen ? "chevron-up" : "chevron-down"}
              accessibilityLabel={
                notesOpen ? "Hide internal notes" : "Show internal notes"
              }
              onClick={() => setNotesOpen((now) => !now)}
            >
              Internal notes
            </s-button>
            {notesOpen ? null : (
              <s-text color="subdued">
                {notes.trim() === "" ? "None" : firstLine(notes)}
              </s-text>
            )}
          </s-stack>
          {notesOpen ? (
            <s-text-area
              label="Internal notes"
              labelAccessibilityVisibility="exclusive"
              details="For your team. Customers never see this."
              rows={3}
              value={notes}
              onChange={(event) => onNotesChange(event.currentTarget.value)}
              {...off}
            />
          ) : null}
        </s-stack>
      </s-stack>
    </s-section>
  );
}

/** The first line of the notes, cut short enough to sit beside the button. */
function firstLine(notes: string): string {
  const line = notes.trim().split("\n")[0] ?? "";
  return line.length > 72 ? `${line.slice(0, 72).trimEnd()}…` : line;
}
