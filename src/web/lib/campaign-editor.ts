import type { AutomaticDiscountsResult } from "~/adapters/shopify/discounts";
import { salePriceFor } from "~/domain/sales/pricing";
import type { DiscountSpec, RoundingSpec } from "~/domain/sales/types";
import { formatMoney } from "~/web/lib/money";
import {
  CONFLICT_LABEL,
  STATUS_LABEL,
  describeDiscount,
  formatInZone,
  parseAmount,
  parsePercent,
  zonedToUtc,
} from "~/web/lib/sales";

/**
 * What the campaign editor says about the form *as it is being edited*
 * (docs/sale-campaigns.md § UI).
 *
 * The sidebar summarises the merchant's unsaved answers, so every line here
 * is derived from the form's strings rather than from the stored campaign.
 * Pure and client-safe: the pricing arithmetic is the domain's own, so the
 * example price the editor shows is exactly the price activation would
 * write.
 */

/** The subset of the form these helpers read. */
export interface DiscountFormFields {
  discountType: DiscountSpec["type"];
  discountValue: string;
  rounding: RoundingSpec["mode"];
  roundingIncrement: string;
}

export interface ScheduleFormFields {
  startMode: "now" | "at";
  startDate: string;
  startTime: string;
  endMode: "none" | "at";
  endDate: string;
  endTime: string;
}

/** The discount the form describes, or null while it is not a valid one. */
export function discountFromForm(
  form: DiscountFormFields,
): DiscountSpec | null {
  const value =
    form.discountType === "percentage"
      ? parsePercent(form.discountValue)
      : parseAmount(form.discountValue);
  if (value === null || value === 0) return null;
  return { type: form.discountType, value };
}

export function roundingFromForm(form: DiscountFormFields): RoundingSpec {
  return {
    mode: form.rounding,
    incrementMinor:
      form.rounding === "increment"
        ? parseAmount(form.roundingIncrement)
        : null,
  };
}

/** "10% off", "€10.00 off", "Set to €99.00" — or what is missing. */
export function describeFormDiscount(
  form: DiscountFormFields,
  currency: string,
): string {
  const discount = discountFromForm(form);
  return discount ? describeDiscount(discount, currency) : "No discount yet";
}

/**
 * One of the merchant's own prices, before and after the discount the form
 * describes (docs/ui-conventions.md: sample data is always the merchant's
 * own). Null while the discount is not valid or the sale would not lower the
 * price, which is what the run skips too.
 */
export function exampleFromForm(
  form: DiscountFormFields,
  baseMinor: number,
  currency: string,
): { before: string; after: string } | null {
  const discount = discountFromForm(form);
  if (!discount) return null;
  const after = salePriceFor(baseMinor, discount, roundingFromForm(form));
  if (after >= baseMinor) return null;
  return {
    before: formatMoney(baseMinor, currency),
    after: formatMoney(after, currency),
  };
}

/** "Europe/Ljubljana (UTC+02:00)" — the zone as the merchant sees it named. */
export function timeZoneLabel(timeZone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName");
    const offset = part?.value === "GMT" ? "UTC+00:00" : part?.value;
    return offset ? `${timeZone} (${offset.replace(/^GMT/, "UTC")})` : timeZone;
  } catch {
    return timeZone;
  }
}

/**
 * When the campaign runs. `starts` and `ends` are the two answers as the
 * summary lists them ("On activation", "No end date", "20 Sep 2026, 00:00");
 * `line` reads them back as one sentence: "Starts on activation · Runs until
 * stopped". A date that cannot be read yet is said as such, not guessed.
 */
export function scheduleSummary(
  form: ScheduleFormFields,
  timeZone: string,
  context: { status: string; startedAt: string | null } = {
    status: "draft",
    startedAt: null,
  },
): { starts: string; ends: string; line: string } {
  let starts: string;
  let startsSentence: string;
  if (context.status === "active") {
    starts = context.startedAt
      ? formatInZone(context.startedAt, timeZone)
      : "Started";
    startsSentence = context.startedAt ? `Started ${starts}` : "Started";
  } else if (form.startMode === "now") {
    starts = "On activation";
    startsSentence = "Starts on activation";
  } else {
    const instant = zonedToUtc(form.startDate, form.startTime, timeZone);
    starts = instant
      ? formatInZone(instant.toISOString(), timeZone)
      : "Date not set";
    startsSentence = instant ? `Starts ${starts}` : "Start date not set";
  }

  let ends: string;
  let endsSentence: string;
  if (form.endMode === "none") {
    ends = "No end date";
    endsSentence = "Runs until stopped";
  } else {
    const instant = zonedToUtc(form.endDate, form.endTime, timeZone);
    ends = instant
      ? formatInZone(instant.toISOString(), timeZone)
      : "Date not set";
    endsSentence = instant ? `Ends ${ends}` : "End date not set";
  }
  return { starts, ends, line: `${startsSentence} · ${endsSentence}` };
}

