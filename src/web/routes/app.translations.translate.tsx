import { boundary } from "@shopify/shopify-app-react-router/server";
import { useMemo, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";
import { z } from "zod";

import { isConfigured } from "~/adapters/ai/openai.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { isLocaleCode } from "~/adapters/shopify/translations";
import {
  requestCoverageRefresh,
  startSync,
} from "~/adapters/translations/syncs.server";
import { estimateRun, formatCount } from "~/domain/translations/estimate";
import { formatMicrosUsd } from "~/domain/translations/pricing";
import {
  ALL_CONTENT_GROUPS,
  CONTENT_GROUPS,
  SYNC_MODE_LABEL,
  isContentGroup,
  typesForGroups,
  type ContentGroup,
  type SyncMode,
} from "~/domain/translations/types";
import { TranslationsNav } from "~/web/components/translations-nav";
import { formatDateTime } from "~/web/lib/datetime";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { redirectWithin } from "~/web/lib/redirects";
import { TRANSLATION_ROUTES, localeLabel } from "~/web/lib/translations";
import { loadLanguagesOverview } from "~/web/lib/translations.server";

/**
 * Translate store (docs/translations.md § Translate store): the whole
 * catalogue into several languages at once, with an estimate before
 * anything starts.
 *
 * The estimate is computed from the coverage cache in the browser as the
 * choices change — the numbers are counts and characters already read — and
 * labelled with when the coverage was counted. Starting creates one sync,
 * which runs in the worker and shows its progress on its own page.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const overview = await loadLanguagesOverview(principal, admin);
  if (overview.kind === "unavailable") return overview;
  return {
    kind: "read" as const,
    primary: overview.primary
      ? { locale: overview.primary.locale, name: overview.primary.name }
      : null,
    languages: overview.rows
      .filter((row) => !row.primary)
      .map((row) => ({
        locale: row.locale,
        name: row.name,
        published: row.published,
        aiEnabled: row.settings?.aiEnabled ?? false,
        contentScope: row.settings?.contentScope ?? [...ALL_CONTENT_GROUPS],
      })),
    coverageRows: overview.coverageRows,
    coverageAt: overview.coverageAt,
    ai: overview.ai,
    activeSyncs: overview.activeSyncs,
  };
};

const formSchema = z.object({
  locales: z.array(z.string()).min(1),
  groups: z.array(z.string()).min(1),
  mode: z.enum(["missing", "missing_outdated", "force"]),
  estimate: z.unknown(),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "refresh-coverage") {
    const jobId = await requestCoverageRefresh(principal, 60);
    return {
      ok: true,
      message: jobId
        ? "Counting translations across the store."
        : "Already counting.",
    };
  }

  if (intent === "start") {
    if (!isConfigured())
      return {
        ok: false,
        message: "AI translation is not configured on this server.",
      };
    let json: unknown;
    try {
      json = JSON.parse(String(formData.get("form") ?? ""));
    } catch {
      return {
        ok: false,
        message: "The form could not be read. Reload the page and try again.",
      };
    }
    const parsed = formSchema.safeParse(json);
    if (!parsed.success)
      return {
        ok: false,
        message: "Choose at least one language and one kind of content.",
      };
    const locales = parsed.data.locales.filter(isLocaleCode);
    const groups = parsed.data.groups.filter(isContentGroup);
    if (locales.length === 0 || groups.length === 0)
      return {
        ok: false,
        message: "Choose at least one language and one kind of content.",
      };
    const sync = await startSync(principal, {
      kind: "translate_store",
      mode: parsed.data.mode,
      sourceLocale: "",
      targetLocales: locales,
      resourceTypes: typesForGroups(groups),
      estimate: JSON.parse(JSON.stringify(parsed.data.estimate ?? null)),
      requestedBy: actorFromSession(session),
    });
    throw redirectWithin(request, TRANSLATION_ROUTES.sync(sync.id));
  }
  return { ok: false, message: "Unknown action." };
};

export default function TranslateStore() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";

  const [locales, setLocales] = useState<string[]>(() =>
    data.kind === "read"
      ? data.languages.filter((l) => l.aiEnabled).map((l) => l.locale)
      : [],
  );
  const [groups, setGroups] = useState<ContentGroup[]>([...ALL_CONTENT_GROUPS]);
  const [mode, setMode] = useState<SyncMode>("missing");

  const estimate = useMemo(() => {
    if (data.kind !== "read") return null;
    return estimateRun({
      rows: data.coverageRows,
      locales,
      resourceTypes: typesForGroups(groups),
      mode,
      model: data.ai.model,
      coverageAt: data.coverageAt,
    });
  }, [data, locales, groups, mode]);

  if (data.kind === "unavailable") {
    return (
      <s-page heading="Translate store">
        <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
          Translations
        </s-link>
        <s-banner
          tone="warning"
          heading="Languages could not be read from Shopify"
        >
          <s-paragraph>{data.reason}</s-paragraph>
        </s-banner>
      </s-page>
    );
  }

  const canStart =
    data.ai.configured &&
    locales.length > 0 &&
    groups.length > 0 &&
    !busy &&
    estimate !== null;
  const start = () =>
    fetcher.submit(
      {
        intent: "start",
        form: JSON.stringify({ locales, groups, mode, estimate }),
      },
      { method: "post" },
    );

  return (
    <s-page heading="Translate store" inlineSize="base">
      <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
        Translations
      </s-link>

      <s-stack direction="block" gap="large">
        <TranslationsNav current="languages" />

        {fetcher.data && !fetcher.data.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{fetcher.data.message}</s-paragraph>
          </s-banner>
        ) : null}
        {!data.ai.configured ? (
          <s-banner
            tone="warning"
            heading="AI translation is not configured on this server"
          >
            <s-paragraph>
              Set OPENAI_API_KEY in the server environment to translate with AI.
            </s-paragraph>
          </s-banner>
        ) : null}
        {data.activeSyncs > 0 ? (
          <s-banner tone="info" heading="A sync is already running">
            <s-paragraph>
              Starting another is allowed; both write only what the other has
              not. Watch them under Syncs.
            </s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="1. Source">
          <s-text>
            {data.primary
              ? `${localeLabel(data.primary.locale, data.primary.name)} — the store's default language. A resource written in another language, as set in the editor, is translated from that language directly.`
              : "Shopify reports no default language."}
          </s-text>
        </s-section>

        <s-section heading="2. Languages">
          <s-stack direction="block" gap="small-300">
            {data.languages.length === 0 ? (
              <s-text color="subdued">
                No other languages yet. Add one first.
              </s-text>
            ) : null}
            {data.languages.map((language) => (
              <s-checkbox
                key={language.locale}
                label={localeLabel(language.locale, language.name)}
                details={[
                  language.published ? "Published" : "Unpublished",
                  language.aiEnabled
                    ? "AI on"
                    : "AI off — its overwrite policy still applies",
                ].join(" · ")}
                checked={locales.includes(language.locale)}
                onChange={(event) =>
                  setLocales((now) =>
                    event.currentTarget.checked
                      ? [...now, language.locale]
                      : now.filter((l) => l !== language.locale),
                  )
                }
                {...(busy ? { disabled: true } : {})}
              />
            ))}
          </s-stack>
        </s-section>

        <s-section heading="3. Content">
          <s-stack direction="block" gap="small-300">
            {ALL_CONTENT_GROUPS.map((group) => (
              <s-checkbox
                key={group}
                label={CONTENT_GROUPS[group].label}
                checked={groups.includes(group)}
                onChange={(event) =>
                  setGroups((now) =>
                    event.currentTarget.checked
                      ? [...new Set([...now, group])]
                      : now.filter((g) => g !== group),
                  )
                }
                {...(busy ? { disabled: true } : {})}
              />
            ))}
          </s-stack>
        </s-section>

        <s-section heading="4. Mode">
          <s-choice-list
            label="What to translate"
            labelAccessibilityVisibility="exclusive"
            name="mode"
            values={[mode]}
            onChange={(event) => {
              const next = event.currentTarget.values[0];
              if (
                next === "missing" ||
                next === "missing_outdated" ||
                next === "force"
              )
                setMode(next);
            }}
            {...(busy ? { disabled: true } : {})}
          >
            <s-choice value="missing">
              {SYNC_MODE_LABEL.missing}
              <s-text slot="details">
                Fields with no translation yet. Nothing existing is touched.
              </s-text>
            </s-choice>
            <s-choice value="missing_outdated">
              {SYNC_MODE_LABEL.missing_outdated}
              <s-text slot="details">
                Also translations Shopify marks outdated, within each
                language&apos;s overwrite policy.
              </s-text>
            </s-choice>
            <s-choice value="force">
              {SYNC_MODE_LABEL.force}
              <s-text slot="details">
                Every field in scope goes to the AI again. Human translations
                are still protected unless a language allows overwriting them.
              </s-text>
            </s-choice>
          </s-choice-list>
        </s-section>

        <s-section heading="Estimate">
          <s-stack direction="block" gap="base">
            {estimate === null || data.coverageAt === null ? (
              <s-stack direction="block" gap="small-300">
                <s-text color="subdued">
                  Coverage has not been counted yet, so there is nothing to
                  estimate from.
                </s-text>
                <s-stack direction="inline">
                  <s-button
                    type="button"
                    onClick={() =>
                      fetcher.submit(
                        { intent: "refresh-coverage" },
                        { method: "post" },
                      )
                    }
                    {...(busy ? { disabled: true } : {})}
                  >
                    Count coverage
                  </s-button>
                </s-stack>
              </s-stack>
            ) : (
              <>
                <s-grid
                  gridTemplateColumns="@container (inline-size <= 560px) 1fr 1fr, repeat(4, 1fr)"
                  gap="base"
                >
                  <Stat
                    label="Resources"
                    value={formatCount(estimate.resources)}
                  />
                  <Stat label="Fields" value={formatCount(estimate.fields)} />
                  <Stat
                    label="Estimated tokens"
                    value={formatCount(estimate.totalTokens)}
                  />
                  <Stat
                    label="Estimated cost"
                    value={
                      estimate.priced
                        ? formatMicrosUsd(estimate.costMicros)
                        : "Not priced"
                    }
                  />
                </s-grid>
                {estimate.perLocale.length > 1 ? (
                  <s-text color="subdued">
                    {estimate.perLocale
                      .map(
                        (row) =>
                          `${localeLabel(row.locale)}: ${formatCount(row.fields)} fields, ${estimate.priced ? formatMicrosUsd(row.costMicros) : "—"}`,
                      )
                      .join(" · ")}
                  </s-text>
                ) : null}
                <s-text color="subdued">
                  {`From coverage counted ${formatDateTime(data.coverageAt)}, with ${data.ai.model}. ${
                    estimate.priced
                      ? "Cost is estimated from the model's list price; the provider's own figures are recorded as the sync runs."
                      : `${data.ai.model} is not in the pricing table, so no cost can be estimated. Tokens are still recorded.`
                  }`}
                </s-text>
              </>
            )}
            <s-stack direction="inline" gap="small-300">
              <s-button
                type="button"
                variant="primary"
                onClick={start}
                {...(!canStart ? { disabled: true } : {})}
                {...(busy ? { loading: true } : {})}
              >
                Start translation
              </s-button>
              <s-button
                type="button"
                onClick={() =>
                  fetcher.submit(
                    { intent: "refresh-coverage" },
                    { method: "post" },
                  )
                }
                {...(busy ? { disabled: true } : {})}
              >
                Count coverage again
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
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
