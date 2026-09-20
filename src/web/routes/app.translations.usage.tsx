import { boundary } from "@shopify/shopify-app-react-router/server";
import { useMemo, useState, type ReactNode } from "react";
import {
  useLoaderData,
  useNavigation,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { translationModel } from "~/adapters/ai/openai.server";
import {
  syncSummaries,
  usageBreakdown,
  usageTotals,
  usageTrend,
  type UsageBreakdownRow,
} from "~/adapters/db/repositories/translations.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { formatCount } from "~/domain/translations/estimate";
import {
  PRICING_VERSION,
  formatMicrosUsd,
  pricingFor,
} from "~/domain/translations/pricing";
import { describeLanguage } from "~/domain/translations/languages";
import {
  RESOURCE_TYPE_LABEL,
  SYNC_MODE_LABEL,
  isResourceType,
  type SyncMode,
} from "~/domain/translations/types";
import {
  USAGE_PERIODS,
  USAGE_PERIOD_LABEL,
  formatShare,
  isUsagePeriod,
  sharePercent,
  trendBucketFor,
  type UsagePeriod,
} from "~/domain/translations/usage";
import { LocaleFlag } from "~/web/components/locale-flag";
import { TranslationsNav } from "~/web/components/translations-nav";
import { UsageTrend } from "~/web/components/usage-trend";
import { formatDateTime } from "~/web/lib/datetime";
import { principalFromSession } from "~/web/lib/principal.server";
import {
  SYNC_KIND_LABEL,
  TRANSLATION_ROUTES,
} from "~/web/lib/translations";
import { fillTrend, usagePeriodStart } from "~/web/lib/usage";

/**
 * AI usage (docs/translations.md § AI usage): what the provider was asked,
 * what it answered with, and what that is estimated to cost — for one
 * period at a time, this month by default — as a row of figures, a trend
 * and four breakdowns: by language, content, model and sync.
 *
 * Every figure is a sum over `ai_usage` rows, one per request the provider
 * saw. Cost is always "estimated": the provider reports tokens, not money,
 * and the price per token is this app's table (`domain/translations/pricing`)
 * at the version each row was priced under. The sums are the repository's;
 * this page only decides the period and the shape.
 */
const ESTIMATE_TIP_ID = "usage-estimate-tip";

interface BreakdownRowView {
  key: string | null;
  name: string;
  detail: string | null;
  href: string | null;
  /** The region whose flag stands beside a language row. */
  flag: { regionCode: string | null; regionName: string | null } | null;
  requests: number;
  totalTokens: number;
  cost: string;
  /** Micro-USD as a number, for sorting; bigint does not survive the loader. */
  costMicros: number;
  /** Of the period's estimated cost; null when nothing in it is priced. */
  share: number | null;
}

function serialiseRows(
  rows: UsageBreakdownRow[],
  totalCostMicros: bigint,
  describe: (
    key: string | null,
  ) => Pick<BreakdownRowView, "name" | "detail" | "href"> &
    Partial<Pick<BreakdownRowView, "flag">>,
): BreakdownRowView[] {
  return rows.map((row) => ({
    key: row.key,
    flag: null,
    ...describe(row.key),
    requests: row.requests,
    totalTokens: row.totalTokens,
    cost: formatMicrosUsd(row.costMicros),
    costMicros: Number(row.costMicros),
    share: sharePercent(row.costMicros, totalCostMicros),
  }));
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const periodParam =
    new URL(request.url).searchParams.get("period") ?? "month";
  const period: UsagePeriod = isUsagePeriod(periodParam) ? periodParam : "month";
  const now = new Date();
  const from = usagePeriodStart(period, now);
  const bucket = trendBucketFor(period);

  const [totals, byLocale, byModel, byType, bySync, trend] = await Promise.all([
    usageTotals(principal, from),
    usageBreakdown(principal, "targetLocale", from),
    usageBreakdown(principal, "model", from),
    usageBreakdown(principal, "resourceType", from),
    usageBreakdown(principal, "syncId", from, 10),
    bucket ? usageTrend(principal, from, bucket) : Promise.resolve([]),
  ]);
  const syncs = await syncSummaries(
    principal,
    bySync.flatMap((row) => (row.key ? [row.key] : [])),
  );
  const syncById = new Map(syncs.map((sync) => [sync.id, sync]));
  const model = translationModel();

  return {
    period,
    totals: {
      requests: totals.requests,
      inputTokens: totals.inputTokens,
      cachedInputTokens: totals.cachedInputTokens,
      outputTokens: totals.outputTokens,
      totalTokens: totals.totalTokens,
      cost: formatMicrosUsd(totals.costMicros),
      unpriced: totals.unpriced,
      resources: totals.resources,
    },
    trend: bucket
      ? fillTrend(
          trend.map((row) => ({
            at: row.at.toISOString(),
            requests: row.requests,
            totalTokens: row.totalTokens,
            costMicros: row.costMicros,
          })),
          bucket,
          from,
          now,
        ).map((point) => ({ ...point, costMicros: point.costMicros.toString() }))
      : [],
    bucket,
    byLocale: serialiseRows(byLocale, totals.costMicros, (key) => {
      if (!key) return { name: "—", detail: null, href: null };
      const language = describeLanguage(key);
      return {
        name: language.name,
        detail: key,
        href: TRANSLATION_ROUTES.language(key),
        flag: {
          regionCode: language.regionCode,
          regionName: language.regionName,
        },
      };
    }),
    byType: serialiseRows(byType, totals.costMicros, (key) => ({
      name:
        key && isResourceType(key)
          ? RESOURCE_TYPE_LABEL[key]
          : (key ?? "Language detection"),
      detail: null,
      href: null,
    })),
    byModel: serialiseRows(byModel, totals.costMicros, (key) => ({
      name: key ?? "—",
      detail: key && pricingFor(key) === null ? "Not in the pricing table" : null,
      href: null,
    })),
    bySync: serialiseRows(bySync, totals.costMicros, (key) => {
      const sync = key ? syncById.get(key) : undefined;
      if (!sync) {
        return {
          name: key ? "Sync no longer exists" : "Outside a sync",
          detail: key ? null : "Language detection",
          href: null,
        };
      }
      const mode = SYNC_MODE_LABEL[sync.mode as SyncMode] ?? sync.mode;
      return {
        name: `${SYNC_KIND_LABEL[sync.kind] ?? sync.kind} · ${formatDateTime(sync.createdAt.toISOString())}`,
        detail: `${mode} · ${sync.targetLocales.join(", ")} · ${formatCount(sync.doneResources)} resources`,
        href: TRANSLATION_ROUTES.sync(sync.id),
      };
    }),
    model,
    modelPriced: pricingFor(model) !== null,
    pricingVersion: PRICING_VERSION,
  };
};

export default function Usage() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const pending = navigation.location
    ? new URL(navigation.location.search || "?", "http://x").searchParams.get(
        "period",
      )
    : null;
  const { totals } = data;
  const empty = totals.requests === 0;
  const periodLabel = USAGE_PERIOD_LABEL[data.period];

  return (
    <s-page heading="AI usage">
      <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
        Translations
      </s-link>

      <s-stack direction="block" gap="base">
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

        {/* The period on the right, the caveat on the left: one line each. */}
        <s-grid
          gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr auto"
          gap="base"
          alignItems="center"
        >
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-text color="subdued">
              Costs are estimates from list prices. Retries and failed
              requests that reported usage are included.
            </s-text>
            <s-icon
              type="info"
              color="subdued"
              interestFor={ESTIMATE_TIP_ID}
            />
            <s-tooltip id={ESTIMATE_TIP_ID}>
              {`The provider reports tokens, not money; each request is priced under pricing table ${data.pricingVersion} at the time it was made. Cached input tokens are priced at the provider's lower rate. Skipped translations never reach the provider and are not counted.`}
            </s-tooltip>
          </s-stack>
          <s-button-group accessibilityLabel="Reporting period">
            {USAGE_PERIODS.map((period) => (
              <s-button
                key={period}
                href={`${TRANSLATION_ROUTES.usage}?period=${period}`}
                variant={period === data.period ? "secondary" : "tertiary"}
                {...(pending === period ? { loading: true } : {})}
              >
                {USAGE_PERIOD_LABEL[period]}
              </s-button>
            ))}
          </s-button-group>
        </s-grid>

        <s-section padding="base" accessibilityLabel={`${periodLabel} at a glance`}>
          <s-grid
            gridTemplateColumns="@container (inline-size <= 640px) 1fr 1fr, 1fr auto 1fr auto 1fr auto 1fr auto 1fr"
            gap="base"
            alignItems="start"
          >
            <Metric
              label="Estimated cost"
              value={totals.cost}
              detail={
                totals.unpriced > 0
                  ? `${formatCount(totals.unpriced)} requests unpriced`
                  : `${formatCount(totals.totalTokens)} tokens`
              }
              tone={totals.unpriced > 0 ? "warning" : undefined}
            />
            <MetricDivider />
            <Metric
              label="Input tokens"
              value={formatCount(totals.inputTokens)}
              detail={
                totals.cachedInputTokens > 0
                  ? `${formatCount(totals.cachedInputTokens)} from cache`
                  : null
              }
            />
            <MetricDivider />
            <Metric
              label="Output tokens"
              value={formatCount(totals.outputTokens)}
              detail={
                totals.totalTokens > 0
                  ? `${formatShare(sharePercent(totals.outputTokens, totals.totalTokens))} of tokens`
                  : null
              }
            />
            <MetricDivider />
            <Metric label="Requests" value={formatCount(totals.requests)} />
            <MetricDivider />
            <Metric
              label="Resources translated"
              value={formatCount(totals.resources)}
            />
          </s-grid>
        </s-section>

        {empty ? (
          <s-section accessibilityLabel="No usage">
            <s-stack direction="block" gap="small-300" alignItems="start">
              <s-text type="strong">
                {data.period === "all"
                  ? "No AI requests yet."
                  : `No AI requests ${periodLabel.toLowerCase()}.`}
              </s-text>
              <s-text color="subdued">
                Usage appears here as soon as a translation reaches the
                provider.
              </s-text>
              {data.period === "all" ? (
                <s-button variant="secondary" href={TRANSLATION_ROUTES.translate}>
                  Translate store
                </s-button>
              ) : (
                <s-link href={`${TRANSLATION_ROUTES.usage}?period=all`}>
                  Show all time
                </s-link>
              )}
            </s-stack>
          </s-section>
        ) : (
          <>
            {data.bucket && data.trend.length > 1 ? (
              <s-section
                heading={
                  data.bucket === "day" ? "Cost by day" : "Cost by month"
                }
              >
                <UsageTrend points={data.trend} bucket={data.bucket} />
              </s-section>
            ) : null}

            <s-grid
              gridTemplateColumns="@container (inline-size <= 760px) 1fr, 1fr 1fr"
              gap="base"
              alignItems="start"
            >
              <Breakdown heading="By language" column="Language" rows={data.byLocale} />
              <Breakdown heading="By content type" column="Content" rows={data.byType} />
              <Breakdown heading="By model" column="Model" rows={data.byModel} />
              <Breakdown
                heading="By sync"
                column="Sync"
                rows={data.bySync}
                footer="The ten syncs with the most tokens in this period. Every sync's own page shows its full usage."
              />
            </s-grid>
          </>
        )}
      </s-stack>
    </s-page>
  );
}

