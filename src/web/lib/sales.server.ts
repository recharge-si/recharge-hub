import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import {
  getCatalogueState,
  listCachedPriceLists,
} from "~/adapters/db/repositories/catalogue.server";
import type {
  Campaign,
  CampaignInput,
} from "~/adapters/db/repositories/sale-campaign.server";
import {
  decideFromSnapshot,
  evaluateCampaign,
  type Evaluation,
} from "~/adapters/sales/evaluate.server";
import {
  listActiveAutomaticDiscounts,
  type AutomaticDiscountsResult,
} from "~/adapters/shopify/discounts";
import { lintRuleGroup, ruleGroupSchema } from "~/domain/sales/rules";
import type { Principal } from "~/domain/types";
import { parseAmount, parsePercent, zonedToUtc } from "~/web/lib/sales";

/**
 * The server side of the campaign editor: the preview, and the form.
 *
 * The preview is strictly read-only (docs/ui-conventions.md § Destructive
 * writes): it evaluates the rules over the catalogue snapshot, prices each
 * variant from the snapshot's pair, and reports what activation would do.
 * The one Shopify call it makes — the automatic discounts — is a read.
 */

export interface PreviewExample {
  variantId: string;
  productId: string;
  title: string;
  sku: string | null;
  beforeMinor: number;
  afterMinor: number;
  currency: string;
}

export interface Preview {
  snapshotAt: string | null;
  products: number;
  variants: number;
  includedVariants: number;
  excludedVariants: number;
  /** Variants that would be written. */
  applies: number;
  /** Variants that would be skipped, by reason. */
  skipped: Record<string, number>;
  /** Variants another active campaign holds, by how the strategy resolves it. */
  conflicts: {
    refused: number;
    taken: number;
    lost: number;
    holders: string[];
  };
  scheduledOverlaps: Evaluation["scheduledOverlaps"];
  examples: PreviewExample[];
  /** Markets with fixed prices, which will not follow the sale. */
  fixedPriceMarkets: Array<{
    name: string;
    currency: string;
    fixedPrices: number;
  }>;
  discounts: AutomaticDiscountsResult | null;
}

const EXAMPLES = 8;

export async function buildPreview(
  principal: Principal,
  campaign: Campaign,
  admin: AdminApiContext | null,
): Promise<Preview> {
  const [state, evaluation, priceLists, discounts] = await Promise.all([
    getCatalogueState(principal),
    evaluateCampaign(principal, campaign),
    listCachedPriceLists(principal),
    admin ? listActiveAutomaticDiscounts(admin) : Promise.resolve(null),
  ]);

  const skipped: Record<string, number> = {};
  const examples: PreviewExample[] = [];
  let applies = 0;
  const conflicted = new Set(
    evaluation.activeConflicts.map((c) => c.variantId),
  );

  for (const facts of evaluation.final) {
    if (conflicted.has(facts.variantId)) continue;
    const decision = decideFromSnapshot(campaign, facts);
    if (decision.kind === "skip") {
      skipped[decision.reason] = (skipped[decision.reason] ?? 0) + 1;
      continue;
    }
    applies += 1;
    if (examples.length < EXAMPLES) {
      examples.push({
        variantId: facts.variantId,
        productId: facts.productId,
        title: facts.variantTitle
          ? `${facts.productTitle} — ${facts.variantTitle}`
          : facts.productTitle,
        sku: facts.sku,
        beforeMinor: decision.saleCompareAtMinor,
        afterMinor: decision.salePriceMinor,
        currency: campaign.currency,
      });
    }
  }

  const conflicts = { refused: 0, taken: 0, lost: 0, holders: [] as string[] };
  const holders = new Set<string>();
  for (const conflict of evaluation.activeConflicts) {
    holders.add(conflict.holderName);
    if (conflict.outcome === "refuse") conflicts.refused += 1;
    else if (conflict.outcome === "challenger") conflicts.taken += 1;
    else conflicts.lost += 1;
  }
  conflicts.holders = [...holders];

  return {
    snapshotAt: state.snapshotAt?.toISOString() ?? null,
    products: evaluation.productCount,
    variants: evaluation.final.length,
    includedVariants: evaluation.includedCount,
    excludedVariants: evaluation.excludedCount,
    applies,
    skipped,
    conflicts,
    scheduledOverlaps: evaluation.scheduledOverlaps,
    examples,
    fixedPriceMarkets: priceLists
      .filter((list) => list.fixedPricesCount > 0)
      .map((list) => ({
        name: list.name,
        currency: list.currency,
        fixedPrices: list.fixedPricesCount,
      })),
    discounts,
  };
}

/* -------------------------------------------------------------------------- */
/* The form                                                                   */
/* -------------------------------------------------------------------------- */

