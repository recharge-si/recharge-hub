import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  useFetcher,
  useLoaderData,
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
import { enqueue, latestJobForKey } from "~/adapters/queue/boss.server";
import {
  QUEUES,
  translationRemoveAiKey,
  translationRemoveKey,
} from "~/adapters/queue/queues";
import {
  coverageProgress,
  requestCoverageRefresh,
  startSync,
} from "~/adapters/translations/syncs.server";
import { CoverageCount } from "~/web/components/coverage-count";
import { totalsFor } from "~/domain/translations/coverage";
import { coveragePercent } from "~/domain/translations/estimate";
import { describeLanguage } from "~/domain/translations/languages";
import {
  ALL_CONTENT_GROUPS,
  ALL_KEEP_ORIGINAL,
  CONTENT_GROUPS,
  KEEP_ORIGINAL,
  OVERWRITE_POLICY_LABEL,
  isContentGroup,
  isKeepOriginal,
  removalScope,
  typesForGroups,
  type ContentGroup,
  type KeepOriginal,
  type OverwritePolicy,
} from "~/domain/translations/types";
import { AiTranslationSettings } from "~/web/components/ai-translation-settings";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { LanguageLabel } from "~/web/components/language-label";
import { SettingRow } from "~/web/components/setting-row";
import { PageColumns } from "~/web/components/page-columns";
import { TranslationsNav } from "~/web/components/translations-nav";
import { formatDateTime } from "~/web/lib/datetime";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { redirectWithin } from "~/web/lib/redirects";
import {
  syncName,
  SYNC_STATUS_LABEL,
  TRANSLATION_ROUTES,
  formatPercent,
} from "~/web/lib/translations";
import { useResetWhenSaved, useSaveBar } from "~/web/lib/use-save-bar";
import { useLiveRevalidation } from "~/web/lib/live";