function Metric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string | null;
  tone?: "warning";
}) {
  return (
    <s-stack direction="block" gap="small-500">
      <s-text color="subdued">{label}</s-text>
      <s-heading accessibilityRole="presentation">{value}</s-heading>
      {detail ? (
        <s-text
          color={tone ? "base" : "subdued"}
          {...(tone ? { tone } : {})}
        >
          {detail}
        </s-text>
      ) : null}
    </s-stack>
  );
}

/** A rule between metrics on a wide card; on a narrow one the grid wraps instead. */
function MetricDivider() {
  return (
    <s-box display="@container (inline-size <= 640px) none, auto">
      <s-divider direction="block" />
    </s-box>
  );
}

type SortKey = "totalTokens" | "requests" | "costMicros";

const SORT_COLUMNS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "totalTokens", label: "Tokens" },
  { key: "requests", label: "Requests" },
  { key: "costMicros", label: "Est. cost" },
];

/**
 * One breakdown: a card with a table of name, tokens, requests, cost and
 * share of the period's cost. The numeric columns sort on click; the server
 * already orders by tokens, so that is the opening sort.
 */
function Breakdown({
  heading,
  column,
  rows,
  footer,
}: {
  heading: string;
  column: string;
  rows: BreakdownRowView[];
  footer?: string;
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: "totalTokens",
    desc: true,
  });
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) =>
        sort.desc ? b[sort.key] - a[sort.key] : a[sort.key] - b[sort.key],
      ),
    [rows, sort],
  );
  const toggle = (key: SortKey) =>
    setSort((now) =>
      now.key === key ? { key, desc: !now.desc } : { key, desc: true },
    );

  return (
    <s-section heading={heading}>
      {rows.length === 0 ? (
        <s-text color="subdued">Nothing in this period.</s-text>
      ) : (
        <s-stack direction="block" gap="small-300">
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">{column}</s-table-header>
              {SORT_COLUMNS.map((col) => (
                <s-table-header
                  key={col.key}
                  format="numeric"
                  {...(col.key === "costMicros"
                    ? { listSlot: "secondary" as const }
                    : {})}
                >
                  <SortHeader
                    label={col.label}
                    active={sort.key === col.key}
                    desc={sort.desc}
                    onClick={() => toggle(col.key)}
                  />
                </s-table-header>
              ))}
              <s-table-header format="numeric">Share</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {sorted.map((row) => (
                <s-table-row
                  key={row.key ?? "none"}
                  {...(row.href ? { clickDelegate: `open-${row.key}` } : {})}
                >
                  <s-table-cell>
                    <s-grid
                      gridTemplateColumns={row.flag ? "auto 1fr" : "1fr"}
                      gap="small-300"
                      alignItems="center"
                    >
                      {row.flag ? (
                        <LocaleFlag
                          regionCode={row.flag.regionCode}
                          regionName={row.flag.regionName}
                        />
                      ) : null}
                      <s-stack direction="block" gap="small-500">
                        {row.href ? (
                          <s-link id={`open-${row.key}`} href={row.href}>
                            {row.name}
                          </s-link>
                        ) : (
                          <s-text>{row.name}</s-text>
                        )}
                        {row.detail ? (
                          <s-text color="subdued">{row.detail}</s-text>
                        ) : null}
                      </s-stack>
                    </s-grid>
                  </s-table-cell>
                  <s-table-cell>
                    <Num>{formatCount(row.totalTokens)}</Num>
                  </s-table-cell>
                  <s-table-cell>
                    <Num>{formatCount(row.requests)}</Num>
                  </s-table-cell>
                  <s-table-cell>
                    <Num>{row.cost}</Num>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text color="subdued" fontVariantNumeric="tabular-nums">
                      {formatShare(row.share)}
                    </s-text>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          {footer ? <s-text color="subdued">{footer}</s-text> : null}
        </s-stack>
      )}
    </s-section>
  );
}

function SortHeader({
  label,
  active,
  desc,
  onClick,
}: {
  label: string;
  active: boolean;
  desc: boolean;
  onClick: () => void;
}) {
  return (
    <s-link
      tone="neutral"
      accessibilityLabel={`Sort by ${label.toLowerCase()}${active ? `, ${desc ? "largest" : "smallest"} first` : ""}`}
      onClick={onClick}
    >
      {active ? `${label} ${desc ? "↓" : "↑"}` : label}
    </s-link>
  );
}

function Num({ children }: { children: ReactNode }) {
  return <s-text fontVariantNumeric="tabular-nums">{children}</s-text>;
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
