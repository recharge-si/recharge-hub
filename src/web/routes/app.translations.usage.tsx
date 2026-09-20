import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  useLoaderData,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { translationModel } from "~/adapters/ai/openai.server";
import {
  usageBreakdown,
  usageTotals,
  type UsageBreakdownRow,
  type UsageTotals,
} from "~/adapters/db/repositories/translations.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { formatCount } from "~/domain/translations/estimate";
import {
  PRICING_VERSION,
  formatMicrosUsd,
  pricingFor,
} from "~/domain/translations/pricing";
import {
  RESOURCE_TYPE_LABEL,
  isResourceType,
} from "~/domain/translations/types";
import { TranslationsNav } from "~/web/components/translations-nav";
import { principalFromSession } from "~/web/lib/principal.server";
import {
  SYNC_KIND_LABEL,
  TRANSLATION_ROUTES,
  localeLabel,
} from "~/web/lib/translations";

/**
 * AI usage (docs/translations.md § AI usage): what the provider was asked,
 * what it answered with, and what that is estimated to cost — today, this
 * month, all time — broken down by language, model, kind of content and
 * sync.
 *
 * Every figure is a sum over `ai_usage` rows, one per request the provider
 * saw. Cost is always "estimated": the provider reports tokens, not money,
 * and the price per token is this app's table (`domain/translations/pricing`)
 * at the version each row was priced under.
 */
const PERIODS = ["today", "month", "all"] as const;
type Period = (typeof PERIODS)[number];

const PERIOD_LABEL: Record<Period, string> = {
  today: "Today",
  month: "This month",
  all: "All time",
};

function since(period: Period, now: Date): Date | null {
  if (period === "all") return null;
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  if (period === "month") start.setUTCDate(1);
  return start;
}

function serialise(totals: UsageTotals) {
  return {
    requests: totals.requests,
    inputTokens: totals.inputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    outputTokens: totals.outputTokens,
    totalTokens: totals.totalTokens,
    cost: formatMicrosUsd(totals.costMicros),
    unpriced: totals.unpriced,
    resources: totals.resources,
  };
}

function serialiseRows(rows: UsageBreakdownRow[]) {
  return rows.map((row) => ({
    key: row.key,
    requests: row.requests,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    cost: formatMicrosUsd(row.costMicros),
  }));
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const periodParam =
    new URL(request.url).searchParams.get("period") ?? "month";
  const period: Period = (PERIODS as readonly string[]).includes(periodParam)
    ? (periodParam as Period)
    : "month";
  const now = new Date();
  const from = since(period, now);

  const [today, month, all, byLocale, byModel, byType, bySync] =
    await Promise.all([
      usageTotals(principal, since("today", now)),
      usageTotals(principal, since("month", now)),
      usageTotals(principal, null),
      usageBreakdown(principal, "targetLocale", from),
      usageBreakdown(principal, "model", from),
      usageBreakdown(principal, "resourceType", from),
      usageBreakdown(principal, "syncId", from, 10),
    ]);
  const model = translationModel();

  return {
    period,
    totals: {
      today: serialise(today),
      month: serialise(month),
      all: serialise(all),
    },
    byLocale: serialiseRows(byLocale),
    byModel: serialiseRows(byModel),
    byType: serialiseRows(byType),
    bySync: serialiseRows(bySync),
    model,
    modelPriced: pricingFor(model) !== null,
    pricingVersion: PRICING_VERSION,
  };
};

