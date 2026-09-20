import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";
import { z } from "zod";

import { isConfigured } from "~/adapters/ai/openai.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  forgetLanguageSettings,
  getCoverage,
  getLanguageSettings,
  listGlossary,
  listSyncs,
  saveLanguageSettings,
} from "~/adapters/db/repositories/translations.server";
import {
  disableShopLocale,
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
import { coveragePercent } from "~/domain/translations/estimate";
import { describeLanguage } from "~/domain/translations/languages";
import {
  ALL_CONTENT_GROUPS,
  CONTENT_GROUPS,
  OVERWRITE_POLICY_LABEL,
  isContentGroup,
  typesForGroups,
  type ContentGroup,
  type OverwritePolicy,
} from "~/domain/translations/types";
import { AiTranslationSettings } from "~/web/components/ai-translation-settings";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { LanguageLabel } from "~/web/components/language-label";
import { SettingRow } from "~/web/components/setting-row";
import { TranslationsNav } from "~/web/components/translations-nav";
import { formatDateTime } from "~/web/lib/datetime";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { redirectWithin } from "~/web/lib/redirects";
import {
  SYNC_KIND_LABEL,
  SYNC_STATUS_LABEL,
  TRANSLATION_ROUTES,
  formatPercent,
} from "~/web/lib/translations";
import { useResetWhenSaved, useSaveBar } from "~/web/lib/use-save-bar";

/**
 * One language (docs/translations.md § Edit language).
 *
 * Two cards that answer to two authorities. **In Shopify** — published or
 * not, which markets serve it, remove — every button is a Shopify mutation
 * and the page shows what Shopify answered, not what was asked. **AI
 * translation** — on or off, automatic or not, what content, what may be
 * overwritten — is this app's own setting on one save bar. Below them:
 * coverage by kind of content, the actions that start a sync, and the
 * language's recent syncs.
 */
const SAVE_BAR_ID = "translation-language-save-bar";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const locale = String(params.locale ?? "");
  if (!isLocaleCode(locale))
    throw redirectWithin(request, TRANSLATION_ROUTES.languages);
  const search = new URL(request.url).searchParams;
  const notice = search.get("notice");
  const justAdded = search.get("added") === "1";

  const [locales, markets, settings, coverage, glossary, syncs] =
    await Promise.all([
      listShopLocales(admin),
      listMarkets(admin),
      getLanguageSettings(principal, locale),
      getCoverage(principal),
      listGlossary(principal),
      listSyncs(principal, 30),
    ]);
  if (locales.kind === "unavailable")
    return {
      kind: "unavailable" as const,
      locale,
      reason: locales.reason,
      notice,
    };
  const shopLocale = locales.locales.find((row) => row.locale === locale);
  if (!shopLocale) throw redirectWithin(request, TRANSLATION_ROUTES.languages);
  const primary = locales.locales.find((row) => row.primary) ?? null;

  const enabledPresences = new Set(shopLocale.webPresences.map((p) => p.id));
  const presences =
    markets.kind === "read"
      ? markets.markets.flatMap((market) =>
          market.presences.map((presence) => ({
            id: presence.id,
            market: market.name,
            label: presence.label,
            defaultLocale: presence.defaultLocale,
            isDefault: presence.defaultLocale === locale,
            enabled: enabledPresences.has(presence.id),
          })),
        )
      : [];

  const byGroup = ALL_CONTENT_GROUPS.map((group) => {
    const totals = totalsFor(coverage.rows, locale, [
      ...CONTENT_GROUPS[group].types,
    ]);
    return {
      group,
      label: CONTENT_GROUPS[group].label,
      ...totals,
      coverage: coveragePercent([totals]),
    };
  }).filter((row) => row.fields > 0);
  const totals = totalsFor(coverage.rows, locale);

  return {
    kind: "read" as const,
    notice,
    justAdded,
    locale,
    name: shopLocale.name,
    language: describeLanguage(locale, shopLocale.name),
    primary: shopLocale.primary,
    published: shopLocale.published,
    primaryLocale: primary?.locale ?? null,
    presences,
    marketsUnavailable: markets.kind === "unavailable" ? markets.reason : null,
    settings: {
      aiEnabled: settings.aiEnabled,
      autoTranslateNew: settings.autoTranslateNew,
      autoUpdateOutdated: settings.autoUpdateOutdated,
      contentScope: settings.contentScope,
      overwritePolicy: settings.overwritePolicy,
    },
    lastSuccessfulSyncAt: settings.lastSuccessfulSyncAt?.toISOString() ?? null,
    coverage: {
      readAt: coverage.readAt?.toISOString() ?? null,
      percent: coveragePercent([totals]),
      ...totals,
      byGroup,
    },
    glossaryTerms: glossary.filter(
      (term) =>
        term.kind === "protect" ||
        term.targetLocale === locale ||
        term.targetLocale === null,
    ).length,
    syncs: syncs
      .filter((sync) => sync.targetLocales.includes(locale))
      .slice(0, 5)
      .map((sync) => ({
        id: sync.id,
        kind: sync.kind,
        status: sync.status,
        mode: sync.mode,
        createdAt: sync.createdAt.toISOString(),
        translatedFields: sync.translatedFields,
        failedFields: sync.failedFields,
      })),
    syncing: syncs.some(
      (sync) =>
        sync.targetLocales.includes(locale) &&
        (sync.status === "queued" || sync.status === "running"),
    ),
    aiConfigured: isConfigured(),
  };
};

