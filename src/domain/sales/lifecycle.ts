import type { CampaignStatus, VariantState } from "~/domain/sales/types";

/**
 * The campaign state machine (docs/sale-campaigns.md § Campaign state
 * machine). The table is the rule; the repositories apply it as conditional
 * updates so a race produces one transition.
 */

export type CampaignAction =
  | "schedule"
  | "unschedule"
  | "activate"
  | "pause"
  | "resume"
  | "end"
  | "cancel";

const TRANSITIONS: Record<
  CampaignStatus,
  Partial<Record<CampaignAction, CampaignStatus>>
> = {
  draft: { schedule: "scheduled", activate: "active", cancel: "cancelled" },
  scheduled: { activate: "active", unschedule: "draft", cancel: "cancelled" },
  active: { pause: "paused", end: "completed" },
  paused: { resume: "active", end: "completed", cancel: "cancelled" },
  completed: {},
  cancelled: {},
};

export function nextStatus(
  from: CampaignStatus,
  action: CampaignAction,
): CampaignStatus | null {
  return TRANSITIONS[from][action] ?? null;
}

export function canTransition(
  from: CampaignStatus,
  action: CampaignAction,
): boolean {
  return nextStatus(from, action) !== null;
}

/**
 * What may be edited in each status. Targeting, discount, rounding and the
 * policies decide what is on sale, so they are frozen while prices are out;
 * pausing restores them and unfreezes the campaign.
 */
export type Editability = "full" | "limited" | "none";

export function editability(status: CampaignStatus): Editability {
  switch (status) {
    case "draft":
    case "scheduled":
    case "paused":
      return "full";
    case "active":
      return "limited";
    case "completed":
    case "cancelled":
      return "none";
  }
}

/** Terminal for one activation: nothing more will happen to this row on its own. */
export function isSettled(state: VariantState): boolean {
  return (
    state === "restored" ||
    state === "released" ||
    state === "skipped" ||
    state === "review"
  );
}

/**
 * Whether a restore has finished with every row accounted for
 * (docs/sale-campaigns.md: a campaign never claims to have finished
 * restoring while a row is `restore_failed` or still moving).
 */
export function restoreComplete(
  counts: Partial<Record<VariantState, number>>,
): boolean {
  const moving =
    (counts.pending ?? 0) +
    (counts.applying ?? 0) +
    (counts.applied ?? 0) +
    (counts.restoring ?? 0) +
    (counts.restore_failed ?? 0) +
    (counts.failed ?? 0);
  return moving === 0;
}

/** The phase a merchant sees, derived from the rows rather than stored. */
export type CampaignPhase =
  | "applying"
  | "applied"
  | "partially_applied"
  | "restoring"
  | "needs_attention"
  | "idle";

export function phaseFor(
  status: CampaignStatus,
  counts: Partial<Record<VariantState, number>>,
  runInProgress: "apply" | "restore" | null,
): CampaignPhase {
  if (runInProgress === "apply") return "applying";
  if (runInProgress === "restore") return "restoring";
  const failed = (counts.failed ?? 0) + (counts.restore_failed ?? 0);
  const review = counts.review ?? 0;
  if (failed > 0)
    return status === "active" ? "partially_applied" : "needs_attention";
  if (review > 0) return "needs_attention";
  if (status === "active") return "applied";
  return "idle";
}
