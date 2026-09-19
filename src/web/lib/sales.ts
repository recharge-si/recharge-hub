import type { CampaignPhase } from "~/domain/sales/lifecycle";
import {
  operatorsFor,
  valueKindFor,
  type Operator,
  type RuleField,
  type ValueKind,
} from "~/domain/sales/rules";
import type {
  BasePriceChangePolicy,
  CampaignStatus,
  ConflictStrategy,
  DiscountSpec,
  ExistingSalePolicy,
  RoundingMode,
  VariantState,
} from "~/domain/sales/types";
import { formatMoney } from "~/web/lib/money";

/**
 * Sale campaigns in the merchant's words (docs/ui-conventions.md). Pure and
 * client-safe: the editor, the index and the product page all read from
 * here so one concept has one name.
 */

export const STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  active: "Active",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const PHASE_LABEL: Record<CampaignPhase, string> = {
  applying: "Applying sale",
  applied: "Sale is live",
  partially_applied: "Partly applied",
  restoring: "Putting prices back",
  needs_attention: "Needs attention",
  idle: "",
};

export const STATE_LABEL: Record<VariantState, string> = {
  pending: "Waiting",
  applying: "Applying",
  applied: "On sale",
  failed: "Failed",
  skipped: "Skipped",
  review: "Needs a decision",
  restoring: "Restoring",
  restored: "Restored",
  restore_failed: "Restore failed",
  released: "Released",
};

export const SKIP_REASON_LABEL: Record<string, string> = {
  already_on_sale: "Already on sale",
  would_raise_price: "Would raise the price",
  no_discount: "No discount to give",
  zero_price: "Would round to nothing",
  conflict: "Held by another campaign",
  no_longer_matches: "No longer matches the rules",
  variant_missing: "No longer in Shopify",
  never_applied: "Campaign ended first",
  recalculated_out: "New price leaves no discount",
  changed_before_apply: "Changed before it was applied",
  changed_before_restore: "Changed before it was restored",
  external_change: "Changed outside the campaign",
};

export const DISCOUNT_TYPE_LABEL: Record<DiscountSpec["type"], string> = {
  percentage: "Percentage off",
  fixed_amount: "Amount off",
  fixed_price: "Set price",
};

export const ROUNDING_LABEL: Record<RoundingMode, string> = {
  none: "No rounding",
  nearest_whole: "Nearest whole number",
  ending_99: "End in .99",
  ending_9: "End in 9",
  ending_99_99: "End in 99.99",
  increment: "Nearest increment",
};

export const EXISTING_SALE_LABEL: Record<
  ExistingSalePolicy,
  { label: string; detail: string }
> = {
  skip: {
    label: "Leave them as they are",
    detail: "Variants already on sale are skipped. The safe choice.",
  },
  discount_selling_price: {
    label: "Discount the current sale price",
    detail:
      "The discount comes off what the customer pays now; the compare-at price stays.",
  },
  discount_compare_at: {
    label: "Discount the compare-at price",
    detail:
      "The discount comes off the original price. A variant whose price would go up is skipped.",
  },
  override: {
    label: "Replace the existing sale",
    detail:
      "This campaign's discount off the original price replaces the sale, even if it is smaller.",
  },
};

export const CONFLICT_LABEL: Record<
  ConflictStrategy,
  { label: string; detail: string }
> = {
  prevent: {
    label: "Do not overlap",
    detail:
      "Activation is refused while another active campaign holds any of these variants.",
  },
  priority: {
    label: "Higher priority wins",
    detail:
      "The campaign with the higher priority number takes the variant; a tie is refused.",
  },
  largest_discount: {
    label: "Largest discount wins",
    detail: "Whichever campaign lowers the price more takes the variant.",
  },
  newest: {
    label: "Newest campaign wins",
    detail: "The campaign created most recently takes the variant.",
  },
};

export const BASE_CHANGE_LABEL: Record<
  BasePriceChangePolicy,
  { label: string; detail: string }
> = {
  review: {
    label: "Ask me",
    detail:
      "Nothing is written. The variant is listed under Needs attention with both prices.",
  },
  preserve: {
    label: "Keep the campaign price",
    detail:
      "The sale price is written back; the new price becomes what is restored afterwards.",
  },
  recalculate: {
    label: "Recalculate from the new price",
    detail:
      "The discount is applied to the new price, and the new price is restored afterwards.",
  },
};

