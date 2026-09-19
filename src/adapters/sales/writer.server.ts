import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { prisma } from "~/adapters/db/client.server";
import { raiseException } from "~/adapters/db/repositories/exception.server";
import {
  listLiveOwners,
  recordVariantOutcome,
  type Campaign,
  type CampaignVariant,
} from "~/adapters/db/repositories/sale-campaign.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { discountOf, roundingOf } from "~/adapters/sales/evaluate.server";
import { recordVariantEvent } from "~/adapters/sales/events.server";
import {
  VariantPriceWriteError,
  readVariantPrices,
  writeVariantPrices,
  type LiveVariant,
  type PriceWrite,
} from "~/adapters/shopify/variant-prices";
import {
  classifyObservation,
  decideVariantPricing,
  effectiveDiscountBp,
  resolveConflict,
  samePair,
} from "~/domain/sales";
import type { PricePair } from "~/domain/sales/types";
import type { Principal } from "~/domain/types";

/**
 * The only code that changes a price in Shopify, and the only code that
 * puts one back (docs/sale-campaigns.md § Idempotency, § Failure and
 * recovery).
 *
 * Both entry points take rows a run has already claimed, read the same
 * variants live, decide per row from what Shopify actually holds, write one
 * mutation per product, and record every row's outcome. A crash anywhere
 * between the write and the record is repaired by the next attempt's live
 * read: it finds the price already where it was going and records that
 * without writing again.
 */

export interface BatchOutcome {
  done: number;
  failed: number;
}

interface Planned {
  row: CampaignVariant;
  write: PriceWrite | null;
  /** What to record if the write goes through. */
  success: () => Promise<void>;
  /** What to record if Shopify rejects the product's mutation. */
  failure: (message: string) => Promise<void>;
}

function pairOf(
  row: CampaignVariant,
  which: "original" | "sale",
): PricePair | null {
  const price =
    which === "original" ? row.originalPriceMinor : row.salePriceMinor;
  const compareAt =
    which === "original" ? row.originalCompareAtMinor : row.saleCompareAtMinor;
  if (price === null) return null;
  return { priceMinor: price, compareAtMinor: compareAt };
}

function livePair(live: LiveVariant): PricePair {
  return { priceMinor: live.priceMinor, compareAtMinor: live.compareAtMinor };
}

/** Runs the planned writes product by product and settles each row. */
async function execute(
  admin: AdminApiContext,
  plans: Planned[],
): Promise<BatchOutcome> {
  const outcome: BatchOutcome = { done: 0, failed: 0 };
  const byProduct = new Map<string, Planned[]>();
  for (const plan of plans) {
    if (!plan.write) {
      await plan.success();
      outcome.done += 1;
      continue;
    }
    const list = byProduct.get(plan.row.productId) ?? [];
    list.push(plan);
    byProduct.set(plan.row.productId, list);
  }

  for (const [productId, list] of byProduct) {
    try {
      const result = await writeVariantPrices(
        admin,
        productId,
        list.map((plan) => plan.write as PriceWrite),
      );
      if (result.userErrors.length > 0) {
        /*
         * Shopify rejects the whole mutation on one bad variant and does not
         * say which. Every row in it is recorded failed with the message,
         * and retry works them one product at a time again — the merchant
         * sees which variant Shopify names in the message.
         */
        const message = result.userErrors.join("; ");
        for (const plan of list) await plan.failure(message);
        outcome.failed += list.length;
        continue;
      }
      for (const plan of list) {
        const written = result.written.get(plan.row.variantId);
        if (written && plan.write && !samePair(written, plan.write)) {
          await plan.failure(
            `Shopify reports ${written.priceMinor}/${written.compareAtMinor ?? "–"} after the write, not what was sent.`,
          );
          outcome.failed += 1;
          continue;
        }
        await plan.success();
        outcome.done += 1;
      }
    } catch (error) {
      if (error instanceof VariantPriceWriteError) {
        for (const plan of list) await plan.failure(error.message);
        outcome.failed += list.length;
        continue;
      }
      throw error;
    }
  }

  return outcome;
}

/* -------------------------------------------------------------------------- */
/* Apply                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Applies the campaign to rows in `applying`.
 *
 * A row with no snapshot yet takes one from the live pair, decides the sale,
 * records the snapshot **before** the write, and writes. A row that already
 * has a snapshot is a retry: the sale is what was recorded, never recomputed
 * from a price that may already be discounted.
 *
 * Conflicts are settled before a row can be claimed (`resolveHeldRows`);
 * finding another owner here means the world moved between the two steps,
 * and the row is skipped rather than fought over.
 */
