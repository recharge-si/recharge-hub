import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { resolveExceptionByKey } from "~/adapters/db/repositories/exception.server";
import {
  getCampaign,
  listCampaignVariants,
  recordVariantOutcome,
} from "~/adapters/db/repositories/sale-campaign.server";
import { recordVariantEvent } from "~/adapters/sales/events.server";
import type { LifecycleResult } from "~/adapters/sales/lifecycle.server";
import { forceRestoreRows } from "~/adapters/sales/writer.server";
import type { Principal } from "~/domain/types";

/**
 * Deciding every review row of a campaign at once (docs/sale-campaigns.md
 * § External base-price change).
 *
 * A row goes to review because its price was changed outside the campaign
 * and the policy said to ask. One row is a question worth reading; fifty on
 * a campaign that has already ended are not — the sale is over and there
 * are two honest answers left: put the recorded original back, or leave the
 * variant at the price somebody else gave it. Both are what the variants
 * page offers per row, applied to all of them, with each row's exception
 * resolved as it is decided.
 */
export async function resolveAllReviewRows(
  admin: AdminApiContext,
  principal: Principal,
  campaignId: string,
  how: "restore" | "release",
  options: { now: Date; requestedBy: string | null },
): Promise<LifecycleResult> {
  const campaign = await getCampaign(principal, campaignId);
  if (!campaign) return { ok: false, message: "Campaign not found." };
  const rows = await listCampaignVariants(campaign.id, { states: ["review"] });
  if (rows.length === 0)
    return { ok: false, message: "No variant is waiting for a decision." };

  const by = options.requestedBy ?? "merchant";
  const resolve = (variantId: string) =>
    resolveExceptionByKey(
      principal,
      "sale_price_conflict",
      `variant:${variantId}`,
      by,
      options.now,
    );

  if (how === "release") {
    for (const row of rows) {
      await recordVariantOutcome(row.id, {
        state: "released",
        reviewReason: null,
        skipReason: "external_change",
        now: options.now,
      });
      await recordVariantEvent(
        principal,
        row.variantId,
        "sale_variant.review_resolved",
        { campaignId: campaign.id, how: "release", by: options.requestedBy },
      );
      await resolve(row.variantId);
    }
    return {
      ok: true,
      message: `${rows.length.toLocaleString("en")} variants left at their new price.`,
    };
  }

  const outcome = await forceRestoreRows(
    admin,
    principal,
    campaign,
    rows,
    options.now,
  );
  // Only a row that is no longer under review has had its question answered.
  const settled = await listCampaignVariants(campaign.id, {
    variantIds: rows.map((row) => row.variantId),
  });
  for (const row of settled) {
    if (row.state !== "review" && row.state !== "restore_failed")
      await resolve(row.variantId);
  }
  if (outcome.failed > 0) {
    return {
      ok: false,
      message: `${outcome.done.toLocaleString("en")} put back; Shopify rejected ${outcome.failed.toLocaleString("en")}. The variants page shows each reason.`,
    };
  }
  return {
    ok: true,
    message: `${outcome.done.toLocaleString("en")} original prices put back.`,
  };
}
