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

import { isConfigured, translationModel } from "~/adapters/ai/openai.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  getCoverage,
  saveLanguageSettings,
} from "~/adapters/db/repositories/translations.server";
import {
  enableShopLocale,
  listAvailableLocales,
  listMarkets,
  listShopLocales,
  updateShopLocale,
} from "~/adapters/shopify/locales";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { isLocaleCode } from "~/adapters/shopify/translations";
import {
  requestCoverageRefresh,
  startSync,
} from "~/adapters/translations/syncs.server";
import { totalsFor } from "~/domain/translations/coverage";
import {
  coverageForNewLocale,
  estimateRun,
  formatCount,
} from "~/domain/translations/estimate";
import { describeLanguage } from "~/domain/translations/languages";
import { formatMicrosUsd } from "~/domain/translations/pricing";
import {
  ALL_CONTENT_GROUPS,
  CONTENT_GROUPS,
  typesForGroups,
} from "~/domain/translations/types";
import {
  AiTranslationSettings,
  type AiTranslationValue,
} from "~/web/components/ai-translation-settings";
import { LanguageLabel } from "~/web/components/language-label";
import {
  LanguagePicker,
  type ConfiguredLanguage,
} from "~/web/components/language-picker";
import { ToggleRow } from "~/web/components/toggle-row";
import { TranslationsNav } from "~/web/components/translations-nav";
import { formatDateTime } from "~/web/lib/datetime";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { redirectWithin } from "~/web/lib/redirects";
import {
  TRANSLATION_ROUTES,
  aiStateLabel,
  shopifyStateLabel,
} from "~/web/lib/translations";