export async function applyRows(
  admin: AdminApiContext,
  principal: Principal,
  campaign: Campaign,
  rows: readonly CampaignVariant[],
  now: Date,
): Promise<BatchOutcome> {
  const live = await readVariantPrices(
    admin,
    rows.map((row) => row.variantId),
  );
  const owners = await listLiveOwners(
    principal,
    rows.map((row) => row.variantId),
  );
  const ownerByVariant = new Map(
    owners
      .filter((row) => row.campaignId !== campaign.id)
      .map((row) => [row.variantId, row]),
  );

  const plans: Planned[] = [];
  const settled: BatchOutcome = { done: 0, failed: 0 };

  for (const row of rows) {
    const current = live.get(row.variantId);
    if (!current) {
      await recordVariantOutcome(row.id, {
        state: "released",
        skipReason: "variant_missing",
        now,
      });
      await recordVariantEvent(
        principal,
        row.variantId,
        "sale_variant.released",
        {
          campaignId: campaign.id,
          reason: "variant_missing",
        },
      );
      settled.done += 1;
      continue;
    }
    const observed = livePair(current);

    const sale = pairOf(row, "sale");
    const original = pairOf(row, "original");
    if (sale && original) {
      // A retry of a row already snapshotted.
      const seen = classifyObservation({ sale, original }, observed);
      if (seen.kind === "as_expected") {
        await recordVariantOutcome(row.id, {
          state: "applied",
          observed,
          lastAppliedAt: now,
          now,
        });
        settled.done += 1;
        continue;
      }
      if (seen.kind === "external") {
        await recordVariantOutcome(row.id, {
          state: "review",
          reviewReason: "changed_before_apply",
          observed,
          now,
        });
        await raiseConflict(principal, campaign, row, sale, observed);
        settled.done += 1;
        continue;
      }
      plans.push(plan(row, sale, observed, null));
      continue;
    }

    const holder = ownerByVariant.get(row.variantId);
    if (holder) {
      await recordVariantOutcome(row.id, {
        state: "skipped",
        skipReason: "conflict",
        lastError: `Held by "${holder.campaign.name}"`,
        observed,
        now,
      });
      await recordVariantEvent(
        principal,
        row.variantId,
        "sale_variant.skipped",
        {
          campaignId: campaign.id,
          reason: "conflict",
          holder: holder.campaignId,
        },
      );
      settled.done += 1;
      continue;
    }

    const decision = decideVariantPricing({
      live: observed,
      policy: campaign.existingSalePolicy,
      discount: discountOf(campaign),
      rounding: roundingOf(campaign),
    });

    if (decision.kind === "skip") {
      await recordVariantOutcome(row.id, {
        state: "skipped",
        skipReason: decision.reason,
        original: decision.original,
        observed,
        now,
      });
      await recordVariantEvent(
        principal,
        row.variantId,
        "sale_variant.skipped",
        {
          campaignId: campaign.id,
          reason: decision.reason,
        },
      );
      settled.done += 1;
      continue;
    }

    const salePair: PricePair = {
      priceMinor: decision.salePriceMinor,
      compareAtMinor: decision.saleCompareAtMinor,
    };
    // The snapshot goes down before the write. A crash after this line and
    // before the record leaves a row whose retry finds the live pair equal
    // to `sale` and marks it applied — never a second discount.
    await recordVariantOutcome(row.id, {
      state: "applying",
      original: decision.original,
      baseMinor: decision.baseMinor,
      sale: salePair,
      observed,
      snapshotCreatedAt: now,
      now,
    });
    plans.push(plan(row, salePair, observed, decision.original));
  }

  function plan(
    row: CampaignVariant,
    salePair: PricePair,
    observed: PricePair,
    original: PricePair | null,
  ): Planned {
    return {
      row,
      write: { variantId: row.variantId, ...salePair },
      success: async () => {
        await recordVariantOutcome(row.id, {
          state: "applied",
          observed: salePair,
          lastAppliedAt: now,
          now,
        });
        await recordVariantEvent(
          principal,
          row.variantId,
          "sale_variant.price_changed",
          {
            campaignId: campaign.id,
            before: original ?? observed,
            after: salePair,
          },
        );
      },
      failure: async (message) => {
        await recordVariantOutcome(row.id, {
          state: "failed",
          lastError: message,
          bumpAttempts: true,
          now,
        });
        await recordVariantEvent(
          principal,
          row.variantId,
          "sale_variant.apply_failed",
          {
            campaignId: campaign.id,
            message,
          },
        );
      },
    };
  }

  const written = await execute(admin, plans);
  return {
    done: settled.done + written.done,
    failed: settled.failed + written.failed,
  };
}