type Settings = Extract<
  Awaited<ReturnType<typeof loader>>,
  { kind: "read" }
>["settings"];

const settingsSchema = z.object({
  aiEnabled: z.boolean(),
  autoTranslateNew: z.boolean(),
  autoUpdateOutdated: z.boolean(),
  contentScope: z.array(z.string()),
  overwritePolicy: z.enum([
    "protect_existing",
    "update_ai_managed",
    "overwrite_all",
  ]),
});

type ActionResult = { ok: boolean; message: string };

export const action = async ({
  request,
  params,
}: ActionFunctionArgs): Promise<ActionResult> => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);
  const locale = String(params.locale ?? "");
  if (!isLocaleCode(locale)) return { ok: false, message: "Unknown language." };
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "publish" || intent === "unpublish") {
    const result = await updateShopLocale(admin, locale, {
      published: intent === "publish",
    });
    if (result.kind === "rejected")
      return {
        ok: false,
        message: `Shopify refused: ${result.messages.join("; ")}`,
      };
    await appendEvent(principal, {
      entityType: "translation_language",
      entityId: locale,
      event: `translation_language.${intent}ed`,
      detail: { by: actor, published: result.locale?.published ?? null },
    });
    return {
      ok: true,
      message:
        result.locale?.published === true
          ? "Published. Shoppers can choose this language now."
          : "Unpublished. Shoppers no longer see this language.",
    };
  }

  if (intent === "save-presences") {
    const ids = formData.getAll("presenceId").map(String);
    const result = await updateShopLocale(admin, locale, {
      marketWebPresenceIds: ids,
    });
    if (result.kind === "rejected")
      return {
        ok: false,
        message: `Shopify refused: ${result.messages.join("; ")}`,
      };
    await appendEvent(principal, {
      entityType: "translation_language",
      entityId: locale,
      event: "translation_language.markets_changed",
      detail: { by: actor, presences: ids.length },
    });
    return { ok: true, message: "Markets updated in Shopify." };
  }

  if (intent === "remove") {
    const result = await disableShopLocale(admin, locale);
    if (result.kind === "rejected")
      return {
        ok: false,
        message: `Shopify refused: ${result.messages.join("; ")}`,
      };
    // Settings for a language the store no longer has go; history stays.
    await forgetLanguageSettings(principal, locale);
    await appendEvent(principal, {
      entityType: "translation_language",
      entityId: locale,
      event: "translation_language.removed",
      detail: { by: actor },
    });
    throw redirectWithin(request, TRANSLATION_ROUTES.languages);
  }

  if (intent === "save-settings") {
    let json: unknown;
    try {
      json = JSON.parse(String(formData.get("form") ?? ""));
    } catch {
      return {
        ok: false,
        message: "The form could not be read. Reload the page and try again.",
      };
    }
    const parsed = settingsSchema.safeParse(json);
    if (!parsed.success)
      return {
        ok: false,
        message: "The form could not be read. Reload the page and try again.",
      };
    const form = parsed.data;
    await saveLanguageSettings(principal, {
      locale,
      aiEnabled: form.aiEnabled,
      autoTranslateNew: form.aiEnabled && form.autoTranslateNew,
      autoUpdateOutdated: form.aiEnabled && form.autoUpdateOutdated,
      contentScope: form.contentScope.filter(isContentGroup),
      overwritePolicy: form.overwritePolicy,
    });
    await appendEvent(principal, {
      entityType: "translation_language",
      entityId: locale,
      event: "translation_language.settings_changed",
      detail: { ...form, by: actor },
    });
    return { ok: true, message: "AI translation settings saved." };
  }

  if (intent === "translate") {
    const mode = String(formData.get("mode") ?? "");
    if (mode !== "missing" && mode !== "missing_outdated" && mode !== "force")
      return { ok: false, message: "Unknown action." };
    if (!isConfigured())
      return {
        ok: false,
        message: "AI translation is not configured on this server.",
      };
    const settings = await getLanguageSettings(principal, locale);
    const sync = await startSync(principal, {
      kind: "language",
      mode,
      sourceLocale: "",
      targetLocales: [locale],
      resourceTypes: typesForGroups(settings.contentScope),
      requestedBy: actor,
    });
    throw redirectWithin(request, TRANSLATION_ROUTES.sync(sync.id));
  }

  if (intent === "refresh-coverage") {
    const jobId = await requestCoverageRefresh(principal, 60);
    return {
      ok: true,
      message: jobId
        ? "Counting translations across the store."
        : "Already counting.",
    };
  }

  return { ok: false, message: "Unknown action." };
};

