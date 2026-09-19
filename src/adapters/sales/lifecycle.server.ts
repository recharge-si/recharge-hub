import type { SaleRunKind } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import { raiseException } from "~/adapters/db/repositories/exception.server";
import {
  countVariantStates,
  createRun,
  getCampaign,
  resetFailedVariants,
  stageMembership,
  transitionCampaign,
  updateCampaign,
  type Campaign,
} from "~/adapters/db/repositories/sale-campaign.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES, saleRunKey } from "~/adapters/queue/queues";
import { evaluateCampaign } from "~/adapters/sales/evaluate.server";
import { recordCampaignEvent } from "~/adapters/sales/events.server";
import { isEmptyGroup, parseRuleGroup } from "~/domain/sales/rules";
import { canTransition, restoreComplete } from "~/domain/sales/lifecycle";
import type { Principal } from "~/domain/types";

/**
 * The campaign lifecycle as the merchant and the scheduler drive it
 * (docs/sale-campaigns.md § Campaign state machine).
 *
 * Shared by the web routes and the jobs, so "activate" means one thing
 * whether a person pressed the button or the clock reached `starts_at`.
 * Every status change is a conditional update; every price change is a
 * queued run, never done here.
 */

export type LifecycleResult =
  | { ok: true; message: string; runId?: string }
  | { ok: false; message: string };

async function enqueueRun(
  principal: Principal,
  campaign: Campaign,
  kind: SaleRunKind,
  total: number,
  requestedBy: string | null,
): Promise<string> {
  const run = await createRun(principal, campaign.id, kind, total, requestedBy);
  await enqueue(
    QUEUES.saleCampaignRun,
    {
      shopDomain: principal.shopDomain,
      campaignId: campaign.id,
      runId: run.id,
    },
    { singletonKey: saleRunKey(campaign.id) },
  );
  return run.id;
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString("en")} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Activate now, or resume, or the scheduler reaching `starts_at`.
 *
 * Evaluates the rules, refuses what cannot be applied safely (no rules, no
 * matches, a conflict the strategy will not resolve), stages the
 * membership as pending rows, moves the status and queues the apply run.
 * Nothing in Shopify changes until the run reads it live.
 */
export async function activateCampaign(
  principal: Principal,
  campaignId: string,
  options: { now: Date; requestedBy: string | null },
): Promise<LifecycleResult> {
  const campaign = await getCampaign(principal, campaignId);
  if (!campaign) return { ok: false, message: "Campaign not found." };

  const action = campaign.status === "paused" ? "resume" : "activate";
  if (!canTransition(campaign.status, action)) {
    return {
      ok: false,
      message: `A ${campaign.status} campaign cannot be ${action}d.`,
    };
  }

  if (isEmptyGroup(parseRuleGroup(campaign.includeRules))) {
    return {
      ok: false,
      message: "Choose which products the sale applies to first.",
    };
  }

  const evaluation = await evaluateCampaign(principal, campaign);
  if (evaluation.final.length === 0) {
    return {
      ok: false,
      message:
        "The rules match no variants in the catalogue. Check the targeting, or refresh the catalogue if products changed.",
    };
  }

  const refused = evaluation.activeConflicts.filter(
    (conflict) => conflict.outcome === "refuse",
  );
  if (refused.length > 0) {
    const holders = [...new Set(refused.map((c) => c.holderName))];
    await recordCampaignEvent(
      principal,
      campaign.id,
      "sale_campaign.conflict_detected",
      {
        variants: refused.length,
        holders,
      },
    );
    return {
      ok: false,
      message: `${plural(refused.length, "variant")} already in ${holders.join(", ")}. Change the conflict handling, exclude them, or end the other campaign first.`,
    };
  }

  const { staged, kept } = await stageMembership(
    principal,
    campaign.id,
    evaluation.final.map((facts) => ({
      productId: facts.productId,
      variantId: facts.variantId,
      sku: facts.sku,
      title: facts.variantTitle
        ? `${facts.productTitle} — ${facts.variantTitle}`
        : facts.productTitle,
    })),
    campaign.currency,
  );

  const moved = await transitionCampaign(
    principal,
    campaign.id,
    campaign.status,
    "active",
    options.now,
  );
  if (!moved) {
    return {
      ok: false,
      message:
        "The campaign changed while this was being prepared. Reload and try again.",
    };
  }
  await updateCampaign(principal, campaign.id, {
    ...(campaign.startsAt === null || campaign.startsAt > options.now
      ? { startsAt: options.now }
      : {}),
  });
  await prisma.saleCampaign.update({
    where: { id: campaign.id },
    data: { evaluatedAt: options.now },
  });

  const runId = await enqueueRun(
    principal,
    campaign,
    "apply",
    staged,
    options.requestedBy,
  );

  await recordCampaignEvent(
    principal,
    campaign.id,
    action === "resume" ? "sale_campaign.resumed" : "sale_campaign.activated",
    {
      by: options.requestedBy,
      variants: staged,
      alreadyOwned: kept,
      products: evaluation.productCount,
      conflictsResolved: evaluation.activeConflicts.length,
      runId,
    },
  );

  return {
    ok: true,
    runId,
    message: `Applying the sale to ${plural(staged, "variant")}.`,
  };
}