/* -------------------------------------------------------------------------- */
/* Conflicts                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Pending rows whose variant another campaign holds
 * (docs/sale-campaigns.md § Conflicts). The strategy decides: the row is
 * skipped, or the holder's price is put back and its row released, after
 * which the pending row is claimable like any other and snapshots from the
 * restored price. Prices never stack, because the holder is restored
 * **before** the challenger reads the variant.
 */
export async function resolveHeldRows(
  admin: AdminApiContext,
  principal: Principal,
  campaign: Campaign,
  held: ReadonlyArray<{
    row: CampaignVariant;
    holder: CampaignVariant & { campaign: Campaign };
  }>,
  now: Date,
): Promise<{ released: number; skipped: number }> {
  let released = 0;
  let skipped = 0;

  const skip = async (
    row: CampaignVariant,
    holderName: string,
    why: string,
  ) => {
    await recordVariantOutcome(row.id, {
      state: "skipped",
      skipReason: "conflict",
      lastError: `${why} "${holderName}"`,
      now,
    });
    await recordVariantEvent(principal, row.variantId, "sale_variant.skipped", {
      campaignId: campaign.id,
      reason: "conflict",
    });
    skipped += 1;
  };

  for (const { row, holder } of held) {
    const holderOriginal = pairOf(holder, "original");
    const ours = holderOriginal
      ? decideVariantPricing({
          live: holderOriginal,
          policy: campaign.existingSalePolicy,
          discount: discountOf(campaign),
          rounding: roundingOf(campaign),
        })
      : null;
    const ourBp =
      ours && ours.kind === "apply"
        ? effectiveDiscountBp(ours.baseMinor, ours.salePriceMinor)
        : 0;
    const theirBp =
      holder.basePriceMinor !== null && holder.salePriceMinor !== null
        ? effectiveDiscountBp(holder.basePriceMinor, holder.salePriceMinor)
        : 0;
    const outcome = resolveConflict(
      campaign.conflictStrategy,
      {
        id: campaign.id,
        priority: campaign.priority,
        createdAtMs: campaign.createdAt.getTime(),
        discountBp: ourBp,
      },
      {
        id: holder.campaignId,
        priority: holder.campaign.priority,
        createdAtMs: holder.campaign.createdAt.getTime(),
        discountBp: theirBp,
      },
    );

    if (outcome !== "challenger") {
      await skip(row, holder.campaign.name, "Held by");
      continue;
    }
    // A holder still being written, or under review, is not taken over.
    if (holder.state !== "applied") {
      await skip(row, holder.campaign.name, "Still being handled by");
      continue;
    }

    const restored = await restoreRows(
      admin,
      principal,
      holder.campaign,
      [holder],
      now,
      { finalState: "released", reason: `superseded:${campaign.id}` },
    );
    const after = await prisma.saleCampaignVariant.findUnique({
      where: { id: holder.id },
      select: { state: true },
    });
    if (restored.failed > 0 || after?.state !== "released") {
      await skip(row, holder.campaign.name, "Could not release it from");
      continue;
    }
    released += 1;
  }

  if (released > 0) {
    getLogger().info(
      { campaign: campaign.id, released },
      "Sale campaign took variants over from other campaigns",
    );
  }
  return { released, skipped };
}

/* -------------------------------------------------------------------------- */
/* Restore                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Puts rows back to their original pair.
 *
 * Written only when Shopify still holds what this campaign wrote (or holds
 * the original already, in which case nothing is written). Anything else is
 * somebody else's newer price, and overwriting it with a stale original is
 * the one thing a restore must never do: the row goes to `review` and a
 * person decides.
 */
