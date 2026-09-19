import type { Job } from "pg-boss";

import { raiseException } from "~/adapters/db/repositories/exception.server";
import { listDueCampaigns } from "~/adapters/db/repositories/sale-campaign.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { captureException } from "~/adapters/observability/sentry.server";
import {
  activateCampaign,
  settleEnding,
  unscheduleCampaign,
} from "~/adapters/sales/lifecycle.server";
import { serviceToken } from "~/domain/types";

/**
 * The clock for sale campaigns (docs/sale-campaigns.md § Scheduler and
 * jobs). Runs every minute from the worker's cron.
 *
 * One query finds what is due — scheduled campaigns whose start has come,
 * active ones whose end has — and each is moved through the same lifecycle
 * code a merchant's button uses, so "activated by the scheduler" and
 * "activated by hand" cannot mean two different things. Every transition is
 * conditional, so a tick that overlaps the previous one, or a person, does
 * nothing twice.
 *
 * Each campaign is isolated: one failing to activate is reported and the
 * rest still move.
 */
export async function handleSaleCampaignScheduler(
  _job: Job<unknown>,
): Promise<void> {
  const log = getLogger();
  const now = new Date();
  const due = await listDueCampaigns(now);

  let failed = 0;
  for (const campaign of due) {
    const principal = serviceToken(
      campaign.shopDomain,
      "sale-campaign-scheduler",
    );
    try {
      if (campaign.status === "scheduled") {
        const result = await activateCampaign(principal, campaign.id, {
          now,
          requestedBy: "schedule",
        });
        if (!result.ok) {
          /*
           * The scheduled moment came and the campaign could not start: no
           * matches, a conflict the strategy refuses. Left scheduled it
           * would be tried again every minute for ever, so it goes back to
           * draft and the reason is said where the merchant looks.
           */
          await unscheduleCampaign(principal, campaign.id, now);
          await raiseException(principal, {
            kind: "sale_apply_failed",
            dedupeKey: `campaign:${campaign.id}`,
            message: `The scheduled campaign could not start and is back in draft: ${result.message}`,
            detail: { campaignId: campaign.id },
          });
          log.warn(
            {
              shop: campaign.shopDomain,
              campaignId: campaign.id,
              reason: result.message,
            },
            "Scheduled sale campaign could not start",
          );
        }
      } else {
        await settleEnding(principal, campaign.id, now);
      }
    } catch (error) {
      failed += 1;
      log.error(
        { err: error, shop: campaign.shopDomain, campaignId: campaign.id },
        "Sale campaign scheduler could not move a campaign",
      );
      captureException(error, {
        shop: campaign.shopDomain,
        campaignId: campaign.id,
      });
    }
  }

  if (due.length > 0) {
    log.info({ due: due.length, failed }, "Sale campaign scheduler ran");
  }
}