/** The conflict strategy as the summary states it. */
export function conflictSummary(
  strategy: keyof typeof CONFLICT_LABEL,
  priority: string,
): string {
  const label = CONFLICT_LABEL[strategy].label;
  return strategy === "priority"
    ? `${label} (priority ${priority || "0"})`
    : label;
}

/** "342 products · 1,028 variants matched · 12 excluded · 1,016 final". */
export function targetingSummary(counts: {
  products: number;
  includedVariants: number;
  excludedVariants: number;
  variants: number;
}): string {
  const n = (value: number) => value.toLocaleString("en");
  return [
    `${n(counts.products)} ${counts.products === 1 ? "product" : "products"}`,
    `${n(counts.includedVariants)} ${counts.includedVariants === 1 ? "variant" : "variants"} matched`,
    counts.excludedVariants > 0
      ? `${n(counts.excludedVariants)} excluded`
      : null,
    `${n(counts.variants)} final`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/* -------------------------------------------------------------------------- */
/* Warnings                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What could go wrong with this campaign, worst first: variants another
 * campaign holds, campaigns whose window and rules overlap, a Shopify
 * automatic discount that would stack at checkout, markets with fixed
 * prices that will not follow the sale. Empty when there is nothing to say.
 */
export interface CampaignWarningsInput {
  conflicts: {
    refused: number;
    taken: number;
    lost: number;
    holders: string[];
  };
  scheduledOverlaps: Array<{
    campaignId: string;
    name: string;
    status: keyof typeof STATUS_LABEL;
    variants: number;
  }>;
  fixedPriceMarkets: Array<{
    name: string;
    currency: string;
    fixedPrices: number;
  }>;
  discounts: AutomaticDiscountsResult | null;
  campaignHref: (campaignId: string) => string;
}

export interface CampaignWarning {
  key: string;
  tone: "critical" | "warning" | "info";
  heading: string;
  text: string;
  link?: { href: string; label: string; external?: boolean };
}

export function campaignWarnings(
  props: CampaignWarningsInput,
): CampaignWarning[] {
  const warnings: CampaignWarning[] = [];
  const n = (value: number) => value.toLocaleString("en");

  const contested =
    props.conflicts.refused + props.conflicts.taken + props.conflicts.lost;
  if (contested > 0) {
    warnings.push({
      key: "conflicts",
      tone: props.conflicts.refused > 0 ? "critical" : "warning",
      heading: `${n(contested)} variants held by ${props.conflicts.holders.join(", ")}`,
      text:
        props.conflicts.refused > 0
          ? "Activation is refused under “Do not overlap”. Change the conflict handling, or end the other campaign first."
          : `${n(props.conflicts.taken)} would be taken over and ${n(props.conflicts.lost)} left with the other campaign.`,
    });
  }

  for (const overlap of props.scheduledOverlaps) {
    warnings.push({
      key: `overlap:${overlap.campaignId}`,
      tone: "warning",
      heading: `Overlaps “${overlap.name}”`,
      text: `${STATUS_LABEL[overlap.status]}, sharing ${n(overlap.variants)} variants during the same period.`,
      link: {
        href: props.campaignHref(overlap.campaignId),
        label: "Open campaign",
      },
    });
  }

  if (
    props.discounts?.kind === "read" &&
    props.discounts.discounts.length > 0
  ) {
    warnings.push({
      key: "discounts",
      tone: "warning",
      heading: "Shopify discount overlap",
      text: `An active automatic discount may discount these sale prices again at checkout: ${props.discounts.discounts.map((d) => `${d.title} (${d.kind})`).join(", ")}.`,
      link: {
        href: "shopify://admin/discounts",
        label: "View Shopify discounts",
        external: true,
      },
    });
  }

  if (props.fixedPriceMarkets.length > 0) {
    warnings.push({
      key: "markets",
      tone: "info",
      heading: "Markets with fixed prices keep them",
      text: `${props.fixedPriceMarkets.map((m) => `${m.name} (${m.currency}, ${n(m.fixedPrices)} fixed)`).join("; ")}. Markets priced by percentage or by conversion follow the sale.`,
    });
  }

  return warnings;
}