/**
 * One language (docs/translations.md § Edit language).
 *
 * A form and a sticky sidebar. The main column is what changes the
 * language: **AI translation** — on or off, automatic or not, what content,
 * what stays in the original language, what may be overwritten — this
 * app's own setting on one save bar; then the actions that start a sync,
 * the recent syncs, and the markets with the destructive rows last. The
 * sidebar is where the language stands: published or not, and coverage by
 * kind of content. Every Shopify button shows what Shopify answered, not
 * what was asked.
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

  const [
    locales,
    markets,
    settings,
    coverage,
    glossary,
    syncs,
    removal,
    count,
  ] = await Promise.all([
    listShopLocales(admin),
    listMarkets(admin),
    getLanguageSettings(principal, locale),
    getCoverage(principal),
    listGlossary(principal),
    listSyncs(principal, 30),
    latestJobForKey(
      QUEUES.translationRemove,
      translationRemoveKey(principal.shopDomain, locale),
    ),
    coverageProgress(principal),
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

  // With AI translation on, the headline counts only what the language
  // translates: content taken out of scope (metafields, say) is not missing
  // or outdated work, it is left alone (docs/translations.md § Coverage).
  const scoped = settings.aiEnabled;
  const byGroup = ALL_CONTENT_GROUPS.map((group) => {
    const totals = totalsFor(coverage.rows, locale, [
      ...CONTENT_GROUPS[group].types,
    ]);
    return {
      group,
      label: CONTENT_GROUPS[group].label,
      inScope: !scoped || settings.contentScope.includes(group),
      ...totals,
      coverage: coveragePercent([totals]),
    };
  }).filter((row) => row.fields > 0);
  const totals = totalsFor(
    coverage.rows,
    locale,
    scoped ? typesForGroups(settings.contentScope) : null,
  );

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
      keepOriginal: settings.keepOriginal,
    },
    removing:
      removal?.state === "created" ||
      removal?.state === "retry" ||
      removal?.state === "active",
    removalFailed: removal?.state === "failed" ? removal.error : null,
    lastSuccessfulSyncAt: settings.lastSuccessfulSyncAt?.toISOString() ?? null,
    coverageCount: count,
    coverage: {
      readAt: coverage.readAt?.toISOString() ?? null,
      scoped:
        scoped && settings.contentScope.length < ALL_CONTENT_GROUPS.length,
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
        name: syncName({
          kind: sync.kind,
          requestedBy: sync.requestedBy,
          resources: sync.resourceIds.length,
        }),
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
  keepOriginal: z.array(z.string()).default([]),
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
    const before = await getLanguageSettings(principal, locale);
    const after = {
      locale,
      aiEnabled: form.aiEnabled,
      autoTranslateNew: form.aiEnabled && form.autoTranslateNew,
      autoUpdateOutdated: form.aiEnabled && form.autoUpdateOutdated,
      contentScope: form.contentScope.filter(isContentGroup),
      overwritePolicy: form.overwritePolicy,
      keepOriginal: form.keepOriginal.filter(isKeepOriginal),
    };
    await saveLanguageSettings(principal, after);
    await appendEvent(principal, {
      entityType: "translation_language",
      entityId: locale,
      event: "translation_language.settings_changed",
      detail: { ...form, by: actor },
    });
    // Content taken out of scope, or a field now kept in the original,
    // loses what the AI wrote for it (docs/translations.md § Switched off);
    // a person's translations stay. The job counts coverage when done.
    const scope = removalScope(before, after);
    if (scope.length > 0) {
      await enqueue(
        QUEUES.translationRemove,
        {
          shopDomain: principal.shopDomain,
          locale,
          requestedBy: actor,
          scope,
        },
        {
          singletonKey: translationRemoveAiKey(
            principal.shopDomain,
            locale,
            scope,
          ),
        },
      );
      return {
        ok: true,
        message:
          "Saved. Deleting the AI translations of what you switched off.",
      };
    }
    // A field no longer kept in the original counts as missing again.
    if (before.keepOriginal.some((c) => !after.keepOriginal.includes(c)))
      await requestCoverageRefresh(principal);
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

  if (intent === "remove-translations") {
    const syncs = await listSyncs(principal, 30);
    if (
      syncs.some(
        (sync) =>
          sync.targetLocales.includes(locale) &&
          (sync.status === "queued" || sync.status === "running"),
      )
    )
      return {
        ok: false,
        message:
          "A sync for this language is running. Cancel it or wait for it to finish first.",
      };
    // Automatic translation would fill the language again tonight; it is
    // switched off, and the merchant switches it back on when they want.
    const settings = await getLanguageSettings(principal, locale);
    await saveLanguageSettings(principal, {
      ...settings,
      autoTranslateNew: false,
      autoUpdateOutdated: false,
    });
    const jobId = await enqueue(
      QUEUES.translationRemove,
      { shopDomain: principal.shopDomain, locale, requestedBy: actor },
      { singletonKey: translationRemoveKey(principal.shopDomain, locale) },
    );
    await appendEvent(principal, {
      entityType: "translation_language",
      entityId: locale,
      event: "translation_language.remove_translations_requested",
      detail: { by: actor },
    });
    return {
      ok: true,
      message: jobId
        ? "Deleting every translation in this language."
        : "Already deleting.",
    };
  }

  if (intent === "refresh-coverage") {
    const jobId = await requestCoverageRefresh(principal);
    return {
      ok: true,
      message: jobId
        ? "Counting translations across the store."
        : "Already counting.",
    };
  }

  return { ok: false, message: "Unknown action." };
};

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
  useLiveRevalidation({
    active:
      data.syncing || data.removing || data.coverageCount.state === "counting",
    idleEveryMs: null,
  });
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
  const toggleKeep = (choice: KeepOriginal, on: boolean) =>
    set({
      keepOriginal: on
        ? [...new Set([...settings.keepOriginal, choice])]
        : settings.keepOriginal.filter((c) => c !== choice),
    });
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

  const canTranslate =
    data.aiConfigured && !data.primary && !data.syncing && !data.removing;

  return (
    <s-page heading={data.name} inlineSize="large">
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
        {data.removing ? (
          <s-banner tone="info" heading="Deleting translations">
            <s-paragraph>
              Every translation in this language is being deleted from Shopify.
              Coverage is counted again when it is done.
            </s-paragraph>
          </s-banner>
        ) : null}
        {data.removalFailed ? (
          <s-banner tone="critical" heading="Deleting translations stopped">
            <s-paragraph>{data.removalFailed}</s-paragraph>
          </s-banner>
        ) : null}
        {data.syncing ? (
          <s-banner tone="info" heading="Translating now">
            <s-paragraph>
              A sync for this language is running. Watch it under Syncs.
            </s-paragraph>
          </s-banner>
        ) : null}

        <PageColumns
          aside={
            <LanguageSummary
              data={data}
              busy={busy}
              onPublish={() =>
                fetcher.submit({ intent: "publish" }, { method: "post" })
              }
              onUnpublish={() =>
                fetcher.submit({ intent: "unpublish" }, { method: "post" })
              }
              onCount={() =>
                fetcher.submit(
                  { intent: "refresh-coverage" },
                  { method: "post" },
                )
              }
            />
          }
        >
          {data.primary ? (
            <s-section heading="AI translation">
              <s-text color="subdued">
                This is the source language: the AI translates from it into
                every other language. There is nothing to set here.
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
                    <s-divider />
                    <CheckboxGroup
                      heading="What gets translated"
                      details="Content the AI works on, whether you ask or it runs automatically. Unchecking content deletes the translations the AI wrote for it when you save; translations a person wrote or edited stay."
                    >
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
                    </CheckboxGroup>

                    <s-divider />
                    <CheckboxGroup
                      heading="Keep in the original language"
                      details="The AI leaves these alone, shoppers see the original, and they are not counted as missing. Checking one deletes the translations the AI wrote for it when you save; translations a person wrote or edited stay."
                    >
                      {ALL_KEEP_ORIGINAL.map((choice) => (
                        <s-checkbox
                          key={choice}
                          label={KEEP_ORIGINAL[choice].label}
                          checked={settings.keepOriginal.includes(choice)}
                          onChange={(e) =>
                            toggleKeep(choice, e.currentTarget.checked)
                          }
                          {...(busy ? { disabled: true } : {})}
                        />
                      ))}
                    </CheckboxGroup>

                    <s-divider />
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

                <s-divider />
                <SettingRow
                  label="Glossary"
                  summary={
                    data.glossaryTerms === 0
                      ? "No terms yet. Terms apply to every translation into this language."
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
            <s-section heading="Translate">
              <s-stack direction="block" gap="base">
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
                  summary="Also redoes translations Shopify marks outdated because the source changed, within what the policy allows."
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
                  summary="Every field in scope goes back to the AI. Human translations stay protected unless the policy allows overwriting them."
                  action={
                    <>
                      <s-button
                        type="button"
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
                        {sync.name}
                      </s-link>
                      <s-text color="subdued">
                        {`${formatDateTime(sync.createdAt)} · ${sync.translatedFields.toLocaleString("en")} translated${sync.failedFields > 0 ? `, ${sync.failedFields} failed` : ""}`}
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

          <s-section heading="Markets and removal">
            <s-stack direction="block" gap="base">
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
                    Which markets serve this language, as Shopify Markets has
                    it. A market&apos;s default language cannot be removed from
                    it here.
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
                <>
                  <s-divider />
                  <SettingRow
                    label="Delete all translations"
                    summary="Removes every translation in this language from Shopify, AI and human alike. The language stays."
                    action={
                      <>
                        <s-button
                          type="button"
                          tone="critical"
                          command="--show"
                          commandFor="confirm-remove-translations"
                          {...(data.syncing || data.removing || busy
                            ? { disabled: true }
                            : {})}
                        >
                          Delete all
                        </s-button>
                        <ConfirmModal
                          id="confirm-remove-translations"
                          heading={`Delete every translation in ${data.name}?`}
                          confirmLabel="Delete all translations"
                          onConfirm={() =>
                            fetcher.submit(
                              { intent: "remove-translations" },
                              { method: "post" },
                            )
                          }
                        >
                          <s-paragraph>
                            Every translation in this language is deleted from
                            Shopify — products, collections, pages, articles,
                            navigation and the rest, including translations
                            people wrote. This cannot be undone.
                          </s-paragraph>
                          <s-paragraph>
                            Automatic translation for this language is switched
                            off so it does not fill everything again tonight.
                            The language itself stays, and so does the history
                            of syncs and AI usage.
                          </s-paragraph>
                        </ConfirmModal>
                      </>
                    }
                  />
                  <SettingRow
                    label="Remove language"
                    summary="Removes the language from Shopify, and Shopify deletes every translation in it. History of syncs and cost stays here."
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
                            fetcher.submit(
                              { intent: "remove" },
                              { method: "post" },
                            )
                          }
                        >
                          <s-paragraph>
                            Shopify removes the language and deletes every
                            translation in it — products, collections, pages,
                            articles, navigation, metafields, everything. This
                            cannot be undone from here; adding the language
                            again starts from nothing.
                          </s-paragraph>
                          <s-paragraph>
                            Syncs, their items and AI usage for this language
                            are kept as history. Shopify decides whether the
                            removal is allowed and will refuse for the default
                            language.
                          </s-paragraph>
                        </ConfirmModal>
                      </>
                    }
                  />
                </>
              ) : null}
            </s-stack>
          </s-section>
        </PageColumns>
      </s-stack>
    </s-page>
  );
}

/**
 * A heading, one line on what the choice does, and its checkboxes in two
 * columns — a list of seven short labels read as one tall column is most of
 * a card's height.
 */
