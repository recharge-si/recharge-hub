import {
  Prisma,
  type SaleCampaign,
  type SaleCampaignVariant,
  type SaleRun,
  type SaleRunKind,
  type SaleVariantState,
} from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import type { RuleGroup } from "~/domain/sales/rules";
import {
  LIVE_STATES,
  type BasePriceChangePolicy,
  type CampaignStatus,
  type ConflictStrategy,
  type DiscountType,
  type ExistingSalePolicy,
  type PricePair,
  type RoundingMode,
} from "~/domain/sales/types";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * Sale campaigns, their snapshots and their runs
 * (docs/sale-campaigns.md § Data model).
 *
 * Every read and write is scoped to the principal's shop. Two things here
 * are safety boundaries rather than plumbing:
 *
 *  - `transitionCampaign` is a conditional update on the current status, so
 *    a scheduler racing a person produces one transition.
 *  - `claimVariantBatch` moves rows between states with `FOR UPDATE SKIP
 *    LOCKED`, so two workers never write the same variant, and the partial
 *    unique index on live states means two campaigns never own one.
 */

async function shopIdFor(principal: Principal): Promise<string> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: { id: true },
  });
  if (!shop) throw new Error(`Unknown shop ${shopDomainOf(principal)}`);
  return shop.id;
}

/* -------------------------------------------------------------------------- */
/* Campaigns                                                                  */
/* -------------------------------------------------------------------------- */

export interface CampaignInput {
  name: string;
  notes: string | null;
  discountType: DiscountType;
  discountValue: number;
  currency: string;
  rounding: RoundingMode;
  roundingIncrementMinor: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  priority: number;
  existingSalePolicy: ExistingSalePolicy;
  conflictStrategy: ConflictStrategy;
  basePriceChangePolicy: BasePriceChangePolicy;
  dynamicMembership: boolean;
  includeRules: RuleGroup;
  excludeRules: RuleGroup;
}

export type Campaign = SaleCampaign;

export async function createCampaign(
  principal: Principal,
  input: Partial<CampaignInput> & { name: string; currency: string },
  createdBy: string | null,
): Promise<Campaign> {
  const shopId = await shopIdFor(principal);
  return prisma.saleCampaign.create({
    data: {
      shopId,
      name: input.name,
      notes: input.notes ?? null,
      discountType: input.discountType ?? "percentage",
      discountValue: input.discountValue ?? 1000,
      currency: input.currency,
      rounding: input.rounding ?? "none",
      roundingIncrementMinor: input.roundingIncrementMinor ?? null,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      priority: input.priority ?? 0,
      existingSalePolicy: input.existingSalePolicy ?? "skip",
      conflictStrategy: input.conflictStrategy ?? "prevent",
      basePriceChangePolicy: input.basePriceChangePolicy ?? "review",
      dynamicMembership: input.dynamicMembership ?? false,
      includeRules: (input.includeRules ?? {
        kind: "group",
        op: "and",
        rules: [],
      }) as unknown as Prisma.InputJsonValue,
      excludeRules: (input.excludeRules ?? {
        kind: "group",
        op: "or",
        rules: [],
      }) as unknown as Prisma.InputJsonValue,
      createdBy,
    },
  });
}

export async function updateCampaign(
  principal: Principal,
  id: string,
  patch: Partial<CampaignInput>,
): Promise<Campaign | null> {
  const shopId = await shopIdFor(principal);
  const { includeRules, excludeRules, ...rest } = patch;
  const { count } = await prisma.saleCampaign.updateMany({
    where: { id, shopId },
    data: {
      ...rest,
      ...(includeRules
        ? { includeRules: includeRules as unknown as Prisma.InputJsonValue }
        : {}),
      ...(excludeRules
        ? { excludeRules: excludeRules as unknown as Prisma.InputJsonValue }
        : {}),
    },
  });
  if (count === 0) return null;
  return prisma.saleCampaign.findUnique({ where: { id } });
}

