import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect } from "react";
import {
  useFetcher,
  useLoaderData,
  useSearchParams,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { describeProducts } from "~/adapters/db/repositories/catalogue.server";
import { resolveExceptionByKey } from "~/adapters/db/repositories/exception.server";
import {
  countVariantStates,
  getCampaign,
  getCampaignVariant,
  listVariantPage,
  recordVariantOutcome,
} from "~/adapters/db/repositories/sale-campaign.server";
import {
  decideFromSnapshot,
  evaluateCampaign,
} from "~/adapters/sales/evaluate.server";
import { recordVariantEvent } from "~/adapters/sales/events.server";
import {
  forceRestoreRow,
  handleExternalChange,
} from "~/adapters/sales/writer.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { readVariantPrices } from "~/adapters/shopify/variant-prices";
import type { VariantState } from "~/domain/sales/types";
import { formatDateTime } from "~/web/lib/datetime";
import { formatMoney } from "~/web/lib/money";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { SKIP_REASON_LABEL, STATE_LABEL } from "~/web/lib/sales";

/**
 * Every variant a campaign touches (docs/sale-campaigns.md § UI): the
 * snapshot rows once it has run, or the evaluated membership before it has.
 * Filterable by state, and the place a review row is decided: keep the
 * campaign price, recalculate from the new one, restore the original, or
 * leave the new price and let the variant go.
 */
const PAGE_SIZE = 50;

const STATES: VariantState[] = [
  "applied",
  "pending",
  "applying",
  "failed",
  "skipped",
  "review",
  "restoring",
  "restored",
  "restore_failed",
  "released",
];

function isState(value: string): value is VariantState {
  return (STATES as string[]).includes(value);
}

function productNumber(gid: string): string {
  return gid.replace(/^gid:\/\/shopify\/Product\//, "");
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const id = String(params.campaignId ?? "");
  const campaign = await getCampaign(principal, id);
  if (!campaign) throw new Response("Not found", { status: 404 });

  const url = new URL(request.url);
  const stateParam = url.searchParams.get("state") ?? "";
  const state = isState(stateParam) ? stateParam : undefined;
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);

  const counts = await countVariantStates(campaign.id);
  const hasRows = Object.values(counts).some((n) => (n ?? 0) > 0);

  if (hasRows) {
    const { rows, total } = await listVariantPage(campaign.id, {
      ...(state ? { state } : {}),
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    });
    const products = await describeProducts(
      principal,
      rows.map((row) => row.productId),
    );
    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        currency: campaign.currency,
      },
      mode: "rows" as const,
      counts,
      state: state ?? "",
      page,
      total,
      rows: rows.map((row) => ({
        id: row.id,
        variantId: row.variantId,
        productId: row.productId,
        productNumber: productNumber(row.productId),
        title: row.title ?? products.get(row.productId)?.title ?? row.variantId,
        sku: row.sku,
        state: row.state,
        reason: row.skipReason ?? row.reviewReason ?? null,
        error: row.lastError,
        original: row.originalPriceMinor,
        originalCompareAt: row.originalCompareAtMinor,
        sale: row.salePriceMinor,
        saleCompareAt: row.saleCompareAtMinor,
        observed: row.lastObservedPriceMinor,
        observedCompareAt: row.lastObservedCompareAtMinor,
        observedAt: row.lastObservedAt?.toISOString() ?? null,
        currency: row.currency,
      })),
    };
  }

  // Not run yet: the membership as the rules evaluate today.
  const evaluation = await evaluateCampaign(principal, campaign);
  const all = evaluation.final.map((facts) => {
    const decision = decideFromSnapshot(campaign, facts);
    return {
      id: facts.variantId,
      variantId: facts.variantId,
      productId: facts.productId,
      productNumber: productNumber(facts.productId),
      title: facts.variantTitle
        ? `${facts.productTitle} — ${facts.variantTitle}`
        : facts.productTitle,
      sku: facts.sku,
      state:
        decision.kind === "apply" ? ("pending" as const) : ("skipped" as const),
      reason: decision.kind === "skip" ? decision.reason : null,
      error: null,
      original: facts.priceMinor,
      originalCompareAt: facts.compareAtMinor,
      sale: decision.kind === "apply" ? decision.salePriceMinor : null,
      saleCompareAt:
        decision.kind === "apply" ? decision.saleCompareAtMinor : null,
      observed: null,
      observedCompareAt: null,
      observedAt: null,
      currency: campaign.currency,
    };
  });
  const filtered = state ? all.filter((row) => row.state === state) : all;
  const previewCounts: Partial<Record<VariantState, number>> = {};
  for (const row of all)
    previewCounts[row.state] = (previewCounts[row.state] ?? 0) + 1;

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      currency: campaign.currency,
    },
    mode: "preview" as const,
    counts: previewCounts,
    state: state ?? "",
    page,
    total: filtered.length,
    rows: filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
  };
};

