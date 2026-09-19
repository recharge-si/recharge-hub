import { useState } from "react";

import { formatDateTime } from "~/web/lib/datetime";

/**
 * The campaign's own trail from `event_log` (docs/sale-campaigns.md § Audit
 * log), folded at the foot of the editor.
 *
 * Closed, it says the last thing that happened and when, which is what a
 * merchant glancing at it wants; the whole trail is one click away for the
 * one investigating. The disclosure is the bordered chevron button every
 * fold in this app uses (docs/ui-conventions.md § Disclosure).
 */
const EVENT_COPY: Record<string, string> = {
  "sale_campaign.created": "Created",
  "sale_campaign.edited": "Edited",
  "sale_campaign.scheduled": "Scheduled",
  "sale_campaign.unscheduled": "Back to draft",
  "sale_campaign.activated": "Activated",
  "sale_campaign.paused": "Paused",
  "sale_campaign.resumed": "Resumed",
  "sale_campaign.ending": "Ending: putting prices back",
  "sale_campaign.completed": "Completed",
  "sale_campaign.cancelled": "Cancelled",
  "sale_campaign.restore_requested": "Restore of original prices requested",
  "sale_campaign.retry_requested": "Retry of failed variants requested",
  "sale_campaign.conflict_detected": "Conflict with another campaign",
  "sale_campaign.apply_finished": "Finished applying",
  "sale_campaign.restore_finished": "Finished putting prices back",
  "sale_campaign.membership_changed": "Products joined or left",
};

export function describeCampaignEvent(event: string, detail: unknown): string {
  const d = (detail ?? {}) as Record<string, unknown>;
  const base = EVENT_COPY[event] ?? event;
  const counts = d.counts as Record<string, number> | undefined;
  const parts: string[] = [];
  if (typeof d.by === "string" && d.by) parts.push(`by ${d.by}`);
  if (typeof d.variants === "number") parts.push(`${d.variants} variants`);
  if (counts) {
    const said = Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([state, count]) => `${count} ${state.replace("_", " ")}`);
    if (said.length > 0) parts.push(said.join(", "));
  }
  if (typeof d.added === "number" || typeof d.released === "number") {
    parts.push(`${d.added ?? 0} added, ${d.released ?? 0} released`);
  }
  if (Array.isArray(d.holders) && d.holders.length > 0)
    parts.push(`with ${d.holders.join(", ")}`);
  return parts.length > 0 ? `${base} — ${parts.join(" · ")}` : base;
}

export interface CampaignActivityProps {
  events: Array<{
    id: string;
    at: string;
    event: string;
    detail: unknown;
  }>;
}

export function CampaignActivity({ events }: CampaignActivityProps) {
  const [open, setOpen] = useState(false);
  const latest = events[0];

  return (
    <s-section heading="Activity">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-button
            type="button"
            variant="secondary"
            icon={open ? "chevron-up" : "chevron-down"}
            accessibilityLabel={open ? "Hide activity" : "Show activity"}
            onClick={() => setOpen((now) => !now)}
            {...(events.length === 0 ? { disabled: true } : {})}
          >
            {open ? "Hide" : `Show all (${events.length})`}
          </s-button>
          {open ? null : (
            <s-text color="subdued">
              {latest
                ? `${describeCampaignEvent(latest.event, latest.detail)} · ${formatDateTime(latest.at)}`
                : "Nothing yet."}
            </s-text>
          )}
        </s-stack>

        {open ? (
          <s-stack direction="block" gap="small-300">
            {events.map((event) => (
              <s-grid
                key={event.id}
                gridTemplateColumns="@container (inline-size <= 480px) 1fr, auto 1fr"
                gap="small-300 base"
              >
                <s-text color="subdued" fontVariantNumeric="tabular-nums">
                  {formatDateTime(event.at)}
                </s-text>
                <s-text>
                  {describeCampaignEvent(event.event, event.detail)}
                </s-text>
              </s-grid>
            ))}
          </s-stack>
        ) : null}
      </s-stack>
    </s-section>
  );
}
