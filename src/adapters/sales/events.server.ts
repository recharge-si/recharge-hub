import type { Prisma } from "@prisma/client";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import type { Principal } from "~/domain/types";

/**
 * The sale campaign audit trail (docs/sale-campaigns.md § Audit log), on the
 * existing append-only `event_log`. Campaign events carry the campaign as the
 * entity; variant events carry the variant, with the campaign in the detail,
 * so a product page can ask "what happened to this variant" and a campaign
 * page "what did this campaign do".
 */

export type SaleCampaignEvent =
  | "sale_campaign.created"
  | "sale_campaign.edited"
  | "sale_campaign.scheduled"
  | "sale_campaign.unscheduled"
  | "sale_campaign.activated"
  | "sale_campaign.paused"
  | "sale_campaign.resumed"
  | "sale_campaign.ending"
  | "sale_campaign.completed"
  | "sale_campaign.cancelled"
  | "sale_campaign.restore_requested"
  | "sale_campaign.retry_requested"
  | "sale_campaign.conflict_detected"
  | "sale_campaign.apply_finished"
  | "sale_campaign.restore_finished"
  | "sale_campaign.membership_changed";

export type SaleVariantEvent =
  | "sale_variant.price_changed"
  | "sale_variant.restored"
  | "sale_variant.apply_failed"
  | "sale_variant.restore_failed"
  | "sale_variant.skipped"
  | "sale_variant.external_change_detected"
  | "sale_variant.review_resolved"
  | "sale_variant.released";

export async function recordCampaignEvent(
  principal: Principal,
  campaignId: string,
  event: SaleCampaignEvent,
  detail?: object,
): Promise<void> {
  await appendEvent(principal, {
    entityType: "sale_campaign",
    entityId: campaignId,
    event,
    ...(detail === undefined ? {} : { detail: asJson(detail) }),
  });
}

/** Plain data — pairs, reasons, ids — as the JSON column takes it. */
function asJson(detail: object): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(detail)) as Prisma.InputJsonValue;
}

export async function recordVariantEvent(
  principal: Principal,
  variantId: string,
  event: SaleVariantEvent,
  detail: { campaignId: string; [key: string]: unknown },
): Promise<void> {
  await appendEvent(principal, {
    entityType: "sale_variant",
    entityId: variantId,
    event,
    detail: asJson(detail),
  });
}
