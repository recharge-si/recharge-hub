import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { raiseException } from "~/adapters/db/repositories/exception.server";
import {
  advanceRun,
  claimVariantBatch,
  countVariantStates,
  finishRun,
  getCampaign,
  getRun,
  listHeldPendingRows,
  markRunRunning,
  releaseStaleClaims,
  transitionCampaign,
} from "~/adapters/db/repositories/sale-campaign.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES, saleRunKey } from "~/adapters/queue/queues";
import { recordCampaignEvent } from "~/adapters/sales/events.server";
import { RELEASE_MARKER } from "~/adapters/sales/membership.server";
import {
  applyRows,
  resolveHeldRows,
  restoreRows,
} from "~/adapters/sales/writer.server";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import { restoreComplete } from "~/domain/sales/lifecycle";
import { serviceToken } from "~/domain/types";

export const saleCampaignRunJobSchema = z.object({
  shopDomain: z.string().min(1),
  campaignId: z.string().min(1),
  runId: z.string().min(1),
});

/** Variants claimed per batch: a few products' worth, one read and a handful of writes. */
const BATCH = 100;

/**
 * How long one job works before handing over to a fresh one. Well inside
 * the queue's expiry, so pg-boss never abandons a job that is making
 * progress; a campaign of thousands of variants is many short jobs, each of
 * which can be lost and picked up again without losing a row.
 */
const JOB_BUDGET_MS = 50_000;

/** Longer than the queue's expiry, so a claim this old cannot have a live job. */
const STALE_CLAIM_MS = 15 * 60_000;

/**
 * Works a campaign's rows in batches (docs/sale-campaigns.md § Scheduler and
 * jobs, § Idempotency).
 *
 * Every batch: claim rows by conditional update, read them live, decide per
 * row, write per product, record per row, advance the run. When nothing is
 * left to claim the run settles the campaign. Safe to run twice, safe to
 * kill halfway, safe to run on two workers at once.
 */
export async function handleSaleCampaignRun(job: Job<unknown>): Promise<void> {
  const { shopDomain, campaignId, runId } = saleCampaignRunJobSchema.parse(
    job.data,
  );
  const principal = serviceToken(shopDomain, "sale-campaign-run");
  const log = getLogger();
  const startedAt = Date.now();

  const run = await getRun(runId);
  if (!run || run.campaignId !== campaignId) {
    log.warn({ shop: shopDomain, campaignId, runId }, "Sale run not found");
    return;
  }
  if (
    run.status === "completed" ||
    run.status === "cancelled" ||
    run.status === "failed"
  ) {
    return;
  }
  await markRunRunning(runId, new Date());

  /*
   * A job killed mid-batch — a deploy, an expiry — leaves its claimed rows
   * in `applying` or `restoring`. Anything that has sat there longer than a
   * job may live belongs to nobody and goes back to be claimed again; the
   * live read on the retry finds what the dead job did or did not write.
   */
  const stale = await releaseStaleClaims(
    campaignId,
    new Date(Date.now() - STALE_CLAIM_MS),
  );
  if (stale.applying + stale.restoring > 0) {
    log.warn(
      { shop: shopDomain, campaignId, ...stale },
      "Stale sale claims released",
    );
  }

  const { admin } = await unauthenticated.admin(shopDomain);

  const restoring = run.kind === "restore" || run.kind === "release";
  const from = restoring ? "applied" : "pending";
  const to = restoring ? "restoring" : "applying";
  const marker = run.kind === "release" ? RELEASE_MARKER : null;

  for (;;) {
    const campaign = await getCampaign(principal, campaignId);
    if (!campaign) return;

    /*
     * An apply run only writes while the campaign is active and its end has
     * not come. A merchant who ended the campaign while the apply was still
     * going gets a restore run queued behind this one; the rows it never
     * reached stay `pending` and are released at settlement.
     */
    const now = new Date();
    if (
      !restoring &&
      (campaign.status !== "active" ||
        (campaign.endsAt !== null && campaign.endsAt <= now))
    ) {
      await finishRun(
        runId,
        "cancelled",
        now,
        "Campaign ended before every variant was applied",
      );
      return;
    }

    /*
     * Variants another campaign holds cannot be claimed (the one-owner index
     * would refuse the move). They are settled first: skipped, or taken
     * over by restoring the holder — after which they claim like any other.
     */
    if (!restoring) {
      const held = await listHeldPendingRows(principal, campaignId, BATCH);
      if (held.length > 0) {
        const resolved = await resolveHeldRows(
          admin,
          principal,
          campaign,
          held,
          now,
        );
        await advanceRun(runId, { done: resolved.skipped, failed: 0 });
      }
    }

    const rows = await claimVariantBatch(campaignId, from, to, BATCH, marker);
    if (rows.length === 0) break;

    const outcome = restoring
      ? await restoreRows(admin, principal, campaign, rows, now, {
          finalState: run.kind === "release" ? "released" : "restored",
          reason: run.kind === "release" ? RELEASE_MARKER : null,
        })
      : await applyRows(admin, principal, campaign, rows, now);

    await advanceRun(runId, outcome);
    log.info(
      { shop: shopDomain, campaignId, runId, kind: run.kind, ...outcome },
      "Sale campaign batch done",
    );

    if (Date.now() - startedAt > JOB_BUDGET_MS) {
      // Hand over rather than run into the job's expiry.
      await enqueue(
        QUEUES.saleCampaignRun,
        { shopDomain, campaignId, runId },
        { singletonKey: saleRunKey(campaignId) },
      );
      return;
    }
  }

  await settle(principal, campaignId, runId, run.kind);
}