function CheckboxGroup({
  heading,
  details,
  children,
}: {
  heading: string;
  details: string;
  children: ReactNode;
}) {
  return (
    <s-stack direction="block" gap="small-300">
      <s-stack direction="block" gap="small-500">
        <s-text type="strong">{heading}</s-text>
        <s-text color="subdued">{details}</s-text>
      </s-stack>
      <s-query-container>
        <s-grid
          gridTemplateColumns="@container (inline-size <= 480px) 1fr, (inline-size <= 820px) 'minmax(0, 1fr) minmax(0, 1fr)', 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)'"
          gap="small-300 base"
        >
          {children}
        </s-grid>
      </s-query-container>
    </s-stack>
  );
}

const BAR_COLOR = {
  translated: "var(--s-color-text, #303030)",
  outdated: "var(--s-color-bg-fill-caution, #ffb800)",
  missing: "var(--s-color-border, #e3e3e3)",
} as const;

/**
 * Translated, outdated and missing as one bar, in that order, so the dark
 * part is what shoppers see in this language and the gap is what is left.
 */
function CoverageBar({
  translated,
  outdated,
  missing,
  height = 6,
}: {
  translated: number;
  outdated: number;
  missing: number;
  height?: number;
}) {
  const total = translated + outdated + missing;
  const share = (n: number) => (total === 0 ? 0 : (n / total) * 100);
  return (
    <div
      role="img"
      aria-label={`${translated} translated, ${outdated} outdated, ${missing} missing`}
      style={{
        display: "flex",
        height,
        borderRadius: height / 2,
        overflow: "hidden",
        background: BAR_COLOR.missing,
      }}
    >
      <div
        style={{
          width: `${share(translated)}%`,
          background: BAR_COLOR.translated,
        }}
      />
      <div
        style={{ width: `${share(outdated)}%`, background: BAR_COLOR.outdated }}
      />
    </div>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: 2,
        background: color,
        marginInlineEnd: 6,
      }}
    />
  );
}

