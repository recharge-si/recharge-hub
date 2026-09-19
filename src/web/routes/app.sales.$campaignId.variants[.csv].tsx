import type { LoaderFunctionArgs } from "react-router";

import {
  countVariantStates,
  getCampaign,
  listCampaignVariants,
} from "~/adapters/db/repositories/sale-campaign.server";
import {
  decideFromSnapshot,
  evaluateCampaign,
} from "~/adapters/sales/evaluate.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { fromMinorUnits } from "~/adapters/shopify/variant-prices";
import type { VariantState } from "~/domain/sales/types";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * The campaign's variants as a CSV (docs/sale-campaigns.md § UI): the
 * snapshot rows once it has run, or the evaluated membership before. The
 * same rows the variants page shows, without the paging. Prices are decimal
 * strings in the campaign's currency.
 */
const BOM = String.fromCharCode(0xfeff);

const HEADER = [
  "variant_id",
  "product_id",
  "title",
  "sku",
  "state",
  "reason",
  "original_price",
  "original_compare_at",
  "sale_price",
  "sale_compare_at",
  "last_error",
];

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function money(minor: number | null): string {
  return minor === null ? "" : fromMinorUnits(minor);
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const campaign = await getCampaign(
    principal,
    String(params.campaignId ?? ""),
  );
  if (!campaign) throw new Response("Not found", { status: 404 });

  const state = new URL(request.url).searchParams.get("state");
  const counts = await countVariantStates(campaign.id);
  const hasRows = Object.values(counts).some((n) => (n ?? 0) > 0);

  const lines: string[][] = [];
  if (hasRows) {
    const rows = await listCampaignVariants(campaign.id, {
      ...(state ? { states: [state as VariantState] } : {}),
    });
    for (const row of rows) {
      lines.push([
        row.variantId,
        row.productId,
        row.title ?? "",
        row.sku ?? "",
        row.state,
        row.skipReason ?? row.reviewReason ?? "",
        money(row.originalPriceMinor),
        money(row.originalCompareAtMinor),
        money(row.salePriceMinor),
        money(row.saleCompareAtMinor),
        row.lastError ?? "",
      ]);
    }
  } else {
    const evaluation = await evaluateCampaign(principal, campaign);
    for (const facts of evaluation.final) {
      const decision = decideFromSnapshot(campaign, facts);
      const rowState = decision.kind === "apply" ? "pending" : "skipped";
      if (state && state !== rowState) continue;
      lines.push([
        facts.variantId,
        facts.productId,
        facts.variantTitle
          ? `${facts.productTitle} — ${facts.variantTitle}`
          : facts.productTitle,
        facts.sku ?? "",
        rowState,
        decision.kind === "skip" ? decision.reason : "",
        money(facts.priceMinor),
        money(facts.compareAtMinor),
        decision.kind === "apply" ? money(decision.salePriceMinor) : "",
        decision.kind === "apply" ? money(decision.saleCompareAtMinor) : "",
        "",
      ]);
    }
  }

  const body = [HEADER, ...lines]
    .map((line) => line.map(cell).join(","))
    .join("\r\n");
  const name =
    campaign.name
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "campaign";

  // A byte-order mark, so Excel opens the file as UTF-8.
  return new Response(`${BOM}${body}\r\n`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}-variants.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
