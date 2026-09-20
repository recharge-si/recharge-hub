import {
  scheduleSummary,
  timeZoneLabel,
  type ScheduleFormFields,
} from "~/web/lib/campaign-editor";
import { formatInZone } from "~/web/lib/sales";
import type { CampaignForm } from "~/web/lib/sales.server";

/**
 * Section 4 of the campaign editor: when.
 *
 * Two questions — starts, ends — each a pair of choices with the date and
 * time folded under the choice that needs them, so a campaign that starts on
 * activation and runs until stopped is two radios and nothing else. The zone
 * is stated once, quietly, and the line under it reads the answer back:
 * "Starts on activation · No end date".
 */
export interface CampaignScheduleProps {
  form: ScheduleFormFields;
  onChange: <K extends keyof ScheduleFormFields>(
    key: K,
    value: CampaignForm[K],
  ) => void;
  errorFor: (field: "startDate" | "endDate") => string | undefined;
  timeZone: string;
  status: string;
  /** The stored start, shown in place of the choice once the campaign is live. */
  startedAt: string | null;
  /** Everything but the end is frozen. */
  startDisabled?: boolean;
  /** Nothing can change. */
  disabled?: boolean;
}

export function CampaignSchedule({
  form,
  onChange,
  errorFor,
  timeZone,
  status,
  startedAt,
  startDisabled,
  disabled,
}: CampaignScheduleProps) {
  const off = disabled ? { disabled: true } : {};
  const startOff = disabled || startDisabled ? { disabled: true } : {};
  const summary = scheduleSummary(form, timeZone, { status, startedAt });
  const active = status === "active";

  return (
    <s-section heading="4. Schedule">
      <s-stack direction="block" gap="base">
        {active ? (
          <s-stack direction="block" gap="small-500">
            <s-text type="strong">Starts</s-text>
            <s-text>
              {startedAt
                ? `Started ${formatInZone(startedAt, timeZone)}.`
                : "Started."}
            </s-text>
          </s-stack>
        ) : (
          <s-choice-list
            label="Starts"
            name="startMode"
            values={[form.startMode]}
            onChange={(event) => {
              const next = event.currentTarget.values[0];
              if (next === "now" || next === "at") onChange("startMode", next);
            }}
            {...startOff}
          >
            <s-choice value="now">Immediately when activated</s-choice>
            <s-choice value="at">
              At a date and time
              {form.startMode === "at" ? (
                <s-grid
                  slot="secondary-content"
                  gridTemplateColumns="@container (inline-size <= 420px) 1fr, 'minmax(160px, 220px) minmax(100px, 140px)'"
                  gap="small-300"
                  alignItems="start"
                >
                  <s-date-field
                    label="Start date"
                    labelAccessibilityVisibility="exclusive"
                    value={form.startDate}
                    onChange={(event) =>
                      onChange("startDate", event.currentTarget.value)
                    }
                    {...(errorFor("startDate")
                      ? { error: errorFor("startDate") }
                      : {})}
                    {...startOff}
                  />
                  <s-text-field
                    label="Start time"
                    labelAccessibilityVisibility="exclusive"
                    placeholder="00:00"
                    value={form.startTime}
                    onChange={(event) =>
                      onChange("startTime", event.currentTarget.value)
                    }
                    {...startOff}
                  />
                </s-grid>
              ) : null}
            </s-choice>
          </s-choice-list>
        )}

        <s-choice-list
          label="Ends"
          name="endMode"
          values={[form.endMode]}
          onChange={(event) => {
            const next = event.currentTarget.values[0];
            if (next === "none" || next === "at") onChange("endMode", next);
          }}
          {...off}
        >
          <s-choice value="none">No end date</s-choice>
          <s-choice value="at">
            At a date and time
            {form.endMode === "at" ? (
              <s-grid
                slot="secondary-content"
                gridTemplateColumns="@container (inline-size <= 420px) 1fr, 'minmax(160px, 220px) minmax(100px, 140px)'"
                gap="small-300"
                alignItems="start"
              >
                <s-date-field
                  label="End date"
                  labelAccessibilityVisibility="exclusive"
                  value={form.endDate}
                  onChange={(event) =>
                    onChange("endDate", event.currentTarget.value)
                  }
                  {...(errorFor("endDate")
                    ? { error: errorFor("endDate") }
                    : {})}
                  {...off}
                />
                <s-text-field
                  label="End time"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="23:59"
                  value={form.endTime}
                  onChange={(event) =>
                    onChange("endTime", event.currentTarget.value)
                  }
                  {...off}
                />
              </s-grid>
            ) : null}
          </s-choice>
        </s-choice-list>

        <s-stack direction="block" gap="small-500">
          <s-text>{summary.line}</s-text>
          <s-text color="subdued">{timeZoneLabel(timeZone)}</s-text>
          {status === "draft" && form.startMode === "at" ? (
            <s-text color="subdued">
              Save, then choose Schedule to have it start on its own.
            </s-text>
          ) : null}
        </s-stack>
      </s-stack>
    </s-section>
  );
}