/**
 * The sticky side of the page: what the language is in Shopify and how far
 * it is translated. Everything that changes the language sits in the main
 * column; this states where it stands, and stays in view while it changes.
 */
function LanguageSummary({
  data,
  busy,
  onPublish,
  onUnpublish,
  onCount,
}: {
  data: ReadData;
  busy: boolean;
  onPublish: () => void;
  onUnpublish: () => void;
  onCount: () => void;
}) {
  const coverage = data.coverage;
  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <LanguageLabel language={data.language} />
        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
          <s-stack direction="block" gap="small-500">
            <s-stack direction="inline" gap="small-300">
              {data.primary ? (
                <s-badge>Default language</s-badge>
              ) : data.published ? (
                <s-badge tone="success">Published</s-badge>
              ) : (
                <s-badge>Unpublished</s-badge>
              )}
            </s-stack>
            <s-text color="subdued">
              {data.primary
                ? "Always published. The AI translates from it."
                : data.published
                  ? "Shoppers can choose this language."
                  : "Only you see it, in the editor and previews."}
            </s-text>
          </s-stack>
          {data.primary ? null : data.published ? (
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
                onConfirm={onUnpublish}
              >
                <s-paragraph>
                  Shoppers stop seeing this language at once. Every translation
                  stays in Shopify and comes back when it is published again.
                </s-paragraph>
              </ConfirmModal>
            </>
          ) : (
            <s-button
              type="button"
              variant="primary"
              onClick={onPublish}
              {...(busy ? { disabled: true } : {})}
            >
              Publish
            </s-button>
          )}
        </s-grid>

        {!data.primary ? (
          <>
            <s-divider />
            {coverage.readAt === null ? (
              <s-stack direction="block" gap="small-300">
                <s-text type="strong">Coverage</s-text>
                <s-text color="subdued">
                  Not counted yet. Count once to see what is missing.
                </s-text>
              </s-stack>
            ) : (
              <s-stack direction="block" gap="small-300">
                <s-stack direction="block" gap="small-500">
                  <s-heading>{`${formatPercent(coverage.percent)} translated`}</s-heading>
                  <s-text color="subdued">
                    {`${coverage.fields.toLocaleString("en")} fields ${coverage.scoped ? "in what gets translated" : "in the store"}`}
                  </s-text>
                </s-stack>
                <CoverageBar
                  translated={coverage.translated}
                  outdated={coverage.outdated}
                  missing={coverage.missing}
                  height={10}
                />
                <s-stack direction="inline" gap="base">
                  <s-text color="subdued">
                    <Swatch color={BAR_COLOR.translated} />
                    {`${coverage.translated.toLocaleString("en")} done`}
                  </s-text>
                  <s-text color="subdued">
                    <Swatch color={BAR_COLOR.outdated} />
                    {`${coverage.outdated.toLocaleString("en")} outdated`}
                  </s-text>
                  <s-text color="subdued">
                    <Swatch color={BAR_COLOR.missing} />
                    {`${coverage.missing.toLocaleString("en")} missing`}
                  </s-text>
                </s-stack>

                {coverage.byGroup.length > 0 ? (
                  <s-stack direction="block" gap="small-300">
                    {coverage.byGroup.map((row) => (
                      <s-stack
                        key={row.group}
                        direction="block"
                        gap="small-500"
                      >
                        <s-grid gridTemplateColumns="1fr auto" gap="small-300">
                          <s-link
                            href={`${TRANSLATION_ROUTES.editor}?locale=${encodeURIComponent(data.locale)}&type=${CONTENT_GROUPS[row.group].types[0]}`}
                          >
                            {row.label}
                          </s-link>
                          <s-text color="subdued">
                            {!row.inScope
                              ? `Not translated · ${formatPercent(row.coverage)}`
                              : row.missing + row.outdated === 0
                                ? formatPercent(row.coverage)
                                : `${(row.missing + row.outdated).toLocaleString("en")} to do · ${formatPercent(row.coverage)}`}
                          </s-text>
                        </s-grid>
                        <CoverageBar
                          translated={row.translated}
                          outdated={row.outdated}
                          missing={row.missing}
                        />
                      </s-stack>
                    ))}
                  </s-stack>
                ) : null}
              </s-stack>
            )}
            <CoverageCount
              progress={data.coverageCount}
              countedAt={coverage.readAt}
              busy={busy || data.removing}
              onCount={onCount}
              compact
            />
            {data.lastSuccessfulSyncAt ? (
              <s-text color="subdued">
                {`Last sync ${formatDateTime(data.lastSuccessfulSyncAt)}.`}
              </s-text>
            ) : null}
          </>
        ) : null}
      </s-stack>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