export async function scheduleCampaign(
  principal: Principal,
  campaignId: string,
  now: Date,
): Promise<LifecycleResult> {
  const campaign = await getCampaign(principal, campaignId);
  if (!campaign) return { ok: false, message: "Campaign not found." };
  if (!canTransition(campaign.status, "schedule")) {
    return {
      ok: false,
      message: `A ${campaign.status} campaign cannot be scheduled.`,
    };
  }
  if (!campaign.startsAt || campaign.startsAt <= now) {
    return {
      ok: false,
      message:
        "Set a start date and time in the future, or activate the campaign now.",
    };
  }
  if (campaign.endsAt && campaign.endsAt <= campaign.startsAt) {
    return { ok: false, message: "The end must come after the start." };
  }
  if (isEmptyGroup(parseRuleGroup(campaign.includeRules))) {
    return {
      ok: false,
      message: "Choose which products the sale applies to first.",
    };
  }
  const moved = await transitionCampaign(
    principal,
    campaign.id,
    campaign.status,
    "scheduled",
    now,
  );
  if (!moved)
    return {
      ok: false,
      message: "The campaign changed. Reload and try again.",
    };
  await recordCampaignEvent(principal, campaign.id, "sale_campaign.scheduled", {
    startsAt: campaign.startsAt.toISOString(),
    endsAt: campaign.endsAt?.toISOString() ?? null,
  });
  return { ok: true, message: "Scheduled." };
}

export async function unscheduleCampaign(
  principal: Principal,
  campaignId: string,
  now: Date,
): Promise<LifecycleResult> {
  const campaign = await getCampaign(principal, campaignId);
  if (!campaign) return { ok: false, message: "Campaign not found." };
  const moved = await transitionCampaign(
    principal,
    campaign.id,
    "scheduled",
    "draft",
    now,
  );
  if (!moved)
    return {
      ok: false,
      message: "Only a scheduled campaign can go back to draft.",
    };
  await recordCampaignEvent(
    principal,
    campaign.id,
    "sale_campaign.unscheduled",
  );
  return { ok: true, message: "Back to draft." };
}

/** Pause: prices go back, the campaign keeps its membership and can resume. */
export async function pauseCampaign(
  principal: Principal,
  campaignId: string,
  options: { now: Date; requestedBy: string | null },
): Promise<LifecycleResult> {
  const campaign = await getCampaign(principal, campaignId);
  if (!campaign) return { ok: false, message: "Campaign not found." };
  const moved = await transitionCampaign(
    principal,
    campaign.id,
    "active",
    "paused",
    options.now,
  );
  if (!moved)
    return { ok: false, message: "Only an active campaign can be paused." };

  const counts = await countVariantStates(campaign.id);
  const runId = await enqueueRun(
    principal,
    campaign,
    "restore",
    (counts.applied ?? 0) + (counts.applying ?? 0) + (counts.pending ?? 0),
    options.requestedBy,
  );
  await recordCampaignEvent(principal, campaign.id, "sale_campaign.paused", {
    by: options.requestedBy,
    runId,
  });
  return {
    ok: true,
    runId,
    message: "Pausing: original prices are being put back.",
  };
}

/**
 * End now, or the scheduler reaching `ends_at`. The campaign stays active
 * until the restore run has verified every row; the run completes it.
 */
export async function endCampaign(
  principal: Principal,
  campaignId: string,
  options: {
    now: Date;
    requestedBy: string | null;
    reason: "ends_at" | "end_now" | "restore";
  },
): Promise<LifecycleResult> {
  const campaign = await getCampaign(principal, campaignId);
  if (!campaign) return { ok: false, message: "Campaign not found." };

  if (campaign.status === "paused") {
    const counts = await countVariantStates(campaign.id);
    if (restoreComplete(counts)) {
      const moved = await transitionCampaign(
        principal,
        campaign.id,
        "paused",
        "completed",
        options.now,
      );
      if (moved) {
        await recordCampaignEvent(
          principal,
          campaign.id,
          "sale_campaign.completed",
          {
            by: options.requestedBy,
            reason: options.reason,
          },
        );
      }
      return { ok: true, message: "Campaign completed." };
    }
    const runId = await enqueueRun(
      principal,
      campaign,
      "restore",
      counts.applied ?? 0,
      options.requestedBy,
    );
    return {
      ok: true,
      runId,
      message: "Finishing the restore before completing.",
    };
  }

  if (campaign.status !== "active") {
    return {
      ok: false,
      message: `A ${campaign.status} campaign has no prices out to restore.`,
    };
  }

  if (campaign.endsAt === null || campaign.endsAt > options.now) {
    await updateCampaign(principal, campaign.id, { endsAt: options.now });
  }

  const counts = await countVariantStates(campaign.id);
  if (restoreComplete(counts)) {
    const moved = await transitionCampaign(
      principal,
      campaign.id,
      "active",
      "completed",
      options.now,
    );
    if (moved) {
      await recordCampaignEvent(
        principal,
        campaign.id,
        "sale_campaign.completed",
        {
          by: options.requestedBy,
          reason: options.reason,
        },
      );
    }
    return { ok: true, message: "Campaign completed." };
  }

  const runId = await enqueueRun(
    principal,
    campaign,
    "restore",
    (counts.applied ?? 0) + (counts.applying ?? 0) + (counts.pending ?? 0),
    options.requestedBy,
  );
  await recordCampaignEvent(
    principal,
    campaign.id,
    options.reason === "restore"
      ? "sale_campaign.restore_requested"
      : "sale_campaign.ending",
    { by: options.requestedBy, reason: options.reason, runId },
  );
  return { ok: true, runId, message: "Putting original prices back." };
}

