import { CONFLICT_LABEL } from "~/web/lib/sales";
import type { CampaignForm } from "~/web/lib/sales.server";

/**
 * Section 5 of the campaign editor: what happens when another campaign holds
 * one of these variants.
 *
 * Four choices, one line each. The priority number only exists under
 * "Higher priority wins", so it is folded under that choice and shown only
 * while it is the one chosen: a field that changes nothing is not a field a
 * merchant should have to read past.
 */
export interface CampaignConflictsProps {
  strategy: CampaignForm["conflictStrategy"];
  priority: string;
  onStrategyChange: (strategy: CampaignForm["conflictStrategy"]) => void;
  onPriorityChange: (priority: string) => void;
  priorityError?: string;
  disabled?: boolean;
}

export function CampaignConflicts({
  strategy,
  priority,
  onStrategyChange,
  onPriorityChange,
  priorityError,
  disabled,
}: CampaignConflictsProps) {
  const off = disabled ? { disabled: true } : {};

  return (
    <s-section heading="5. Conflict handling">
      <s-stack direction="block" gap="base">
        <s-text color="subdued">
          When another campaign holds one of these variants at the same time.
          One campaign holds a variant, or none does; prices never stack.
        </s-text>
        <s-choice-list
          label="If another campaign holds a variant"
          labelAccessibilityVisibility="exclusive"
          name="conflictStrategy"
          values={[strategy]}
          onChange={(event) => {
            const next = event.currentTarget.values[0] ?? "";
            if (next in CONFLICT_LABEL)
              onStrategyChange(next as CampaignForm["conflictStrategy"]);
          }}
          {...off}
        >
          {(
            Object.keys(CONFLICT_LABEL) as Array<keyof typeof CONFLICT_LABEL>
          ).map((option) => (
            <s-choice key={option} value={option}>
              {CONFLICT_LABEL[option].label}
              <s-text slot="details">{CONFLICT_LABEL[option].detail}</s-text>
              {option === "priority" && strategy === "priority" ? (
                <s-box slot="secondary-content" maxInlineSize="200px">
                  <s-text-field
                    label="Priority"
                    details="A whole number. Higher wins; -1000 to 1000."
                    placeholder="0"
                    value={priority}
                    onChange={(event) =>
                      onPriorityChange(event.currentTarget.value)
                    }
                    {...(priorityError ? { error: priorityError } : {})}
                    {...off}
                  />
                </s-box>
              ) : null}
            </s-choice>
          ))}
        </s-choice-list>
      </s-stack>
    </s-section>
  );
}
