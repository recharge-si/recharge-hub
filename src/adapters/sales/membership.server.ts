import { prisma } from "~/adapters/db/client.server";
import {
  createRun,
  listCampaignVariants,
  stageMembership,
  type Campaign,
} from "~/adapters/db/repositories/sale-campaign.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES, saleRunKey } from "~/adapters/queue/queues";
import { evaluateCampaign } from "~/adapters/sales/evaluate.server";
import { recordCampaignEvent } from "~/adapters/sales/events.server";
import type { CatalogueVariantFacts } from "~/domain/sales/types";
import type { Principal } from "~/domain/types";

/**
 * Dynamic membership (docs/sale-campaigns.md § Dynamic membership).
 *
 * Re-evaluates an active campaign's rules over part or all of the catalogue
 * and reconciles its rows: a variant that newly matches is staged and an
 * apply run queued; one that no longer matches is marked for release and a
 * release run queued, which restores it unless it is under review.
 *
 * The marker for "release this row" is `review_reason = 'no_longer_matches'`
 * on a row still in `applied`: the row keeps owning the variant until the
 * release run has actually put the price back.
 */

export const RELEASE_MARKER = "no_longer_matches";

export interface MembershipChange {
  added: number;
  released: number;
}

export async function reconcileDynamicMembership(
  principal: Principal,
  campaign: Campaign,
  facts: CatalogueVariantFacts[],
  scope: { productIds: readonly string[] } | "all",
  now: Date,
): Promise<MembershipChange> {
  if (campaign.status !== "active" || !campaign.dynamicMembership) {
    return { added: 0, released: 0 };
  }

  const evaluation = await evaluateCampaign(principal, campaign, { facts });
  const wanted = new Map(evaluation.final.map((f) => [f.variantId, f]));

  // Rows this campaign has for the scope in question.
  const rows = await listCampaignVariants(campaign.id, {
    ...(scope === "all" ? {} : { variantIds: facts.map((f) => f.variantId) }),
  });
  const inScopeProducts = scope === "all" ? null : new Set(scope.productIds);
  const relevant =
    inScopeProducts === null
      ? rows
      : rows.filter((row) => inScopeProducts.has(row.productId));

  // Newly matching: no row, or a row that has been settled and can be staged again.
  const have = new Map(relevant.map((row) => [row.variantId, row]));
  const additions = [...wanted.values()].filter((f) => {
    const row = have.get(f.variantId);
    return (
      !row ||
      row.state === "restored" ||
      row.state === "released" ||
      (row.state === "skipped" && row.skipReason === "no_longer_matches")
    );
  });

  // No longer matching: live rows for variants the rules no longer select.
  const releaseIds: string[] = [];
  const dropPendingIds: string[] = [];
  for (const row of relevant) {
    if (wanted.has(row.variantId)) continue;
    if (row.state === "applied" && row.reviewReason !== RELEASE_MARKER) {
      releaseIds.push(row.id);
    } else if (row.state === "pending") {
      dropPendingIds.push(row.id);
    }
  }

  let added = 0;
  if (additions.length > 0) {
    const { staged } = await stageMembership(
      principal,
      campaign.id,
      additions.map((f) => ({
        productId: f.productId,
        variantId: f.variantId,
        sku: f.sku,
        title: f.variantTitle
          ? `${f.productTitle} — ${f.variantTitle}`
          : f.productTitle,
      })),
      campaign.currency,
    );
    added = staged;
    if (staged > 0) {
      const run = await createRun(
        principal,
        campaign.id,
        "apply",
        staged,
        null,
      );
      await enqueue(
        QUEUES.saleCampaignRun,
        {
          shopDomain: principal.shopDomain,
          campaignId: campaign.id,
          runId: run.id,
        },
        { singletonKey: saleRunKey(campaign.id) },
      );
    }
  }

  if (dropPendingIds.length > 0) {
    await prisma.saleCampaignVariant.updateMany({
      where: { id: { in: dropPendingIds }, state: "pending" },
      data: { state: "released", skipReason: RELEASE_MARKER },
    });
  }

  if (releaseIds.length > 0) {
    await prisma.saleCampaignVariant.updateMany({
      where: { id: { in: releaseIds }, state: "applied" },
      data: { reviewReason: RELEASE_MARKER },
    });
    const run = await createRun(
      principal,
      campaign.id,
      "release",
      releaseIds.length,
      null,
    );
    await enqueue(
      QUEUES.saleCampaignRun,
      {
        shopDomain: principal.shopDomain,
        campaignId: campaign.id,
        runId: run.id,
      },
      { singletonKey: saleRunKey(campaign.id) },
    );
  }

  const released = releaseIds.length + dropPendingIds.length;
  if (added + released > 0) {
    await prisma.saleCampaign.update({
      where: { id: campaign.id },
      data: { evaluatedAt: now },
    });
    await recordCampaignEvent(
      principal,
      campaign.id,
      "sale_campaign.membership_changed",
      {
        added,
        released,
        scope: scope === "all" ? "catalogue" : scope.productIds,
      },
    );
  }

  return { added, released };
}
