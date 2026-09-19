import type { ReadinessComponent, ReadinessKey } from "~/domain/readiness";
import type { CampaignStatus, VariantState } from "~/domain/sales/types";

/**
 * What the home page shows, decided from what the merchant has switched on
 * (docs/BUILD_SPEC.md § 2.7, docs/ui-conventions.md § Setup state).
 *
 * The page used to show every module's numbers whatever the configuration:
 * an orders chart, "Sent to MetaKocka 0" and "Orders last checked 15 min
 * ago" on a shop that had switched order transfer off. Nothing there was
 * false; all of it was noise. So each module's figures, chart and timestamp
 * appear only while readiness says that module is on — and readiness is the
 * one place that decides what "on" means.
 */

export type HomeModule = "orders" | "payments" | "stock" | "products";

/** Modules whose figures belong on the page: on, or needing a person. */
export function modulesOn(components: ReadinessComponent[]): Set<HomeModule> {
  const on = new Set<HomeModule>();
  const status = (key: ReadinessKey) =>
    components.find((component) => component.key === key)?.status ?? null;
  if (status("orders") !== null && status("orders") !== "disabled")
    on.add("orders");
  // A payment is recorded on a sales order, so payments need orders.
  if (
    on.has("orders") &&
    status("payments") !== null &&
    status("payments") !== "disabled"
  )
    on.add("payments");
  if (status("stock") !== null && status("stock") !== "disabled")
    on.add("stock");
  if (status("products") !== null) on.add("products");
  return on;
}

export interface CampaignFacts {
  id: string;
  name: string;
  status: CampaignStatus;
  discount: string;
  startsAt: string | null;
  endsAt: string | null;
  counts: Partial<Record<VariantState, number>>;
}

export interface SalesOverview {
  /** Live campaigns, most variants on sale first. */
  active: Array<{
    id: string;
    name: string;
    discount: string;
    onSale: number;
    endsAt: string | null;
  }>;
  /** The next campaign due to start, if any. */
  next: { id: string; name: string; discount: string; startsAt: string } | null;
  /** Variants currently at a sale price, across every live campaign. */
  onSale: number;
  /** Variants waiting for a person, across every campaign. */
  needsDecision: number;
  failed: number;
  total: number;
}

/** Sale campaigns as the home page states them: what is live, what is next. */
export function salesOverview(campaigns: CampaignFacts[]): SalesOverview {
  const active = campaigns
    .filter((campaign) => campaign.status === "active")
    .map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      discount: campaign.discount,
      onSale: (campaign.counts.applied ?? 0) + (campaign.counts.applying ?? 0),
      endsAt: campaign.endsAt,
    }))
    .sort((a, b) => b.onSale - a.onSale || a.name.localeCompare(b.name));

  const scheduled = campaigns
    .filter(
      (campaign): campaign is CampaignFacts & { startsAt: string } =>
        campaign.status === "scheduled" && campaign.startsAt !== null,
    )
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const first = scheduled[0];

  let needsDecision = 0;
  let failed = 0;
  for (const campaign of campaigns) {
    needsDecision += campaign.counts.review ?? 0;
    failed +=
      (campaign.counts.failed ?? 0) + (campaign.counts.restore_failed ?? 0);
  }

  return {
    active,
    next: first
      ? {
          id: first.id,
          name: first.name,
          discount: first.discount,
          startsAt: first.startsAt,
        }
      : null,
    onSale: active.reduce((sum, campaign) => sum + campaign.onSale, 0),
    needsDecision,
    failed,
    total: campaigns.length,
  };
}

/** How long ago, in the words a person would use. */
export function ago(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "never";
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