export default function Usage() {
  const data = useLoaderData<typeof loader>();
  const current = data.totals[data.period];

  return (
    <s-page heading="AI usage">
      <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
        Translations
      </s-link>

      <s-stack direction="block" gap="large">
        <TranslationsNav current="usage" />

        {!data.modelPriced ? (
          <s-banner
            tone="warning"
            heading={`${data.model} is not in the pricing table`}
          >
            <s-paragraph>
              Tokens are recorded for every request, but no cost can be
              estimated for this model until its price is added to the table
              (version {data.pricingVersion}).
            </s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="Totals">
          <s-grid
            gridTemplateColumns="@container (inline-size <= 560px) 1fr, repeat(3, 1fr)"
            gap="base"
          >
            {PERIODS.map((period) => {
              const totals = data.totals[period];
              return (
                <s-box
                  key={period}
                  padding="base"
                  border="base"
                  borderRadius="base"
                  {...(period === data.period
                    ? { background: "subdued" as const }
                    : {})}
                >
                  <s-stack direction="block" gap="small-300">
                    {period === data.period ? (
                      <s-text type="strong">{PERIOD_LABEL[period]}</s-text>
                    ) : (
                      <s-link
                        href={`${TRANSLATION_ROUTES.usage}?period=${period}`}
                      >
                        {PERIOD_LABEL[period]}
                      </s-link>
                    )}
                    <s-heading>{totals.cost}</s-heading>
                    <s-text color="subdued">Estimated cost</s-text>
                    <s-text color="subdued">
                      {`${formatCount(totals.inputTokens)} in · ${formatCount(totals.outputTokens)} out · ${formatCount(totals.requests)} requests · ${formatCount(totals.resources)} resources`}
                    </s-text>
                  </s-stack>
                </s-box>
              );
            })}
          </s-grid>
        </s-section>

        <s-section heading={`${PERIOD_LABEL[data.period]} in detail`}>
          <s-stack direction="block" gap="base">
            <s-grid
              gridTemplateColumns="@container (inline-size <= 560px) 1fr 1fr, repeat(4, 1fr)"
              gap="base"
            >
              <Stat label="Translations" value={current.cost} />
              <Stat
                label="Input tokens"
                value={formatCount(current.inputTokens)}
              />
              <Stat
                label="Output tokens"
                value={formatCount(current.outputTokens)}
              />
              <Stat label="Resources" value={formatCount(current.resources)} />
            </s-grid>
            <s-text color="subdued">
              {`Estimated from list prices (pricing table ${data.pricingVersion}); the provider does not report billed cost. Retries and failed requests that reported usage are included; skipped translations never reach the provider and are not.${
                current.cachedInputTokens > 0
                  ? ` ${formatCount(current.cachedInputTokens)} input tokens were served from the provider's cache at its lower rate.`
                  : ""
              }${
                current.unpriced > 0
                  ? ` ${current.unpriced} requests used a model with no price in the table and are not in the cost.`
                  : ""
              }`}
            </s-text>
          </s-stack>
        </s-section>

        <s-grid
          gridTemplateColumns="@container (inline-size <= 720px) 1fr, 1fr 1fr"
          gap="large"
          alignItems="start"
        >
          <Breakdown
            heading="By language"
            rows={data.byLocale}
            name={(key) => (key ? localeLabel(key) : "—")}
          />
          <Breakdown
            heading="By content"
            rows={data.byType}
            name={(key) =>
              key && isResourceType(key)
                ? RESOURCE_TYPE_LABEL[key]
                : (key ?? "Language detection")
            }
          />
          <Breakdown
            heading="By model"
            rows={data.byModel}
            name={(key) => key ?? "—"}
          />
          <Breakdown
            heading="By sync"
            rows={data.bySync}
            name={(key) => (key ? `Sync ${key.slice(-6)}` : "Outside a sync")}
            href={(key) => (key ? TRANSLATION_ROUTES.sync(key) : null)}
          />
        </s-grid>

        <s-section heading="Syncs">
          <s-text color="subdued">
            {`Every request is attributed to the sync that made it, and every sync's page shows its own usage. ${SYNC_KIND_LABEL.resource} syncs are the editor's and the webhook's single-resource translations.`}
          </s-text>
        </s-section>
      </s-stack>
    </s-page>
  );
}

function Breakdown({
  heading,
  rows,
  name,
  href,
}: {
  heading: string;
  rows: Array<{
    key: string | null;
    requests: number;
    totalTokens: number;
    cost: string;
  }>;
  name: (key: string | null) => string;
  href?: (key: string | null) => string | null;
}) {
  return (
    <s-section heading={heading}>
      {rows.length === 0 ? (
        <s-text color="subdued">Nothing in this period.</s-text>
      ) : (
        <s-table variant="auto">
          <s-table-header-row>
            <s-table-header listSlot="primary">
              {heading.replace("By ", "")}
            </s-table-header>
            <s-table-header format="numeric">Tokens</s-table-header>
            <s-table-header format="numeric" listSlot="secondary">
              Estimated cost
            </s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((row) => {
              const link = href?.(row.key) ?? null;
              return (
                <s-table-row key={row.key ?? "none"}>
                  <s-table-cell>
                    {link ? (
                      <s-link href={link}>{name(row.key)}</s-link>
                    ) : (
                      <s-text>{name(row.key)}</s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>{formatCount(row.totalTokens)}</s-table-cell>
                  <s-table-cell>{row.cost}</s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>
      )}
    </s-section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <s-stack direction="block" gap="small-500">
      <s-text color="subdued">{label}</s-text>
      <s-heading>{value}</s-heading>
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