export async function getCampaign(
  principal: Principal,
  id: string,
): Promise<Campaign | null> {
  const shopId = await shopIdFor(principal);
  return prisma.saleCampaign.findFirst({ where: { id, shopId } });
}

export async function listCampaigns(principal: Principal): Promise<Campaign[]> {
  const shopId = await shopIdFor(principal);
  return prisma.saleCampaign.findMany({
    where: { shopId },
    orderBy: [{ createdAt: "desc" }],
  });
}

/** Only a draft with no snapshot rows may be deleted; everything else is history. */
export async function deleteDraftCampaign(
  principal: Principal,
  id: string,
): Promise<boolean> {
  const shopId = await shopIdFor(principal);
  const { count } = await prisma.saleCampaign.deleteMany({
    where: { id, shopId, status: "draft", variants: { none: {} } },
  });
  return count > 0;
}

/**
 * One transition, or none. The `from` status is part of the predicate, so a
 * second click, a redelivered job or a scheduler racing a person finds the
 * row already moved and changes nothing.
 */
export async function transitionCampaign(
  principal: Principal,
  id: string,
  from: CampaignStatus,
  to: CampaignStatus,
  now: Date,
): Promise<boolean> {
  const shopId = await shopIdFor(principal);
  const stamps: Prisma.SaleCampaignUpdateManyMutationInput = {};
  if (to === "active") {
    stamps.activatedAt = now;
    stamps.pausedAt = null;
  }
  if (to === "paused") stamps.pausedAt = now;
  if (to === "completed") stamps.completedAt = now;
  if (to === "cancelled") stamps.cancelledAt = now;

  const { count } = await prisma.saleCampaign.updateMany({
    where: { id, shopId, status: from },
    data: { status: to, ...stamps },
  });
  return count > 0;
}

export interface DueCampaign {
  id: string;
  shopDomain: string;
  status: CampaignStatus;
}

/**
 * What the scheduler has to move: scheduled campaigns whose start has come,
 * and active campaigns whose end has. Across every shop — the scheduler is
 * one job for the whole worker — but each result names its shop so the
 * work it enqueues is tenant-scoped.
 */