type Result = { ok: boolean; message: string };

/**
 * Deciding a review row. Each is one variant, one live read, at most one
 * write, and the exception it raised is resolved with it.
 */
export const action = async ({
  request,
  params,
}: ActionFunctionArgs): Promise<Result> => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);
  const id = String(params.campaignId ?? "");
  const campaign = await getCampaign(principal, id);
  if (!campaign) return { ok: false, message: "Campaign not found." };

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const rowId = String(formData.get("row") ?? "");
  const row = await getCampaignVariant(principal, campaign.id, rowId);
  if (!row || row.state !== "review") {
    return {
      ok: false,
      message: "That variant is no longer waiting for a decision.",
    };
  }
  const now = new Date();

  const resolveException = () =>
    resolveExceptionByKey(
      principal,
      "sale_price_conflict",
      `variant:${row.variantId}`,
      actor ?? "merchant",
      now,
    );

  switch (intent) {
    case "keep":
    case "recalculate": {
      /*
       * Runs the base-price policy the merchant chose here, on this row,
       * against the live pair — the same code the webhook uses under
       * `preserve` and `recalculate`.
       */
      const live = (await readVariantPrices(admin, [row.variantId])).get(
        row.variantId,
      );
      if (!live)
        return { ok: false, message: "Shopify no longer has this variant." };
      await recordVariantOutcome(row.id, {
        state: "applied",
        reviewReason: null,
        now,
      });
      await handleExternalChange(
        admin,
        principal,
        {
          ...campaign,
          basePriceChangePolicy: intent === "keep" ? "preserve" : "recalculate",
        },
        { ...row, state: "applied", reviewReason: null },
        { priceMinor: live.priceMinor, compareAtMinor: live.compareAtMinor },
        now,
      );
      await recordVariantEvent(
        principal,
        row.variantId,
        "sale_variant.review_resolved",
        {
          campaignId: campaign.id,
          how: intent,
          by: actor,
        },
      );
      await resolveException();
      return {
        ok: true,
        message:
          intent === "keep"
            ? "Campaign price written back."
            : "Sale recalculated from the new price.",
      };
    }
    case "restore": {
      const outcome = await forceRestoreRow(
        admin,
        principal,
        campaign,
        row,
        now,
      );
      if (outcome.failed > 0)
        return {
          ok: false,
          message: "Shopify rejected the write. The row shows its reason.",
        };
      await resolveException();
      return { ok: true, message: "Original price put back." };
    }
    case "release": {
      await recordVariantOutcome(row.id, {
        state: "released",
        reviewReason: null,
        skipReason: "external_change",
        now,
      });
      await recordVariantEvent(
        principal,
        row.variantId,
        "sale_variant.review_resolved",
        {
          campaignId: campaign.id,
          how: "release",
          by: actor,
        },
      );
      await resolveException();
      return {
        ok: true,
        message: "Left at its new price and released from the campaign.",
      };
    }
    default:
      return { ok: false, message: "Unknown action." };
  }
};

function pair(
  price: number | null,
  compareAt: number | null,
  currency: string,
): string {
  if (price === null) return "—";
  const money = formatMoney(price, currency);
  return compareAt !== null && compareAt > price
    ? `${money} (was ${formatMoney(compareAt, currency)})`
    : money;
}