function useLivePolling(active: boolean) {
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 5000);
    return () => clearInterval(timer);
  }, [active, revalidator]);
}

export default function Language() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data;
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  if (data.kind === "unavailable") {
    return (
      <s-page heading={data.locale}>
        <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
          Translations
        </s-link>
        <s-banner
          tone="warning"
          heading="This language could not be read from Shopify"
        >
          <s-paragraph>{data.reason}</s-paragraph>
        </s-banner>
      </s-page>
    );
  }

  return (
    <LanguagePage
      data={data}
      fetcher={fetcher}
      busy={busy}
      result={result ?? null}
    />
  );
}

type ReadData = Extract<Awaited<ReturnType<typeof loader>>, { kind: "read" }>;

function LanguagePage({
  data,
  fetcher,
  busy,
  result,
}: {
  data: ReadData;
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  busy: boolean;
  result: ActionResult | null;
}) {
  useLivePolling(data.syncing);
  const [settings, setSettings] = useState<Settings>(data.settings);
  const savedKey = JSON.stringify(data.settings);
  useResetWhenSaved(
    savedKey,
    useCallback(() => setSettings(data.settings), [data.settings]),
  );
  // Arriving from Add language: the one moment this page reports success.
  useEffect(() => {
    if (!data.justAdded || typeof shopify === "undefined") return;
    shopify.toast.show(`${data.name} added.`);
  }, [data.justAdded, data.name]);
  const dirty = JSON.stringify(settings) !== savedKey;
  useSaveBar(SAVE_BAR_ID, dirty);

  const [presenceIds, setPresenceIds] = useState<string[]>(
    data.presences.filter((p) => p.enabled).map((p) => p.id),
  );
  const savedPresences = data.presences
    .filter((p) => p.enabled)
    .map((p) => p.id);
  useResetWhenSaved(
    JSON.stringify(savedPresences),
    useCallback(() => setPresenceIds(savedPresences), [savedPresences]),
  );
  const presencesDirty =
    JSON.stringify([...presenceIds].sort()) !==
    JSON.stringify([...savedPresences].sort());

  const set = (patch: Partial<Settings>) =>
    setSettings((now) => ({ ...now, ...patch }));
  const toggleGroup = (group: ContentGroup, on: boolean) =>
    set({
      contentScope: on
        ? [...new Set([...settings.contentScope, group])]
        : settings.contentScope.filter((g) => g !== group),
    });

  const saveSettings = () =>
    fetcher.submit(
      { intent: "save-settings", form: JSON.stringify(settings) },
      { method: "post" },
    );

  const translate = (mode: "missing" | "missing_outdated" | "force") =>
    fetcher.submit({ intent: "translate", mode }, { method: "post" });

  const canTranslate = data.aiConfigured && !data.primary && !data.syncing;

  return (
    <s-page heading={data.name}>
      <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
        Translations
      </s-link>
      {!data.primary ? (
        <s-button
          slot="primary-action"
          variant="primary"
          type="button"
          onClick={() => translate("missing")}
          {...(!canTranslate || busy ? { disabled: true } : {})}
        >
          Translate missing
        </s-button>
      ) : null}
      <s-button
        slot="secondary-actions"
        href={`${TRANSLATION_ROUTES.editor}?locale=${encodeURIComponent(data.locale)}`}
      >
        Open editor
      </s-button>

      <ui-save-bar id={SAVE_BAR_ID}>
        <button
          variant="primary"
          onClick={saveSettings}
          {...(busy ? { loading: "" } : {})}
        >
          Save
        </button>
        <button onClick={() => setSettings(data.settings)}>Discard</button>
      </ui-save-bar>

      <s-stack direction="block" gap="large">
        <TranslationsNav current="languages" />

        {data.notice ? (
          <s-banner tone="warning" heading="Added with a problem">
            <s-paragraph>{data.notice}</s-paragraph>
          </s-banner>
        ) : null}
        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="In Shopify">
          <s-stack direction="block" gap="base">
            <LanguageLabel language={data.language} />
            <SettingRow
              label="Status"
              summary={
                data.primary
                  ? "The store's default language. It is always published and cannot be removed."
                  : data.published
                    ? "Published. Shoppers can choose this language."
                    : "Unpublished. Only you see this language, in the editor and previews."
              }
              action={
                data.primary ? null : data.published ? (
                  <>
                    <s-button
                      type="button"
                      command="--show"
                      commandFor="confirm-unpublish"
                      {...(busy ? { disabled: true } : {})}
                    >
                      Unpublish
                    </s-button>
                    <ConfirmModal
                      id="confirm-unpublish"
                      heading={`Unpublish ${data.name}?`}
                      confirmLabel="Unpublish"
                      tone="neutral"
                      onConfirm={() =>
                        fetcher.submit(
                          { intent: "unpublish" },
                          { method: "post" },
                        )
                      }
                    >
                      <s-paragraph>
                        Shoppers stop seeing this language at once. Every
                        translation stays in Shopify and comes back when it is
                        published again.
                      </s-paragraph>
                    </ConfirmModal>
                  </>
                ) : (
                  <s-button
                    type="button"
                    variant="primary"
                    onClick={() =>
                      fetcher.submit({ intent: "publish" }, { method: "post" })
                    }
                    {...(busy ? { disabled: true } : {})}
                  >
                    Publish
                  </s-button>
                )
              }
            />

            {data.marketsUnavailable ? (
              <SettingRow
                label="Available in"
                summary={data.marketsUnavailable}
              />
            ) : data.presences.length === 0 ? (
              <SettingRow
                label="Available in"
                summary="Shopify reports no market web presences. The language is served on the shop domain."
              />
            ) : (
              <s-stack direction="block" gap="small-300">
                <s-text type="strong">Available in</s-text>
                <s-text color="subdued">
                  Which markets serve this language, as Shopify Markets has it.
                  A market&apos;s default language cannot be removed from it
                  here.
                </s-text>
                {data.presences.map((presence) => (
                  <s-checkbox
                    key={presence.id}
                    label={`${presence.market} · ${presence.label}`}
                    details={
                      presence.isDefault
                        ? "Default language of this market"
                        : `Default language ${presence.defaultLocale}`
                    }
                    checked={presenceIds.includes(presence.id)}
                    onChange={(event) =>
                      setPresenceIds((now) =>
                        event.currentTarget.checked
                          ? [...now, presence.id]
                          : now.filter((id) => id !== presence.id),
                      )
                    }
                    {...(busy || presence.isDefault || data.primary
                      ? { disabled: true }
                      : {})}
                  />
                ))}
                {presencesDirty ? (
                  <s-stack direction="inline" gap="small-300">
                    <s-button
                      type="button"
                      variant="primary"
                      onClick={() => {
                        const body = new FormData();
                        body.set("intent", "save-presences");
                        for (const id of presenceIds)
                          body.append("presenceId", id);
                        fetcher.submit(body, { method: "post" });
                      }}
                      {...(busy ? { disabled: true } : {})}
                    >
                      Save markets
                    </s-button>
                    <s-button
                      type="button"
                      onClick={() => setPresenceIds(savedPresences)}
                    >
                      Cancel
                    </s-button>
                  </s-stack>
                ) : null}
              </s-stack>
            )}

            {!data.primary ? (
              <SettingRow
                label="Remove language"
                summary="Removes the language from Shopify. Shopify deletes every translation in it; the record of what was translated and what it cost stays here."
                action={
                  <>
                    <s-button
                      type="button"
                      tone="critical"
                      command="--show"
                      commandFor="confirm-remove"
                      {...(busy ? { disabled: true } : {})}
                    >
                      Remove
                    </s-button>
                    <ConfirmModal
                      id="confirm-remove"
                      heading={`Remove ${data.name} from the store?`}
                      confirmLabel="Remove language"
                      onConfirm={() =>
                        fetcher.submit({ intent: "remove" }, { method: "post" })
                      }
                    >
                      <s-paragraph>
                        Shopify removes the language and deletes every
                        translation in it — products, collections, pages,
                        articles, navigation, metafields, everything. This
                        cannot be undone from here; adding the language again
                        starts from nothing.
                      </s-paragraph>
                      <s-paragraph>
                        Syncs, their items and AI usage for this language are
                        kept as history. Shopify decides whether the removal is
                        allowed and will refuse for the default language.
                      </s-paragraph>
                    </ConfirmModal>
                  </>
                }
              />
            ) : null}
          </s-stack>
        </s-section>

        {data.primary ? (
          <s-section heading="AI translation">
            <s-text color="subdued">
              This is the source language: the AI translates from it into every
              other language. There is nothing to set here.
            </s-text>
          </s-section>
        ) : (
          <s-section heading="AI translation">
            <s-stack direction="block" gap="base">
              <AiTranslationSettings
                value={settings}
                onChange={set}
                configured={data.aiConfigured}
                overwritePolicy={settings.overwritePolicy}
                disabled={busy}
              />
              {settings.aiEnabled ? (
                <>
                  <s-stack direction="block" gap="small-300">
                    <s-text type="strong">Content</s-text>
                    {ALL_CONTENT_GROUPS.map((group) => (
                      <s-checkbox
                        key={group}
                        label={CONTENT_GROUPS[group].label}
                        checked={settings.contentScope.includes(group)}
                        onChange={(e) =>
                          toggleGroup(group, e.currentTarget.checked)
                        }
                        {...(busy ? { disabled: true } : {})}
                      />
                    ))}
                  </s-stack>

                  <s-choice-list
                    label="Existing translations"
                    details="What the AI may change when a translation is already there. Translations you write or correct in the editor, and translations Shopify held before this app, count as human work."
                    name="overwritePolicy"
                    values={[settings.overwritePolicy]}
                    onChange={(event) => {
                      const next = event.currentTarget.values[0] ?? "";
                      if (next in OVERWRITE_POLICY_LABEL)
                        set({ overwritePolicy: next as OverwritePolicy });
                    }}
                    {...(busy ? { disabled: true } : {})}
                  >
                    {(
                      Object.keys(OVERWRITE_POLICY_LABEL) as OverwritePolicy[]
                    ).map((policy) => (
                      <s-choice key={policy} value={policy}>
                        {OVERWRITE_POLICY_LABEL[policy]}
                      </s-choice>
                    ))}
                  </s-choice-list>
                </>
              ) : null}

              <SettingRow
                label="Glossary"
                summary={
                  data.glossaryTerms === 0
                    ? "No terms yet. Terms are applied to every translation into this language."
                    : `${data.glossaryTerms} ${data.glossaryTerms === 1 ? "term applies" : "terms apply"} to this language.`
                }
                action={
                  <s-button href={TRANSLATION_ROUTES.glossary}>
                    Open glossary
                  </s-button>
                }
              />
            </s-stack>
          </s-section>
        )}

        {!data.primary ? (
          <s-section heading="Coverage">
            <s-stack direction="block" gap="base">
              {data.coverage.readAt === null ? (
                <s-text color="subdued">Not counted yet.</s-text>
              ) : (
                <>
                  <s-text>
                    {`${formatPercent(data.coverage.percent)} of ${data.coverage.fields.toLocaleString("en")} fields translated · ${data.coverage.missing.toLocaleString("en")} missing · ${data.coverage.outdated.toLocaleString("en")} outdated`}
                  </s-text>
                  {data.coverage.byGroup.length > 0 ? (
                    <s-table variant="auto">
                      <s-table-header-row>
                        <s-table-header listSlot="primary">
                          Content
                        </s-table-header>
                        <s-table-header format="numeric">Fields</s-table-header>
                        <s-table-header format="numeric">
                          Missing
                        </s-table-header>
                        <s-table-header format="numeric">
                          Outdated
                        </s-table-header>
                        <s-table-header format="numeric" listSlot="secondary">
                          Coverage
                        </s-table-header>
                      </s-table-header-row>
                      <s-table-body>
                        {data.coverage.byGroup.map((row) => (
                          <s-table-row key={row.group}>
                            <s-table-cell>
                              <s-link
                                href={`${TRANSLATION_ROUTES.editor}?locale=${encodeURIComponent(data.locale)}&type=${CONTENT_GROUPS[row.group].types[0]}`}
                              >
                                {row.label}
                              </s-link>
                            </s-table-cell>
                            <s-table-cell>
                              {row.fields.toLocaleString("en")}
                            </s-table-cell>
                            <s-table-cell>
                              {row.missing.toLocaleString("en")}
                            </s-table-cell>
                            <s-table-cell>
                              {row.outdated.toLocaleString("en")}
                            </s-table-cell>
                            <s-table-cell>
                              {formatPercent(row.coverage)}
                            </s-table-cell>
                          </s-table-row>
                        ))}
                      </s-table-body>
                    </s-table>
                  ) : null}
                </>
              )}
              <s-grid
                gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr auto"
                gap="base"
                alignItems="center"
              >
                <s-text color="subdued">
                  {data.coverage.readAt
                    ? `Counted ${formatDateTime(data.coverage.readAt)}.`
                    : "Count it once to see what is missing."}
                  {data.lastSuccessfulSyncAt
                    ? ` Last successful sync ${formatDateTime(data.lastSuccessfulSyncAt)}.`
                    : ""}
                </s-text>
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
                  Count again
                </s-button>
              </s-grid>
            </s-stack>
          </s-section>
        ) : null}

        {!data.primary ? (
          <s-section heading="Translate">
            <s-stack direction="block" gap="base">
              {data.syncing ? (
                <s-banner tone="info" heading="Translating now">
                  <s-paragraph>
                    A sync for this language is running. Watch it under Syncs.
                  </s-paragraph>
                </s-banner>
              ) : null}
              <SettingRow
                label="Translate missing"
                summary="Fills every field in scope that has no translation yet. Nothing existing is touched."
                action={
                  <s-button
                    type="button"
                    onClick={() => translate("missing")}
                    {...(!canTranslate || busy ? { disabled: true } : {})}
                  >
                    Translate missing
                  </s-button>
                }
              />
              <SettingRow
                label="Update outdated"
                summary="Also redoes translations Shopify marks outdated because the source changed, within what the policy above allows."
                action={
                  <s-button
                    type="button"
                    onClick={() => translate("missing_outdated")}
                    {...(!canTranslate || busy ? { disabled: true } : {})}
                  >
                    Update outdated
                  </s-button>
                }
              />
              <SettingRow
                label="Retranslate everything"
                summary="Every field in scope goes back to the AI. Human translations are still protected unless the policy allows overwriting them."
                action={
                  <>
                    <s-button
                      type="button"
                      tone="critical"
                      command="--show"
                      commandFor="confirm-force"
                      {...(!canTranslate || busy ? { disabled: true } : {})}
                    >
                      Retranslate
                    </s-button>
                    <ConfirmModal
                      id="confirm-force"
                      heading={`Retranslate everything in ${data.name}?`}
                      confirmLabel="Retranslate"
                      onConfirm={() => translate("force")}
                    >
                      <s-paragraph>
                        {`Every translated field in scope is sent to the AI again — about ${data.coverage.fields.toLocaleString("en")} fields — and costs accordingly. Under "${OVERWRITE_POLICY_LABEL[data.settings.overwritePolicy]}" ${
                          data.settings.overwritePolicy === "overwrite_all"
                            ? "translations written by people are replaced too."
                            : "translations written or corrected by people are kept."
                        }`}
                      </s-paragraph>
                    </ConfirmModal>
                  </>
                }
              />
            </s-stack>
          </s-section>
        ) : null}

        {data.syncs.length > 0 ? (
          <s-section heading="Recent syncs">
            <s-stack direction="block" gap="small-300">
              {data.syncs.map((sync) => (
                <s-grid
                  key={sync.id}
                  gridTemplateColumns="1fr auto"
                  gap="base"
                  alignItems="center"
                >
                  <s-stack direction="block" gap="small-500">
                    <s-link href={TRANSLATION_ROUTES.sync(sync.id)}>
                      {`${SYNC_KIND_LABEL[sync.kind] ?? sync.kind} · ${formatDateTime(sync.createdAt)}`}
                    </s-link>
                    <s-text color="subdued">
                      {`${sync.translatedFields.toLocaleString("en")} translated${sync.failedFields > 0 ? `, ${sync.failedFields} failed` : ""}`}
                    </s-text>
                  </s-stack>
                  <s-badge
                    {...(sync.status === "failed"
                      ? { tone: "critical" as const }
                      : sync.status === "running" || sync.status === "queued"
                        ? { tone: "info" as const }
                        : {})}
                  >
                    {SYNC_STATUS_LABEL[sync.status] ?? sync.status}
                  </s-badge>
                </s-grid>
              ))}
              <s-link href={TRANSLATION_ROUTES.syncs}>All syncs</s-link>
            </s-stack>
          </s-section>
        ) : null}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