/**
 * Add language (docs/translations.md § Add language): choose one of the
 * locales Shopify supports, enable it in Shopify, say what the AI should do
 * for it, and optionally publish it and translate what exists.
 *
 * One card of settings and a sidebar that answers them: what was chosen,
 * what Shopify and the AI will do, and — when existing content is to be
 * translated — how much of it there is and roughly what it costs, from the
 * coverage cache. The one button lives in the sidebar with the reason it
 * is closed.
 *
 * The locale is created by `shopLocaleEnable`; nothing is written here
 * until Shopify has answered. Our settings row follows, and an initial sync
 * if asked. Publishing is a separate Shopify call, so a language whose
 * translation has not started is never visible to shoppers by accident.
 *
 * A language Shopify has just enabled holds no translations at all —
 * Shopify deletes them when a locale is removed — so "missing" and
 * "missing and outdated" would translate exactly the same fields here. The
 * form offers the choice that exists: translate what the store has now, or
 * not yet. The language's own page has the three modes once there is
 * something to distinguish.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const [available, enabled, markets, coverage] = await Promise.all([
    listAvailableLocales(admin),
    listShopLocales(admin),
    listMarkets(admin),
    getCoverage(principal),
  ]);
  const enabledLocales = enabled.kind === "read" ? enabled.locales : [];
  const taken = new Set(enabledLocales.map((locale) => locale.locale));
  const primary = enabledLocales.find((locale) => locale.primary) ?? null;

  return {
    available: available
      .filter((locale) => !taken.has(locale.isoCode))
      .map((locale) => describeLanguage(locale.isoCode, locale.name)),
    configured: enabledLocales.map((locale): ConfiguredLanguage => ({
      ...describeLanguage(locale.locale, locale.name),
      href: TRANSLATION_ROUTES.language(locale.locale),
      state: shopifyStateLabel(locale),
    })),
    primary: primary ? { locale: primary.locale, name: primary.name } : null,
    presences:
      markets.kind === "read"
        ? markets.markets.flatMap((market) =>
            market.presences.map((presence) => ({
              id: presence.id,
              market: market.name,
              label: presence.label,
              defaultLocale: presence.defaultLocale,
            })),
          )
        : [],
    coverageRows: coverage.rows,
    coverageAt: coverage.readAt?.toISOString() ?? null,
    ai: { configured: isConfigured(), model: translationModel() },
  };
};

const formSchema = z.object({
  locale: z.string().trim().min(2),
  publish: z.boolean(),
  presenceIds: z.array(z.string()),
  aiEnabled: z.boolean(),
  autoTranslateNew: z.boolean(),
  autoUpdateOutdated: z.boolean(),
  initial: z.enum(["none", "missing", "missing_outdated"]),
});

type SaveResult = { ok: false; message: string };

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<SaveResult> => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);

  let json: unknown;
  try {
    json = JSON.parse(String((await request.formData()).get("form") ?? ""));
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
      message: "The form could not be read. Reload the page and try again.",
    };
  const form = parsed.data;
  if (!isLocaleCode(form.locale))
    return { ok: false, message: "Choose a language from the list." };

  const enabled = await enableShopLocale(admin, form.locale, form.presenceIds);
  if (enabled.kind === "rejected")
    return {
      ok: false,
      message: `Shopify did not add the language: ${enabled.messages.join("; ")}`,
    };

  let publishFailed: string | null = null;
  if (form.publish) {
    const published = await updateShopLocale(admin, form.locale, {
      published: true,
    });
    if (published.kind === "rejected")
      publishFailed = published.messages.join("; ");
  }

  await saveLanguageSettings(principal, {
    locale: form.locale,
    aiEnabled: form.aiEnabled,
    autoTranslateNew: form.aiEnabled && form.autoTranslateNew,
    autoUpdateOutdated: form.aiEnabled && form.autoUpdateOutdated,
    contentScope: [...ALL_CONTENT_GROUPS],
    overwritePolicy: "update_ai_managed",
  });
  await appendEvent(principal, {
    entityType: "translation_language",
    entityId: form.locale,
    event: "translation_language.added",
    detail: {
      published: form.publish && !publishFailed,
      presences: form.presenceIds.length,
      aiEnabled: form.aiEnabled,
      by: actor,
    },
  });
  await requestCoverageRefresh(principal, 60);

  if (form.initial !== "none" && form.aiEnabled && isConfigured()) {
    const sync = await startSync(principal, {
      kind: "language",
      mode: form.initial,
      // The sync reads the store's primary locale from Shopify itself.
      sourceLocale: "",
      targetLocales: [form.locale],
      resourceTypes: typesForGroups([...ALL_CONTENT_GROUPS]),
      requestedBy: actor,
    });
    throw redirectWithin(request, TRANSLATION_ROUTES.sync(sync.id));
  }

  if (publishFailed) {
    // The language exists and its settings are saved; only publishing failed.
    // The language page says so and offers the button again.
    throw redirectWithin(
      request,
      `${TRANSLATION_ROUTES.language(form.locale)}?notice=${encodeURIComponent(`Added, but not published: ${publishFailed}`)}`,
    );
  }
  throw redirectWithin(
    request,
    `${TRANSLATION_ROUTES.language(form.locale)}?added=1`,
  );
};

type Initial = "none" | "missing";

const INITIAL_LABEL: Record<Initial, string> = {
  none: "Not translated now",
  missing: "Translated now",
};

export default function AddLanguage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [locale, setLocale] = useState<string | null>(null);
  const [publish, setPublish] = useState(false);
  const [presenceIds, setPresenceIds] = useState<string[]>([]);
  const [ai, setAi] = useState<AiTranslationValue>({
    aiEnabled: data.ai.configured,
    autoTranslateNew: true,
    autoUpdateOutdated: true,
  });
  const [initial, setInitial] = useState<Initial>("none");

  const chosen = useMemo(
    () => data.available.find((item) => item.locale === locale) ?? null,
    [data.available, locale],
  );
  const busy = fetcher.state !== "idle";
  const translatesNow =
    ai.aiEnabled && data.ai.configured && initial === "missing";

  // Every field of every resource, none of it translated yet: the coverage
  // of a language the store does not have, from the rows of one it does.
  const scope = useMemo(() => {
    if (!chosen || data.coverageAt === null) return null;
    const rows = coverageForNewLocale(data.coverageRows, chosen.locale);
    if (rows.length === 0) return null;
    const groups = ALL_CONTENT_GROUPS.map((group) => ({
      group,
      label: CONTENT_GROUPS[group].label,
      ...totalsFor(rows, chosen.locale, [...CONTENT_GROUPS[group].types]),
    })).filter((row) => row.fields > 0);
    const estimate = estimateRun({
      rows,
      locales: [chosen.locale],
      resourceTypes: typesForGroups([...ALL_CONTENT_GROUPS]),
      mode: "missing",
      model: data.ai.model,
      coverageAt: data.coverageAt,
    });
    return { groups, estimate, coverageAt: data.coverageAt };
  }, [chosen, data.coverageAt, data.coverageRows, data.ai.model]);

  const submit = () => {
    if (!locale || busy) return;
    fetcher.submit(
      {
        form: JSON.stringify({
          locale,
          publish,
          presenceIds,
          aiEnabled: ai.aiEnabled,
          autoTranslateNew: ai.autoTranslateNew,
          autoUpdateOutdated: ai.autoUpdateOutdated,
          initial: translatesNow ? "missing" : "none",
        }),
      },
      { method: "post" },
    );
  };

  return (
    <s-page heading="Add language" inlineSize="base">
      <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
        Translations
      </s-link>

      <s-stack direction="block" gap="large">
        <TranslationsNav current="languages" />

        {fetcher.data && !fetcher.data.ok ? (
          <s-banner tone="critical" heading="The language was not added">
            <s-paragraph>{fetcher.data.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section>
          <s-stack direction="block" gap="large">
            <s-stack direction="block" gap="small-300">
              <LanguagePicker
                label="Language"
                languages={data.available}
                configured={data.configured}
                value={locale}
                onChange={setLocale}
                disabled={busy}
              />
              <s-text color="subdued">
                {data.primary
                  ? `Shopify's list of languages a store can have. The AI translates from ${data.primary.name} (${data.primary.locale}), the store's default language.`
                  : "Shopify's list of languages a store can have."}
              </s-text>
            </s-stack>

            <s-divider />

            <s-stack direction="block" gap="base">
              <s-heading>Shopify visibility</s-heading>
              <ToggleRow
                label="Publish language"
                description="Make this language available to shoppers as soon as it is added. Shopify adds a language unpublished; leave this off to translate first and publish from the language's page when it reads well."
                checked={publish}
                onChange={setPublish}
                disabled={busy}
              />
              {data.presences.length > 0 ? (
                <s-stack direction="block" gap="small-400">
                  <s-text type="strong">Available in</s-text>
                  <s-text color="subdued">
                    Which markets serve this language. A market not ticked keeps
                    its own languages; this can be changed later.
                  </s-text>
                  {data.presences.map((presence) => (
                    <s-checkbox
                      key={presence.id}
                      label={`${presence.market} · ${presence.label}`}
                      details={`Default language ${presence.defaultLocale}`}
                      checked={presenceIds.includes(presence.id)}
                      onChange={(event) =>
                        setPresenceIds((now) =>
                          event.currentTarget.checked
                            ? [...now, presence.id]
                            : now.filter((id) => id !== presence.id),
                        )
                      }
                      {...(busy ? { disabled: true } : {})}
                    />
                  ))}
                </s-stack>
              ) : null}
            </s-stack>

            <s-divider />

            <s-stack direction="block" gap="base">
              <s-heading>AI translation</s-heading>
              <AiTranslationSettings
                value={ai}
                onChange={(patch) => setAi((now) => ({ ...now, ...patch }))}
                configured={data.ai.configured}
                disabled={busy || !data.ai.configured}
              />
            </s-stack>

            <s-divider />

            <s-stack direction="block" gap="base">
              <s-heading>Existing content</s-heading>
              <s-choice-list
                label="What happens to the content the store already has"
                labelAccessibilityVisibility="exclusive"
                name="initial"
                values={[initial]}
                onChange={(event) => {
                  const value = event.currentTarget.values[0];
                  if (value === "none" || value === "missing")
                    setInitial(value);
                }}
                {...(busy || !ai.aiEnabled || !data.ai.configured
                  ? { disabled: true }
                  : {})}
              >
                <s-choice value="none">
                  Don&apos;t translate existing content
                  <s-text slot="details">
                    Only content created or changed from now on is handled, as
                    set under AI translation. Translate the rest whenever you
                    like from the language&apos;s page.
                  </s-text>
                </s-choice>
                <s-choice value="missing">
                  Translate existing content now
                  <s-text slot="details">
                    Every product, collection, page, article, menu and metafield
                    is translated as soon as the language is added. You can
                    watch and stop the sync; its cost is recorded under AI
                    usage.
                  </s-text>
                </s-choice>
              </s-choice-list>
              <s-text color="subdued">
                {!data.ai.configured
                  ? "Existing content can be translated once AI translation is configured on this server."
                  : !ai.aiEnabled
                    ? "Turn on AI translation to translate existing content."
                    : "A translation you write or correct yourself is never replaced by the AI on a later run."}
              </s-text>
            </s-stack>
          </s-stack>
        </s-section>
      </s-stack>

      {/*
       * Sidebar: what has been chosen and what it comes to, beside the form
       * as it scrolls, with the one action that moves it on. Layout only —
       * every colour and space is Polaris's.
       */}
      <div
        slot="aside"
        style={{
          position: "sticky",
          top: "1rem",
          maxHeight: "calc(100vh - 2rem)",
          overflowY: "auto",
        }}
      >
        <s-stack direction="block" gap="base">
          <s-section heading="Summary">
            <s-stack direction="block" gap="base">
              {chosen ? (
                <LanguageLabel language={chosen} size="large" />
              ) : (
                <s-text color="subdued">No language chosen yet.</s-text>
              )}

              <s-stack direction="block" gap="small-300">
                <SummaryLine
                  label="Shopify"
                  value={publish ? "Published" : "Unpublished"}
                />
                <SummaryLine
                  label="AI translation"
                  value={aiStateLabel({ primary: false }, ai)}
                />
                <SummaryLine
                  label="Existing content"
                  value={INITIAL_LABEL[translatesNow ? "missing" : "none"]}
                />
              </s-stack>

              {translatesNow ? (
                <>
                  <s-divider />
                  <s-stack direction="block" gap="small-300">
                    <s-text type="strong">Estimated scope</s-text>
                    {scope === null ? (
                      <s-text color="subdued">
                        {data.coverageAt === null
                          ? "The store's content has not been counted yet, so there is no estimate. The sync's page shows what it covers and costs as it runs."
                          : "Nothing to translate was counted. The sync's page shows what it covers as it runs."}
                      </s-text>
                    ) : (
                      <>
                        {scope.groups.map((row) => (
                          <SummaryLine
                            key={row.group}
                            label={row.label}
                            value={`${formatCount(row.resources)} · ${formatCount(row.fields)} fields`}
                          />
                        ))}
                        <s-divider />
                        <SummaryLine
                          label="Estimated fields"
                          value={`~${formatCount(scope.estimate.fields)}`}
                        />
                        <SummaryLine
                          label="Estimated cost"
                          value={
                            scope.estimate.priced
                              ? `~${formatMicrosUsd(scope.estimate.costMicros)}`
                              : "Not priced"
                          }
                        />
                        <s-text color="subdued">
                          {`From content counted ${formatDateTime(scope.coverageAt)}, with ${scope.estimate.model}. ${
                            scope.estimate.priced
                              ? "Cost is estimated from the model's list price; the provider's own figures are recorded as the sync runs."
                              : `${scope.estimate.model} is not in the pricing table; tokens are still recorded.`
                          }`}
                        </s-text>
                      </>
                    )}
                  </s-stack>
                </>
              ) : null}

              <s-divider />

              <s-stack direction="block" gap="small-300">
                <s-button
                  type="button"
                  variant="primary"
                  inlineSize="fill"
                  onClick={submit}
                  {...(!locale || busy ? { disabled: true } : {})}
                  {...(busy ? { loading: true } : {})}
                >
                  {translatesNow
                    ? "Add language and translate"
                    : "Add language"}
                </s-button>
                <s-button
                  inlineSize="fill"
                  href={TRANSLATION_ROUTES.languages}
                  {...(busy ? { disabled: true } : {})}
                >
                  Cancel
                </s-button>
                {!locale ? (
                  <s-text color="subdued">Choose a language to add it.</s-text>
                ) : null}
              </s-stack>
            </s-stack>
          </s-section>
        </s-stack>
      </div>
    </s-page>
  );
}

/** "Shopify — Unpublished": a fact of the summary, label and answer. */
function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="baseline">
      <s-text color="subdued">{label}</s-text>
      <s-text>{value}</s-text>
    </s-grid>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