/** After the last batch: say what happened, and move the campaign if the rows say so. */
async function settle(
  principal: ReturnType<typeof serviceToken>,
  campaignId: string,
  runId: string,
  kind: "apply" | "retry" | "restore" | "release",
): Promise<void> {
  const now = new Date();
  const campaign = await getCampaign(principal, campaignId);
  const counts = await countVariantStates(campaignId);
  const run = await getRun(runId);
  if (!campaign || !run) return;

  if (kind === "apply" || kind === "retry") {
    const failed = counts.failed ?? 0;
    await finishRun(runId, "completed", now);
    await recordCampaignEvent(
      principal,
      campaignId,
      "sale_campaign.apply_finished",
      {
        runId,
        counts,
      },
    );
    if (failed > 0) {
      await raiseException(principal, {
        kind: "sale_apply_failed",
        dedupeKey: `campaign:${campaignId}`,
        message: `${failed.toLocaleString("en")} of the variants in "${campaign.name}" could not be put on sale: ${counts.applied ?? 0} applied, ${failed} failed. Open the campaign to see Shopify's reason and retry them.`,
        detail: { campaignId, runId, counts },
      });
    }
    return;
  }

  if (kind === "release") {
    // Dynamic membership let some variants go; the campaign carries on.
    await finishRun(runId, "completed", now);
    await recordCampaignEvent(
      principal,
      campaignId,
      "sale_campaign.restore_finished",
      {
        runId,
        kind,
        counts,
      },
    );
    return;
  }

  // A restore (pause or end). Pending rows never reached are released now.
  await prisma.saleCampaignVariant.updateMany({
    where: { campaignId, state: "pending" },
    data: { state: "released", skipReason: "never_applied" },
  });
  const settled = await countVariantStates(campaignId);
  await finishRun(runId, "completed", now);
  await recordCampaignEvent(
    principal,
    campaignId,
    "sale_campaign.restore_finished",
    {
      runId,
      kind,
      counts: settled,
    },
  );

  if (!restoreComplete(settled)) {
    await raiseException(principal, {
      kind: "sale_restore_failed",
      dedupeKey: `campaign:${campaignId}`,
      message: `${(settled.restore_failed ?? 0).toLocaleString("en")} of the variants in "${campaign.name}" could not be put back to their original price. Open the campaign and retry the failed variants.`,
      detail: { campaignId, runId, counts: settled },
    });
    return;
  }

  // Ending (end now, or ends_at reached): the campaign is complete once
  // every row is accounted for. A pause keeps it paused.
  if (
    campaign.status === "active" &&
    campaign.endsAt !== null &&
    campaign.endsAt <= now
  ) {
    const moved = await transitionCampaign(
      principal,
      campaignId,
      "active",
      "completed",
      now,
    );
    if (moved) {
      await recordCampaignEvent(
        principal,
        campaignId,
        "sale_campaign.completed",
        {
          runId,
          counts: settled,
        },
      );
    }
  }
}