export async function restoreRows(
  admin: AdminApiContext,
  principal: Principal,
  campaign: Campaign,
  rows: readonly CampaignVariant[],
  now: Date,
  options: { finalState: "restored" | "released"; reason: string | null } = {
    finalState: "restored",
    reason: null,
  },
): Promise<BatchOutcome> {
  const live = await readVariantPrices(
    admin,
    rows.map((row) => row.variantId),
  );
  const plans: Planned[] = [];
  const outcome: BatchOutcome = { done: 0, failed: 0 };

  for (const row of rows) {
    const original = pairOf(row, "original");
    const sale = pairOf(row, "sale");
    const current = live.get(row.variantId);

    if (!current) {
      await recordVariantOutcome(row.id, {
        state: "released",
        skipReason: "variant_missing",
        now,
      });
      outcome.done += 1;
      continue;
    }
    const observed = livePair(current);

    if (!original || !sale) {
      // Never written: nothing to put back.
      await recordVariantOutcome(row.id, {
        state: options.finalState,
        skipReason: options.reason,
        observed,
        restoredAt: now,
        now,
      });
      outcome.done += 1;
      continue;
    }

    const seen = classifyObservation({ sale, original }, observed);
    if (seen.kind === "as_original") {
      await recordVariantOutcome(row.id, {
        state: options.finalState,
        skipReason: options.reason,
        observed,
        restoredAt: now,
        now,
      });
      outcome.done += 1;
      continue;
    }
    if (seen.kind === "external") {
      await recordVariantOutcome(row.id, {
        state: "review",
        reviewReason: "changed_before_restore",
        observed,
        now,
      });
      await raiseConflict(principal, campaign, row, sale, observed);
      // Processed, not failed: a person has been asked, and retry would
      // only ask again.
      outcome.done += 1;
      continue;
    }

    plans.push({
      row,
      write: { variantId: row.variantId, ...original },
      success: async () => {
        await recordVariantOutcome(row.id, {
          state: options.finalState,
          skipReason: options.reason,
          observed: original,
          restoredAt: now,
          now,
        });
        await recordVariantEvent(
          principal,
          row.variantId,
          "sale_variant.restored",
          {
            campaignId: campaign.id,
            before: sale,
            after: original,
            ...(options.reason ? { reason: options.reason } : {}),
          },
        );
      },
      failure: async (message) => {
        await recordVariantOutcome(row.id, {
          state: "restore_failed",
          lastError: message,
          bumpAttempts: true,
          now,
        });
        await recordVariantEvent(
          principal,
          row.variantId,
          "sale_variant.restore_failed",
          {
            campaignId: campaign.id,
            message,
          },
        );
      },
    });
  }

  const written = await execute(admin, plans);
  return {
    done: outcome.done + written.done,
    failed: outcome.failed + written.failed,
  };
}

/**
 * Forces the original pair back regardless of what Shopify holds. Only a
 * person asks for this, from a review row, having seen both pairs.
 */
export async function forceRestoreRow(
  admin: AdminApiContext,
  principal: Principal,
  campaign: Campaign,
  row: CampaignVariant,
  now: Date,
): Promise<BatchOutcome> {
  const original = pairOf(row, "original");
  if (!original) {
    await recordVariantOutcome(row.id, { state: "released", now });
    return { done: 1, failed: 0 };
  }
  return execute(admin, [
    {
      row,
      write: { variantId: row.variantId, ...original },
      success: async () => {
        await recordVariantOutcome(row.id, {
          state: "restored",
          reviewReason: null,
          observed: original,
          restoredAt: now,
          now,
        });
        await recordVariantEvent(
          principal,
          row.variantId,
          "sale_variant.review_resolved",
          {
            campaignId: campaign.id,
            how: "restore_original",
            after: original,
          },
        );
      },
      failure: async (message) => {
        await recordVariantOutcome(row.id, {
          state: "restore_failed",
          lastError: message,
          bumpAttempts: true,
          now,
        });
      },
    },
  ]);
}

/* -------------------------------------------------------------------------- */
/* External changes                                                           */
/* -------------------------------------------------------------------------- */

async function raiseConflict(
  principal: Principal,
  campaign: Campaign,
  row: CampaignVariant,
  expected: PricePair,
  observed: PricePair,
): Promise<void> {
  await recordVariantEvent(
    principal,
    row.variantId,
    "sale_variant.external_change_detected",
    {
      campaignId: campaign.id,
      expected,
      observed,
    },
  );
  await raiseException(principal, {
    kind: "sale_price_conflict",
    dedupeKey: `variant:${row.variantId}`,
    message: `"${row.title ?? row.sku ?? row.variantId}" was changed outside the campaign "${campaign.name}": expected ${describe(expected, row.currency)}, found ${describe(observed, row.currency)}. Open the campaign's variants to keep the campaign price, recalculate it, or leave the new price.`,
    detail: {
      campaignId: campaign.id,
      variantId: row.variantId,
      rowId: row.id,
      expected,
      observed,
    },
  });
}