export const FIELD_LABEL: Record<RuleField, string> = {
  all_products: "All products",
  product: "Product",
  variant: "Variant",
  collection: "Collection",
  vendor: "Vendor",
  product_type: "Product type",
  tag: "Tag",
  category: "Category",
  status: "Product status",
  sku: "SKU",
  barcode: "Barcode",
  title: "Title",
  handle: "Handle",
  price: "Price",
  compare_at_price: "Compare-at price",
  on_sale: "On sale",
  metafield: "Metafield",
};

export const OPERATOR_LABEL: Record<Operator, string> = {
  eq: "is",
  neq: "is not",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  in: "is any of",
  not_in: "is none of",
  is_true: "is yes",
  is_false: "is no",
};

/** Tag reads better as "has" than "is". */
export function operatorLabel(field: RuleField, operator: Operator): string {
  if (field === "tag") {
    return (
      {
        eq: "has tag",
        neq: "does not have tag",
        in: "has any of",
        not_in: "has none of",
      }[operator as "eq" | "neq" | "in" | "not_in"] ?? OPERATOR_LABEL[operator]
    );
  }
  if (
    field === "collection" ||
    field === "product" ||
    field === "variant" ||
    field === "category"
  ) {
    return (
      { in: "is any of", not_in: "is none of" }[operator as "in" | "not_in"] ??
      OPERATOR_LABEL[operator]
    );
  }
  return OPERATOR_LABEL[operator];
}

export function operatorsForField(
  field: RuleField,
  metafieldType?: string,
): Operator[] {
  return [...operatorsFor(valueKindFor(field, metafieldType))];
}

export function valueKind(field: RuleField, metafieldType?: string): ValueKind {
  return valueKindFor(field, metafieldType);
}

/** "20% off", "€100 off", "Set to €999". */
export function describeDiscount(
  discount: DiscountSpec,
  currency: string,
): string {
  switch (discount.type) {
    case "percentage":
      return `${formatBasisPoints(discount.value)} off`;
    case "fixed_amount":
      return `${formatMoney(discount.value, currency)} off`;
    case "fixed_price":
      return `Set to ${formatMoney(discount.value, currency)}`;
  }
}

/** 2000 → "20%", 1250 → "12.5%". */
export function formatBasisPoints(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const fraction = bp % 100;
  return fraction === 0
    ? `${whole}%`
    : `${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}%`;
}

/** "20" or "12.5" → basis points, or null. */
export function parsePercent(raw: string): number | null {
  const text = raw.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const bp = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return bp >= 0 && bp <= 10_000 ? bp : null;
}

/** "1799.99" or "1.799,99" → minor units, or null. */
export function parseAmount(raw: string): number | null {
  let text = raw.trim();
  if (text === "") return null;
  if (text.includes(".") && text.includes(","))
    text = text.replace(/\./g, "").replace(",", ".");
  else text = text.replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export function formatAmountInput(minor: number | null): string {
  if (minor === null) return "";
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

/* -------------------------------------------------------------------------- */
/* Time in the shop's zone                                                    */
/* -------------------------------------------------------------------------- */

function partsIn(date: Date, timeZone: string): Record<string, number> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts;
}

/** The zone's offset from UTC at that instant, in milliseconds. */
function offsetAt(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(
    p.year ?? 1970,
    (p.month ?? 1) - 1,
    p.day ?? 1,
    p.hour ?? 0,
    p.minute ?? 0,
    p.second ?? 0,
  );
  return asUtc - date.getTime();
}

/**
 * A wall-clock date and time in the shop's timezone to the UTC instant. Two
 * passes settle a daylight-saving boundary; a time that does not exist (the
 * skipped hour) lands on the instant after it.
 */
export function zonedToUtc(
  date: string,
  time: string,
  timeZone: string,
): Date | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time.trim() || "00:00");
  if (!dm || !tm) return null;
  const guess = Date.UTC(
    Number(dm[1]),
    Number(dm[2]) - 1,
    Number(dm[3]),
    Number(tm[1]),
    Number(tm[2]),
  );
  if (Number.isNaN(guess)) return null;
  let instant = guess - offsetAt(new Date(guess), timeZone);
  instant = guess - offsetAt(new Date(instant), timeZone);
  return new Date(instant);
}

/** The UTC instant as the shop's wall-clock date and time, for the form. */
export function utcToZoned(
  date: Date,
  timeZone: string,
): { date: string; time: string } {
  const p = partsIn(date, timeZone);
  const pad = (n: number | undefined) => String(n ?? 0).padStart(2, "0");
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
  };
}

/** "20 Sep 2026, 00:00 (Europe/Ljubljana)" for a stored instant. */
export function formatInZone(iso: string, timeZone: string): string {
  try {
    return new Date(iso).toLocaleString("en-GB", {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return new Date(iso).toLocaleString();
  }
}