export default function CampaignVariants() {
  const { campaign, mode, counts, state, page, total, rows } =
    useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data;
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filters = STATES.filter((s) => (counts[s] ?? 0) > 0);

  return (
    <s-page heading={`${campaign.name}: variants`} inlineSize="large">
      <s-link slot="breadcrumb-actions" href={`/app/sales/${campaign.id}`}>
        {campaign.name}
      </s-link>
      <s-button
        slot="secondary-actions"
        href={`/app/sales/${campaign.id}/variants.csv${state ? `?state=${state}` : ""}`}
        target="_blank"
      >
        Export CSV
      </s-button>

      <s-stack direction="block" gap="large">
        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {mode === "preview" ? (
          <s-banner tone="info">
            <s-paragraph>
              This campaign has not been applied yet. These are the variants its
              rules match today and what each would become. Nothing is changed
              by looking.
            </s-paragraph>
          </s-banner>
        ) : null}

        <s-section>
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small-300">
              <s-button
                type="button"
                variant={state === "" ? "primary" : "secondary"}
                onClick={() => setSearchParams({})}
              >
                {`All (${Object.values(counts)
                  .reduce((sum, n) => sum + (n ?? 0), 0)
                  .toLocaleString("en")})`}
              </s-button>
              {filters.map((s) => (
                <s-button
                  key={s}
                  type="button"
                  variant={state === s ? "primary" : "secondary"}
                  onClick={() => setSearchParams({ state: s })}
                >
                  {`${STATE_LABEL[s]} (${(counts[s] ?? 0).toLocaleString("en")})`}
                </s-button>
              ))}
            </s-stack>

            {rows.length === 0 ? (
              <s-text color="subdued">No variants here.</s-text>
            ) : (
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header listSlot="primary">Product</s-table-header>
                  <s-table-header listSlot="kicker">SKU</s-table-header>
                  <s-table-header listSlot="secondary">State</s-table-header>
                  <s-table-header listSlot="secondary">Original</s-table-header>
                  <s-table-header listSlot="secondary">Sale</s-table-header>
                  <s-table-header listSlot="inline">Actions</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {rows.map((row) => (
                    <s-table-row key={row.id}>
                      <s-table-cell>
                        <s-link href={`/app/products/${row.productNumber}`}>
                          {row.title}
                        </s-link>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text color="subdued">{row.sku ?? "—"}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack direction="block" gap="small-500">
                          <s-badge
                            tone={
                              row.state === "failed" ||
                              row.state === "restore_failed" ||
                              row.state === "review"
                                ? "critical"
                                : row.state === "applied"
                                  ? "success"
                                  : "neutral"
                            }
                          >
                            {STATE_LABEL[row.state]}
                          </s-badge>
                          {row.reason ? (
                            <s-text color="subdued">
                              {SKIP_REASON_LABEL[row.reason] ?? row.reason}
                            </s-text>
                          ) : null}
                          {row.error ? (
                            <s-text tone="critical">{row.error}</s-text>
                          ) : null}
                          {row.state === "review" && row.observed !== null ? (
                            <s-text color="subdued">
                              {`Shopify now: ${pair(row.observed, row.observedCompareAt, row.currency)}${row.observedAt ? `, seen ${formatDateTime(row.observedAt)}` : ""}`}
                            </s-text>
                          ) : null}
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        {pair(
                          row.original,
                          row.originalCompareAt,
                          row.currency,
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        {pair(row.sale, row.saleCompareAt, row.currency)}
                      </s-table-cell>
                      <s-table-cell>
                        {row.state === "review" && mode === "rows" ? (
                          <s-stack direction="inline" gap="small-500">
                            <s-button
                              type="button"
                              onClick={() =>
                                fetcher.submit(
                                  { intent: "keep", row: row.id },
                                  { method: "post" },
                                )
                              }
                              {...(busy ? { disabled: true } : {})}
                            >
                              Keep campaign price
                            </s-button>
                            <s-button
                              type="button"
                              onClick={() =>
                                fetcher.submit(
                                  { intent: "recalculate", row: row.id },
                                  { method: "post" },
                                )
                              }
                              {...(busy ? { disabled: true } : {})}
                            >
                              Recalculate
                            </s-button>
                            <s-button
                              type="button"
                              onClick={() =>
                                fetcher.submit(
                                  { intent: "restore", row: row.id },
                                  { method: "post" },
                                )
                              }
                              {...(busy ? { disabled: true } : {})}
                            >
                              Restore original
                            </s-button>
                            <s-button
                              type="button"
                              onClick={() =>
                                fetcher.submit(
                                  { intent: "release", row: row.id },
                                  { method: "post" },
                                )
                              }
                              {...(busy ? { disabled: true } : {})}
                            >
                              Leave new price
                            </s-button>
                          </s-stack>
                        ) : null}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}

            {pages > 1 ? (
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-button
                  type="button"
                  onClick={() =>
                    setSearchParams({
                      ...(state ? { state } : {}),
                      page: String(page - 1),
                    })
                  }
                  {...(page <= 1 ? { disabled: true } : {})}
                >
                  Previous
                </s-button>
                <s-text color="subdued">{`Page ${page} of ${pages}`}</s-text>
                <s-button
                  type="button"
                  onClick={() =>
                    setSearchParams({
                      ...(state ? { state } : {}),
                      page: String(page + 1),
                    })
                  }
                  {...(page >= pages ? { disabled: true } : {})}
                >
                  Next
                </s-button>
              </s-stack>
            ) : null}
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