function describe(pair: PricePair, currency: string): string {
  const money = (minor: number) => `${(minor / 100).toFixed(2)} ${currency}`;
  return pair.compareAtMinor === null
    ? money(pair.priceMinor)
    : `${money(pair.priceMinor)} (was ${money(pair.compareAtMinor)})`;
}

/**
 * An owned variant reported at a pair the campaign did not write
 * (docs/sale-campaigns.md § External base-price change).
 *
 * Under `review` nothing is written. Under `preserve` the new base becomes
 * the original — so restore later writes the ERP's newer price, not a stale
 * one — and the campaign's sale price is written back over it. Under
 * `recalculate` the sale is recomputed from the new base as well.
 */
export async function handleExternalChange(
  admin: AdminApiContext,
  principal: Principal,
  campaign: Campaign,
  row: CampaignVariant,
  observed: PricePair,
  now: Date,
): Promise<void> {
  const sale = pairOf(row, "sale");
  const original = pairOf(row, "original");
  if (!sale || !original) return;

  const seen = classifyObservation({ sale, original }, observed);
  if (seen.kind !== "external") {
    await recordVariantOutcome(row.id, { state: row.state, observed, now });
    return;
  }

  if (campaign.basePriceChangePolicy === "review") {
    await recordVariantOutcome(row.id, {
      state: "review",
      reviewReason: "external_change",
      observed,
      now,
    });
    await raiseConflict(principal, campaign, row, sale, observed);
    return;
  }

  const newOriginal: PricePair = {
    priceMinor: seen.newBaseMinor,
    compareAtMinor: original.compareAtMinor,
  };
  await recordVariantEvent(
    principal,
    row.variantId,
    "sale_variant.external_change_detected",
    {
      campaignId: campaign.id,
      expected: sale,
      observed,
      policy: campaign.basePriceChangePolicy,
      newOriginal,
    },
  );

  let next: { base: number; sale: PricePair } | null;
  if (campaign.basePriceChangePolicy === "preserve") {
    const compareAt = original.compareAtMinor ?? seen.newBaseMinor;
    next =
      sale.priceMinor < compareAt
        ? {
            base: seen.newBaseMinor,
            sale: { priceMinor: sale.priceMinor, compareAtMinor: compareAt },
          }
        : null;
  } else {
    const decision = decideVariantPricing({
      live: newOriginal,
      policy: campaign.existingSalePolicy,
      discount: discountOf(campaign),
      rounding: roundingOf(campaign),
    });
    next =
      decision.kind === "apply"
        ? {
            base: decision.baseMinor,
            sale: {
              priceMinor: decision.salePriceMinor,
              compareAtMinor: decision.saleCompareAtMinor,
            },
          }
        : null;
  }

  if (!next) {
    // The campaign no longer lowers this price. The new price stands; the
    // row leaves the campaign without writing anything.
    await recordVariantOutcome(row.id, {
      state: "released",
      skipReason: "recalculated_out",
      original: newOriginal,
      observed,
      now,
    });
    await recordVariantEvent(
      principal,
      row.variantId,
      "sale_variant.released",
      {
        campaignId: campaign.id,
        reason: "recalculated_out",
      },
    );
    return;
  }

  await recordVariantOutcome(row.id, {
    state: "applying",
    original: newOriginal,
    baseMinor: next.base,
    sale: next.sale,
    observed,
    now,
  });
  const chosen = next;
  await execute(admin, [
    {
      row,
      write: { variantId: row.variantId, ...chosen.sale },
      success: async () => {
        await recordVariantOutcome(row.id, {
          state: "applied",
          observed: chosen.sale,
          lastAppliedAt: now,
          now,
        });
        await recordVariantEvent(
          principal,
          row.variantId,
          "sale_variant.price_changed",
          {
            campaignId: campaign.id,
            before: observed,
            after: chosen.sale,
            reason: campaign.basePriceChangePolicy,
          },
        );
      },
      failure: async (message) => {
        await recordVariantOutcome(row.id, {
          state: "failed",
          lastError: message,
          bumpAttempts: true,
          now,
        });
      },
    },
  ]);
}