export async function cancelCampaign(
  principal: Principal,
  campaignId: string,
  options: { now: Date; requestedBy: string | null },
): Promise<LifecycleResult> {
  const campaign = await getCampaign(principal, campaignId);
  if (!campaign) return { ok: false, message: "Campaign not found." };
  if (!canTransition(campaign.status, "cancel")) {
    return {
      ok: false,
      message:
        campaign.status === "active"
          ? "End the campaign to put prices back; an active campaign is not cancelled."
          : `A ${campaign.status} campaign cannot be cancelled.`,
    };
  }
  if (campaign.status === "paused") {
    const counts = await countVariantStates(campaign.id);
    if (!restoreComplete(counts)) {
      return {
        ok: false,
        message:
          "Some prices are not back yet. Retry the failed variants first.",
      };
    }
  }
  const moved = await transitionCampaign(
    principal,
    campaign.id,
    campaign.status,
    "cancelled",
    options.now,
  );
  if (!moved)
    return {
      ok: false,
      message: "The campaign changed. Reload and try again.",
    };
  await recordCampaignEvent(principal, campaign.id, "sale_campaign.cancelled", {
    by: options.requestedBy,
  });
  return { ok: true, message: "Cancelled." };
}

/** Retry failed: failed rows back to pending or applied, and a run to work them. */
export async function retryFailedVariants(
  principal: Principal,
  campaignId: string,
  options: { now: Date; requestedBy: string | null },
): Promise<LifecycleResult> {
  const campaign = await getCampaign(principal, campaignId);
  if (!campaign) return { ok: false, message: "Campaign not found." };
  const { toApply, toRestore } = await resetFailedVariants(campaign.id);
  if (toApply + toRestore === 0) {
    return { ok: false, message: "Nothing failed. There is nothing to retry." };
  }
  /*
   * Which way the retry goes depends on where the campaign is: an active
   * campaign with no end reached applies again; anything else — paused,
   * ending, completed — restores.
   */
  const applying =
    campaign.status === "active" &&
    (campaign.endsAt === null || campaign.endsAt > options.now);
  const kind: SaleRunKind = applying ? "retry" : "restore";
  const runId = await enqueueRun(
    principal,
    campaign,
    kind,
    applying ? toApply : toRestore + toApply,
    options.requestedBy,
  );
  await recordCampaignEvent(
    principal,
    campaign.id,
    "sale_campaign.retry_requested",
    {
      by: options.requestedBy,
      toApply,
      toRestore,
      runId,
    },
  );
  return {
    ok: true,
    runId,
    message: `Retrying ${plural(toApply + toRestore, "variant")}.`,
  };
}

/**
 * What the scheduler does for a campaign whose end has passed: complete it
 * when every row is settled, queue a restore when rows are still out, and
 * leave it — with the exception already raised — when only failed restores
 * remain, rather than queueing a run a minute for ever.
 */
export async function settleEnding(
  principal: Principal,
  campaignId: string,
  now: Date,
): Promise<void> {
  const campaign = await getCampaign(principal, campaignId);
  if (!campaign || campaign.status !== "active") return;

  const counts = await countVariantStates(campaign.id);
  if (restoreComplete(counts)) {
    const moved = await transitionCampaign(
      principal,
      campaign.id,
      "active",
      "completed",
      now,
    );
    if (moved) {
      await recordCampaignEvent(
        principal,
        campaign.id,
        "sale_campaign.completed",
        {
          reason: "ends_at",
        },
      );
    }
    return;
  }

  const outstanding =
    (counts.applied ?? 0) + (counts.applying ?? 0) + (counts.pending ?? 0);
  if (outstanding > 0) {
    await enqueueRun(principal, campaign, "restore", outstanding, null);
    return;
  }

  // Only restore_failed left: a person's problem, said once.
  await raiseException(principal, {
    kind: "sale_restore_failed",
    dedupeKey: `campaign:${campaign.id}`,
    message: `${plural(counts.restore_failed ?? 0, "variant")} of "${campaign.name}" could not be put back to their original price. Open the campaign and retry the failed variants.`,
    detail: { campaignId: campaign.id, counts },
  });
}