export const campaignFormSchema = z.object({
  name: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(5000),
  discountType: z.enum(["percentage", "fixed_amount", "fixed_price"]),
  discountValue: z.string().trim(),
  rounding: z.enum([
    "none",
    "nearest_whole",
    "ending_99",
    "ending_9",
    "ending_99_99",
    "increment",
  ]),
  roundingIncrement: z.string().trim(),
  startMode: z.enum(["now", "at"]),
  startDate: z.string().trim(),
  startTime: z.string().trim(),
  endMode: z.enum(["none", "at"]),
  endDate: z.string().trim(),
  endTime: z.string().trim(),
  priority: z.string().trim(),
  existingSalePolicy: z.enum([
    "skip",
    "discount_selling_price",
    "discount_compare_at",
    "override",
  ]),
  conflictStrategy: z.enum([
    "prevent",
    "priority",
    "largest_discount",
    "newest",
  ]),
  basePriceChangePolicy: z.enum(["preserve", "recalculate", "review"]),
  dynamicMembership: z.enum(["on", "off"]),
  includeRules: z.string(),
  excludeRules: z.string(),
});

export type CampaignForm = z.infer<typeof campaignFormSchema>;

export type FormOutcome =
  | { ok: true; input: CampaignInput }
  | { ok: false; field: string; message: string };

/** Everything typed, checked, and turned into what the repository stores. */
export function parseCampaignForm(
  form: CampaignForm,
  context: { timeZone: string; currency: string; now: Date },
): FormOutcome {
  let discountValue: number | null;
  if (form.discountType === "percentage") {
    discountValue = parsePercent(form.discountValue);
    if (discountValue === null || discountValue === 0) {
      return {
        ok: false,
        field: "discountValue",
        message: "Enter a percentage between 0.01 and 100, for example 20.",
      };
    }
  } else {
    discountValue = parseAmount(form.discountValue);
    if (discountValue === null || discountValue === 0) {
      return {
        ok: false,
        field: "discountValue",
        message: `Enter an amount in ${context.currency}, for example 100.00.`,
      };
    }
  }

  let roundingIncrementMinor: number | null = null;
  if (form.rounding === "increment") {
    roundingIncrementMinor = parseAmount(form.roundingIncrement);
    if (roundingIncrementMinor === null || roundingIncrementMinor === 0) {
      return {
        ok: false,
        field: "roundingIncrement",
        message: "Enter the increment to round to, for example 5.00.",
      };
    }
  }

  let startsAt: Date | null = null;
  if (form.startMode === "at") {
    startsAt = zonedToUtc(form.startDate, form.startTime, context.timeZone);
    if (!startsAt) {
      return {
        ok: false,
        field: "startDate",
        message:
          "Enter the start as a date and a time, for example 2026-09-20 and 00:00.",
      };
    }
  }

  let endsAt: Date | null = null;
  if (form.endMode === "at") {
    endsAt = zonedToUtc(form.endDate, form.endTime, context.timeZone);
    if (!endsAt) {
      return {
        ok: false,
        field: "endDate",
        message:
          "Enter the end as a date and a time, for example 2026-09-30 and 23:59.",
      };
    }
    if (startsAt && endsAt <= startsAt) {
      return {
        ok: false,
        field: "endDate",
        message: "The end must come after the start.",
      };
    }
    if (!startsAt && endsAt <= context.now) {
      return {
        ok: false,
        field: "endDate",
        message: "The end is already in the past.",
      };
    }
  }

  const priority = Number(form.priority || "0");
  if (!Number.isInteger(priority) || priority < -1000 || priority > 1000) {
    return {
      ok: false,
      field: "priority",
      message: "Priority is a whole number between -1000 and 1000.",
    };
  }

  const includeRules = parseRules(form.includeRules);
  if (!includeRules.ok)
    return { ok: false, field: "includeRules", message: includeRules.message };
  const excludeRules = parseRules(form.excludeRules);
  if (!excludeRules.ok)
    return { ok: false, field: "excludeRules", message: excludeRules.message };

  return {
    ok: true,
    input: {
      name: form.name,
      notes: form.notes === "" ? null : form.notes,
      discountType: form.discountType,
      discountValue,
      currency: context.currency,
      rounding: form.rounding,
      roundingIncrementMinor,
      startsAt,
      endsAt,
      priority,
      existingSalePolicy: form.existingSalePolicy,
      conflictStrategy: form.conflictStrategy,
      basePriceChangePolicy: form.basePriceChangePolicy,
      dynamicMembership: form.dynamicMembership === "on",
      includeRules: includeRules.group,
      excludeRules: excludeRules.group,
    },
  };
}

function parseRules(raw: string) {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      ok: false as const,
      message: "The rules could not be read. Reload the page and try again.",
    };
  }
  const parsed = ruleGroupSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false as const,
      message:
        "A rule is not complete. Check every row has a field, an operator and a value.",
    };
  }
  const group = parsed.data;
  const problems = lintRuleGroup(group);
  if (problems.length > 0) {
    return {
      ok: false as const,
      message: problems[0] ?? "A rule is incomplete.",
    };
  }
  return { ok: true as const, group };
}
