import type { SaleCampaign } from "@prisma/client";

import { loadCatalogueFacts } from "~/adapters/db/repositories/catalogue.server";
import {
  listCampaigns,
  listLiveOwners,
  type Campaign,
} from "~/adapters/db/repositories/sale-campaign.server";
import {
  decideVariantPricing,
  effectiveDiscountBp,
  resolveConflict,
  windowsOverlap,
  type ConflictOutcome,
  type PricingDecision,
} from "~/domain/sales";
import { parseRuleGroup, selectVariants } from "~/domain/sales/rules";
import type {
  CatalogueVariantFacts,
  DiscountSpec,
  RoundingSpec,
} from "~/domain/sales/types";
import type { Principal } from "~/domain/types";

/**
 * A campaign's membership, worked out against the catalogue snapshot
 * (docs/sale-campaigns.md § Targeting and rule evaluation, § Conflicts).
 *
 * Read-only: the preview calls this and writes nothing; activation calls it
 * and then stages what it returns. The conflict answer here is informative —
 * the run resolves conflicts again against the ownership rows at the moment
 * it writes, which is the answer that counts.
 */

export function discountOf(campaign: Campaign): DiscountSpec {
  return { type: campaign.discountType, value: campaign.discountValue };
}

export function roundingOf(campaign: Campaign): RoundingSpec {
  return {
    mode: campaign.rounding,
    incrementMinor: campaign.roundingIncrementMinor,
  };
}

/** What the campaign would do to one variant, from the snapshot's prices. */
export function decideFromSnapshot(
  campaign: Campaign,
  facts: CatalogueVariantFacts,
): PricingDecision {
  return decideVariantPricing({
    live: {
      priceMinor: facts.priceMinor,
      compareAtMinor: facts.compareAtMinor,
    },
    policy: campaign.existingSalePolicy,
    discount: discountOf(campaign),
    rounding: roundingOf(campaign),
  });
}

export interface ActiveConflict {
  variantId: string;
  holderCampaignId: string;
  holderName: string;
  outcome: ConflictOutcome;
}

export interface ScheduledOverlap {
  campaignId: string;
  name: string;
  status: SaleCampaign["status"];
  variants: number;
}

export interface Evaluation {
  /** Every variant the include rules matched. */
  includedCount: number;
  /** Of those, removed by the exclusions. */
  excludedCount: number;
  /** The membership: facts per variant that is in. */
  final: CatalogueVariantFacts[];
  byVariant: Map<string, CatalogueVariantFacts>;
  productCount: number;
  /** Variants another campaign currently owns, with how the strategy resolves it. */
  activeConflicts: ActiveConflict[];
  /** Campaigns not yet applied whose rules and window overlap this one's. */
  scheduledOverlaps: ScheduledOverlap[];
}

function contender(campaign: Campaign, discountBp: number) {
  return {
    id: campaign.id,
    priority: campaign.priority,
    createdAtMs: campaign.createdAt.getTime(),
    discountBp,
  };
}

export async function evaluateCampaign(
  principal: Principal,
  campaign: Campaign,
  options: {
    productIds?: readonly string[];
    facts?: CatalogueVariantFacts[];
  } = {},
): Promise<Evaluation> {
  const facts =
    options.facts ??
    (await loadCatalogueFacts(principal, {
      ...(options.productIds ? { productIds: options.productIds } : {}),
    }));
  const byVariant = new Map(facts.map((f) => [f.variantId, f]));

  const selection = selectVariants(
    parseRuleGroup(campaign.includeRules),
    parseRuleGroup(campaign.excludeRules),
    facts,
  );
  const final = selection.final
    .map((id) => byVariant.get(id))
    .filter((f): f is CatalogueVariantFacts => f !== undefined);
  const finalIds = new Set(selection.final);
  const productCount = new Set(final.map((f) => f.productId)).size;

  /*
   * Conflicts with campaigns that hold variants now. The challenger's
   * discount is worked out from the holder's *original* pair — what the
   * variant would be restored to before this campaign snapshots it — so
   * "largest discount" compares like with like.
   */
  const owners = await listLiveOwners(principal, selection.final);
  const activeConflicts: ActiveConflict[] = [];
  for (const row of owners) {
    if (row.campaignId === campaign.id) continue;
    const original = {
      priceMinor: row.originalPriceMinor ?? row.lastObservedPriceMinor ?? 0,
      compareAtMinor: row.originalCompareAtMinor ?? null,
    };
    const ours = decideVariantPricing({
      live: original,
      policy: campaign.existingSalePolicy,
      discount: discountOf(campaign),
      rounding: roundingOf(campaign),
    });
    const ourBp =
      ours.kind === "apply"
        ? effectiveDiscountBp(ours.baseMinor, ours.salePriceMinor)
        : 0;
    const theirBp =
      row.basePriceMinor !== null && row.salePriceMinor !== null
        ? effectiveDiscountBp(row.basePriceMinor, row.salePriceMinor)
        : 0;
    activeConflicts.push({
      variantId: row.variantId,
      holderCampaignId: row.campaignId,
      holderName: row.campaign.name,
      outcome: resolveConflict(
        campaign.conflictStrategy,
        contender(campaign, ourBp),
        contender(row.campaign, theirBp),
      ),
    });
  }

  /*
   * Overlaps with campaigns that have not applied yet (scheduled, or active
   * but not holding these variants — a dynamic campaign that will pick them
   * up). Their rules are evaluated over the same snapshot; the intersection
   * is the warning.
   */
  const scheduledOverlaps: ScheduledOverlap[] = [];
  if (final.length > 0) {
    const others = (await listCampaigns(principal)).filter(
      (other) =>
        other.id !== campaign.id &&
        (other.status === "scheduled" || other.status === "active") &&
        windowsOverlap(
          {
            startsAt: campaign.startsAt?.getTime() ?? null,
            endsAt: campaign.endsAt?.getTime() ?? null,
          },
          {
            startsAt: other.startsAt?.getTime() ?? null,
            endsAt: other.endsAt?.getTime() ?? null,
          },
        ),
    );
    const owned = new Set(
      owners
        .filter((row) => row.campaignId !== campaign.id)
        .map((row) => `${row.campaignId}:${row.variantId}`),
    );
    for (const other of others) {
      const theirs = selectVariants(
        parseRuleGroup(other.includeRules),
        parseRuleGroup(other.excludeRules),
        facts,
      );
      const shared = theirs.final.filter(
        (id) => finalIds.has(id) && !owned.has(`${other.id}:${id}`),
      ).length;
      if (shared > 0) {
        scheduledOverlaps.push({
          campaignId: other.id,
          name: other.name,
          status: other.status,
          variants: shared,
        });
      }
    }
  }

  return {
    includedCount: selection.included.length,
    excludedCount: selection.excluded.length,
    final,
    byVariant,
    productCount,
    activeConflicts,
    scheduledOverlaps,
  };
}