export async function listDueCampaigns(now: Date): Promise<DueCampaign[]> {
  const rows = await prisma.saleCampaign.findMany({
    where: {
      shop: { uninstalledAt: null, installState: "installed" },
      OR: [
        { status: "scheduled", startsAt: { lte: now } },
        { status: "active", endsAt: { lte: now } },
      ],
    },
    select: { id: true, status: true, shop: { select: { domain: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    shopDomain: row.shop.domain,
  }));
}

/** Active campaigns with dynamic membership on, for re-evaluation. */
export async function listDynamicActiveCampaigns(
  principal: Principal,
): Promise<Campaign[]> {
  const shopId = await shopIdFor(principal);
  return prisma.saleCampaign.findMany({
    where: { shopId, status: "active", dynamicMembership: true },
  });
}

/* -------------------------------------------------------------------------- */
/* Variants: the snapshot                                                     */
/* -------------------------------------------------------------------------- */

export type CampaignVariant = SaleCampaignVariant;

export interface MembershipEntry {
  productId: string;
  variantId: string;
  sku: string | null;
  title: string | null;
}

/**
 * Makes the campaign's membership these variants, as `pending` rows ready
 * to be applied.
 *
 * A row that already exists in a settled state — restored after a pause,
 * released, skipped last time — is put back to `pending` with its snapshot
 * cleared, because the next apply takes a fresh one from what Shopify then
 * holds. A row in a live state is left exactly as it is: it already owns the
 * variant and re-reading its original would lose the true one.
 */
export async function stageMembership(
  principal: Principal,
  campaignId: string,
  entries: readonly MembershipEntry[],
  currency: string,
): Promise<{ staged: number; kept: number }> {
  const shopId = await shopIdFor(principal);
  const existing = await prisma.saleCampaignVariant.findMany({
    where: { campaignId, shopId },
    select: { id: true, variantId: true, state: true },
  });
  const byVariant = new Map(existing.map((row) => [row.variantId, row]));
  const live = new Set<SaleVariantState>(LIVE_STATES);

  const inserts: Prisma.SaleCampaignVariantCreateManyInput[] = [];
  const resets: string[] = [];
  let kept = 0;

  for (const entry of entries) {
    const row = byVariant.get(entry.variantId);
    if (!row) {
      inserts.push({
        shopId,
        campaignId,
        productId: entry.productId,
        variantId: entry.variantId,
        sku: entry.sku,
        title: entry.title,
        currency,
        state: "pending",
      });
    } else if (live.has(row.state) || row.state === "pending") {
      kept += 1;
    } else {
      resets.push(row.id);
    }
  }

  await prisma.$transaction(async (tx) => {
    for (let start = 0; start < inserts.length; start += 1000) {
      await tx.saleCampaignVariant.createMany({
        data: inserts.slice(start, start + 1000),
      });
    }
    if (resets.length > 0) {
      await tx.saleCampaignVariant.updateMany({
        where: { id: { in: resets } },
        data: {
          state: "pending",
          originalPriceMinor: null,
          originalCompareAtMinor: null,
          basePriceMinor: null,
          salePriceMinor: null,
          saleCompareAtMinor: null,
          skipReason: null,
          reviewReason: null,
          lastError: null,
          attempts: 0,
          snapshotCreatedAt: null,
          restoredAt: null,
        },
      });
    }
  });

  return { staged: inserts.length + resets.length, kept };
}

export async function countVariantStates(
  campaignId: string,
): Promise<Partial<Record<SaleVariantState, number>>> {
  const groups = await prisma.saleCampaignVariant.groupBy({
    by: ["state"],
    where: { campaignId },
    _count: { _all: true },
  });
  const counts: Partial<Record<SaleVariantState, number>> = {};
  for (const group of groups) counts[group.state] = group._count._all;
  return counts;
}

/** Counts for many campaigns at once, for the index page. */
export async function countVariantStatesFor(
  campaignIds: readonly string[],
): Promise<Map<string, Partial<Record<SaleVariantState, number>>>> {
  if (campaignIds.length === 0) return new Map();
  const groups = await prisma.saleCampaignVariant.groupBy({
    by: ["campaignId", "state"],
    where: { campaignId: { in: [...campaignIds] } },
    _count: { _all: true },
  });
  const map = new Map<string, Partial<Record<SaleVariantState, number>>>();
  for (const group of groups) {
    const counts = map.get(group.campaignId) ?? {};
    counts[group.state] = group._count._all;
    map.set(group.campaignId, counts);
  }
  return map;
}

const LIVE_STATE_LIST = Prisma.join(
  LIVE_STATES.map((state) => Prisma.sql`${state}::"sale_variant_state"`),
);

/**
 * Claims up to `limit` rows in `from`, moving them to `to`, and returns them.
 *
 * `FOR UPDATE SKIP LOCKED` is what lets two workers run one campaign without
 * fighting: each takes rows the other has not locked. The claim and the
 * state change are one statement, so a worker that dies holding a claim
 * leaves rows in `to` — which `releaseStaleClaims` notices and puts back
 * once the lease has passed.
 *
 * A `pending` row whose variant another campaign holds live is **not**
 * claimable: moving it to `applying` would collide with the one-owner index.
 * Those rows wait for `listHeldPendingRows` and the conflict step, which
 * either releases the holder or skips the row.
 */
export async function claimVariantBatch(
  campaignId: string,
  from: SaleVariantState,
  to: SaleVariantState,
  limit: number,
  /** Only rows carrying this `review_reason`: how a release run finds its rows. */
  marker: string | null = null,
): Promise<CampaignVariant[]> {
  const markerClause =
    marker === null
      ? Prisma.empty
      : Prisma.sql`AND "review_reason" = ${marker}`;
  const unheldClause =
    from === "pending"
      ? Prisma.sql`AND NOT EXISTS (
          SELECT 1 FROM "sale_campaign_variant" o
          WHERE o."shop_id" = v."shop_id" AND o."variant_id" = v."variant_id"
            AND o."campaign_id" <> v."campaign_id"
            AND o."state" IN (${LIVE_STATE_LIST})
        )`
      : Prisma.empty;
  const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "sale_campaign_variant"
    SET "state" = ${to}::"sale_variant_state", "updated_at" = NOW()
    WHERE "id" IN (
      SELECT v."id" FROM "sale_campaign_variant" v
      WHERE v."campaign_id" = ${campaignId} AND v."state" = ${from}::"sale_variant_state" ${markerClause} ${unheldClause}
      ORDER BY v."product_id", v."id"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id"
  `;
  if (claimed.length === 0) return [];
  return prisma.saleCampaignVariant.findMany({
    where: { id: { in: claimed.map((row) => row.id) } },
    orderBy: [{ productId: "asc" }, { id: "asc" }],
  });
}

/**
 * This campaign's `pending` rows whose variant another campaign holds live,
 * each with that holder's row and campaign, so the run can resolve the
 * conflict before claiming.
 */
export async function listHeldPendingRows(
  principal: Principal,
  campaignId: string,
  limit: number,
): Promise<
  Array<{
    row: CampaignVariant;
    holder: CampaignVariant & { campaign: Campaign };
  }>
> {
  const shopId = await shopIdFor(principal);
  const held = await prisma.$queryRaw<Array<{ id: string; holder_id: string }>>`
    SELECT v."id", o."id" AS holder_id
    FROM "sale_campaign_variant" v
    JOIN "sale_campaign_variant" o
      ON o."shop_id" = v."shop_id" AND o."variant_id" = v."variant_id"
     AND o."campaign_id" <> v."campaign_id"
     AND o."state" IN (${LIVE_STATE_LIST})
    WHERE v."shop_id" = ${shopId} AND v."campaign_id" = ${campaignId}
      AND v."state" = 'pending'::"sale_variant_state"
    ORDER BY v."product_id", v."id"
    LIMIT ${limit}
  `;
  if (held.length === 0) return [];
  const [rows, holders] = await Promise.all([
    prisma.saleCampaignVariant.findMany({
      where: { id: { in: held.map((h) => h.id) } },
    }),
    prisma.saleCampaignVariant.findMany({
      where: { id: { in: held.map((h) => h.holder_id) } },
      include: { campaign: true },
    }),
  ]);
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const holderById = new Map(holders.map((row) => [row.id, row]));
  const result: Array<{
    row: CampaignVariant;
    holder: CampaignVariant & { campaign: Campaign };
  }> = [];
  for (const pair of held) {
    const row = rowById.get(pair.id);
    const holder = holderById.get(pair.holder_id);
    if (row && holder) result.push({ row, holder });
  }
  return result;
}

/**
 * Rows a crashed job left mid-flight, put back where they were.
 *
 * Only rows untouched for longer than a job is allowed to live: a row in
 * `applying` for two minutes belongs to a job that is still working it, and
 * two jobs may legitimately overlap on one campaign for a moment.
 */
export async function releaseStaleClaims(
  campaignId: string,
  olderThan: Date,
): Promise<{ applying: number; restoring: number }> {
  const [applying, restoring] = await prisma.$transaction([
    prisma.saleCampaignVariant.updateMany({
      where: { campaignId, state: "applying", updatedAt: { lt: olderThan } },
      data: { state: "pending" },
    }),
    prisma.saleCampaignVariant.updateMany({
      where: { campaignId, state: "restoring", updatedAt: { lt: olderThan } },
      data: { state: "applied" },
    }),
  ]);
  return { applying: applying.count, restoring: restoring.count };
}

export interface VariantOutcome {
  state: SaleVariantState;
  original?: PricePair;
  baseMinor?: number | null;
  sale?: PricePair;
  skipReason?: string | null;
  reviewReason?: string | null;
  lastError?: string | null;
  observed?: PricePair;
  snapshotCreatedAt?: Date;
  lastAppliedAt?: Date;
  restoredAt?: Date;
  bumpAttempts?: boolean;
  now: Date;
}

/** Records what happened to one row. */
export async function recordVariantOutcome(
  id: string,
  outcome: VariantOutcome,
): Promise<void> {
  await prisma.saleCampaignVariant.update({
    where: { id },
    data: {
      state: outcome.state,
      ...(outcome.original
        ? {
            originalPriceMinor: outcome.original.priceMinor,
            originalCompareAtMinor: outcome.original.compareAtMinor,
          }
        : {}),
      ...(outcome.baseMinor !== undefined
        ? { basePriceMinor: outcome.baseMinor }
        : {}),
      ...(outcome.sale
        ? {
            salePriceMinor: outcome.sale.priceMinor,
            saleCompareAtMinor: outcome.sale.compareAtMinor,
          }
        : {}),
      ...(outcome.skipReason !== undefined
        ? { skipReason: outcome.skipReason }
        : {}),
      ...(outcome.reviewReason !== undefined
        ? { reviewReason: outcome.reviewReason }
        : {}),
      ...(outcome.lastError !== undefined
        ? { lastError: outcome.lastError }
        : {}),
      ...(outcome.observed
        ? {
            lastObservedPriceMinor: outcome.observed.priceMinor,
            lastObservedCompareAtMinor: outcome.observed.compareAtMinor,
            lastObservedAt: outcome.now,
          }
        : {}),
      ...(outcome.snapshotCreatedAt
        ? { snapshotCreatedAt: outcome.snapshotCreatedAt }
        : {}),
      ...(outcome.lastAppliedAt
        ? { lastAppliedAt: outcome.lastAppliedAt }
        : {}),
      ...(outcome.restoredAt ? { restoredAt: outcome.restoredAt } : {}),
      ...(outcome.bumpAttempts ? { attempts: { increment: 1 } } : {}),
    },
  });
}

/** The live owner of each of these variants, if any, with its campaign. */
export async function listLiveOwners(
  principal: Principal,
  variantIds: readonly string[],
): Promise<Array<CampaignVariant & { campaign: Campaign }>> {
  if (variantIds.length === 0) return [];
  const shopId = await shopIdFor(principal);
  const rows: Array<CampaignVariant & { campaign: Campaign }> = [];
  for (let start = 0; start < variantIds.length; start += 5000) {
    rows.push(
      ...(await prisma.saleCampaignVariant.findMany({
        where: {
          shopId,
          variantId: { in: variantIds.slice(start, start + 5000) },
          state: { in: [...LIVE_STATES] },
        },
        include: { campaign: true },
      })),
    );
  }
  return rows;
}

/** Live rows of one campaign, by variant id. */
export async function listCampaignVariants(
  campaignId: string,
  filter: {
    states?: readonly SaleVariantState[];
    variantIds?: readonly string[];
  } = {},
): Promise<CampaignVariant[]> {
  return prisma.saleCampaignVariant.findMany({
    where: {
      campaignId,
      ...(filter.states ? { state: { in: [...filter.states] } } : {}),
      ...(filter.variantIds
        ? { variantId: { in: [...filter.variantIds] } }
        : {}),
    },
    orderBy: [{ productId: "asc" }, { id: "asc" }],
  });
}

export async function listVariantPage(
  campaignId: string,
  options: { state?: SaleVariantState; take: number; skip: number },
): Promise<{ rows: CampaignVariant[]; total: number }> {
  const where = {
    campaignId,
    ...(options.state ? { state: options.state } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.saleCampaignVariant.findMany({
      where,
      orderBy: [{ title: "asc" }, { productId: "asc" }, { id: "asc" }],
      take: options.take,
      skip: options.skip,
    }),
    prisma.saleCampaignVariant.count({ where }),
  ]);
  return { rows, total };
}

/** `failed` → `pending`, `restore_failed` → `applied`: what Retry failed does. */
export async function resetFailedVariants(
  campaignId: string,
): Promise<{ toApply: number; toRestore: number }> {
  const [apply, restore] = await prisma.$transaction([
    prisma.saleCampaignVariant.updateMany({
      where: { campaignId, state: "failed" },
      data: { state: "pending", lastError: null },
    }),
    prisma.saleCampaignVariant.updateMany({
      where: { campaignId, state: "restore_failed" },
      data: { state: "applied", lastError: null },
    }),
  ]);
  return { toApply: apply.count, toRestore: restore.count };
}

/** What a product's variants are doing right now, for the product page. */
export async function listLiveVariantsForProduct(
  principal: Principal,
  productId: string,
): Promise<Array<CampaignVariant & { campaign: Campaign }>> {
  const shopId = await shopIdFor(principal);
  return prisma.saleCampaignVariant.findMany({
    where: { shopId, productId, state: { in: [...LIVE_STATES] } },
    include: { campaign: true },
  });
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

export type Run = SaleRun;

export async function createRun(
  principal: Principal,
  campaignId: string,
  kind: SaleRunKind,
  total: number,
  requestedBy: string | null,
): Promise<Run> {
  const shopId = await shopIdFor(principal);
  return prisma.saleRun.create({
    data: { shopId, campaignId, kind, total, requestedBy, status: "queued" },
  });
}

export async function getRun(id: string): Promise<Run | null> {
  return prisma.saleRun.findUnique({ where: { id } });
}

export async function markRunRunning(id: string, now: Date): Promise<void> {
  await prisma.saleRun.updateMany({
    where: { id, status: "queued" },
    data: { status: "running", startedAt: now },
  });
}

export async function advanceRun(
  id: string,
  delta: { done: number; failed: number },
): Promise<void> {
  await prisma.saleRun.update({
    where: { id },
    data: {
      done: { increment: delta.done },
      failed: { increment: delta.failed },
    },
  });
}

export async function finishRun(
  id: string,
  status: "completed" | "failed" | "cancelled",
  now: Date,
  lastError: string | null = null,
): Promise<void> {
  await prisma.saleRun.update({
    where: { id },
    data: { status, finishedAt: now, lastError },
  });
}

/** The run a campaign page shows: the one in progress, else the latest. */
export async function latestRun(campaignId: string): Promise<Run | null> {
  const inProgress = await prisma.saleRun.findFirst({
    where: { campaignId, status: { in: ["queued", "running"] } },
    orderBy: { createdAt: "desc" },
  });
  if (inProgress) return inProgress;
  return prisma.saleRun.findFirst({
    where: { campaignId },
    orderBy: { createdAt: "desc" },
  });
}

export async function latestRunsFor(
  campaignIds: readonly string[],
): Promise<Map<string, Run>> {
  if (campaignIds.length === 0) return new Map();
  const runs = await prisma.saleRun.findMany({
    where: { campaignId: { in: [...campaignIds] } },
    orderBy: { createdAt: "desc" },
  });
  const map = new Map<string, Run>();
  for (const run of runs) {
    const current = map.get(run.campaignId);
    const inProgress = run.status === "queued" || run.status === "running";
    if (
      !current ||
      (inProgress &&
        current.status !== "queued" &&
        current.status !== "running")
    ) {
      map.set(run.campaignId, run);
    }
  }
  return map;
}

/** Runs still marked in progress that no job is working, after a restart. */
export async function abandonStaleRuns(
  campaignId: string,
  now: Date,
): Promise<number> {
  const { count } = await prisma.saleRun.updateMany({
    where: { campaignId, status: { in: ["queued", "running"] } },
    data: { status: "cancelled", finishedAt: now, lastError: "Superseded" },
  });
  return count;
}

/** One row of one campaign, tenant-checked through the campaign. */
export async function getCampaignVariant(
  principal: Principal,
  campaignId: string,
  rowId: string,
): Promise<CampaignVariant | null> {
  const shopId = await shopIdFor(principal);
  return prisma.saleCampaignVariant.findFirst({
    where: { id: rowId, campaignId, shopId },
  });
}
