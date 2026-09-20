import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useRevalidator,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { isConfigured } from "~/adapters/ai/openai.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  countMemory,
  countTerms,
  deleteMemoryEntry,
  deleteTerm,
  getStoreProfile,
  listMemory,
  listTerms,
  memoryCountsByLocale,
  setProfileSettings,
} from "~/adapters/db/repositories/translation-intelligence.server";
import { listShopLocales } from "~/adapters/shopify/locales";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { requestProfileRebuild } from "~/adapters/translations/syncs.server";
import { TERM_CLASSIFICATION_LABEL } from "~/domain/translations/profile";
import { Dropdown } from "~/web/components/dropdown";
import { ToggleRow } from "~/web/components/toggle-row";
import { TranslationsNav } from "~/web/components/translations-nav";
import { formatDateTime } from "~/web/lib/datetime";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import {
  TRANSLATION_ROUTES,
  glossaryUrl,
  localeLabel,
} from "~/web/lib/translations";

/**
 * Store context (docs/translations.md § Translation intelligence): what
 * the AI has worked out about the store on its own — the kind of store it
 * is, the words that carry weight here, and how it has been saying them in
 * each language — so a merchant can see why a menu label was left in
 * English and correct it where it matters. Nothing here needs filling in:
 * it builds itself before the first translation and follows the store.
 *
 * The glossary is where a rule lives. This page shows what the engine
 * learnt; a term it learnt wrongly is forgotten here and, if the merchant
 * wants a particular word, told in the glossary.
 */
const PAGE = 50;

function confidenceWord(confidence: number): string {
  if (confidence >= 0.95) return "Certain";
  if (confidence >= 0.8) return "Likely";
  if (confidence >= 0.6) return "Probable";
  return "Possible";
}

const EVIDENCE_LABEL: Record<string, string> = {
  vendor: "vendor",
  productType: "product type",
  menu: "menu",
  collection: "collection",
  tag: "tag",
  optionName: "option",
  optionValue: "option value",
  productTitle: "product titles",
  profile: "store profile",
  shop: "store name",
};

function describeEvidence(evidence: Record<string, number>): string {
  return Object.entries(evidence)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([source, count]) =>
      source === "productTitle" ? `${count} product titles` : (EVIDENCE_LABEL[source] ?? source),
    )
    .join(", ");
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const url = new URL(request.url);
  const termSearch = (url.searchParams.get("term") ?? "").trim().slice(0, 60);
  const memorySearch = (url.searchParams.get("memory") ?? "").trim().slice(0, 60);
  const localeParam = url.searchParams.get("locale") ?? "";
  const termPage = Math.max(1, Number(url.searchParams.get("tp") ?? "1") || 1);
  const memoryPage = Math.max(1, Number(url.searchParams.get("mp") ?? "1") || 1);

  const locales = await listShopLocales(admin);
  const primary =
    locales.kind === "read" ? locales.locales.find((l) => l.primary) : undefined;
  const targets =
    locales.kind === "read" ? locales.locales.filter((l) => !l.primary) : [];
  const memoryLocale =
    targets.some((l) => l.locale === localeParam) ? localeParam : (targets[0]?.locale ?? null);

  const sourceLocale = primary?.locale ?? "";
  const [profile, termTotal, terms, memoryTotal, memory, memoryCounts] = await Promise.all([
    getStoreProfile(principal),
    sourceLocale ? countTerms(principal, sourceLocale, termSearch || undefined) : Promise.resolve(0),
    sourceLocale
      ? listTerms(principal, sourceLocale, {
          search: termSearch || undefined,
          limit: PAGE,
          offset: (termPage - 1) * PAGE,
        })
      : Promise.resolve([]),
    countMemory(principal, { targetLocale: memoryLocale, search: memorySearch || undefined }),
    listMemory(principal, {
      targetLocale: memoryLocale,
      search: memorySearch || undefined,
      limit: PAGE,
      offset: (memoryPage - 1) * PAGE,
    }),
    memoryCountsByLocale(principal),
  ]);

  return {
    aiConfigured: isConfigured(),
    primary: primary ? { locale: primary.locale, name: primary.name } : null,
    languages: targets.map((l) => ({ locale: l.locale, name: l.name })),
    profile: profile
      ? {
          summary: profile.summary,
          description: profile.profile?.storeDescription ?? null,
          industries: profile.profile?.industries ?? [],
          audience: profile.profile?.audience ?? "",
          brands: profile.profile?.likelyBrands ?? [],
          families: profile.profile?.productFamilies ?? [],
          abbreviations: profile.profile?.commonAbbreviations ?? [],
          terminology: profile.profile?.importantTerminology ?? [],
          notes: profile.profile?.localisationNotes ?? "",
          version: profile.version,
          generatedAt: profile.generatedAt?.toISOString() ?? null,
          checkedAt: profile.checkedAt?.toISOString() ?? null,
          building: profile.generatingAt !== null,
          lastError: profile.lastError,
          sampleStats: profile.sampleStats,
          useStoreContext: profile.useStoreContext,
          learnTerminology: profile.learnTerminology,
        }
      : null,
    terms: {
      total: termTotal,
      page: termPage,
      search: termSearch,
      rows: terms.map((term) => ({
        id: term.id,
        term: term.term,
        classification: term.classification,
        confidence: term.confidence,
        evidence: describeEvidence(term.evidence),
      })),
    },
    memory: {
      total: memoryTotal,
      page: memoryPage,
      search: memorySearch,
      locale: memoryLocale,
      countsByLocale: Object.fromEntries(memoryCounts),
      rows: memory.map((entry) => ({
        id: entry.id,
        sourceText: entry.sourceText,
        targetText: entry.targetText,
        origin: entry.origin,
        usageCount: entry.usageCount,
        resourceType: entry.resourceType,
      })),
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "rebuild") {
    if (!isConfigured())
      return { ok: false, message: "AI translation is not configured on this server." };
    const jobId = await requestProfileRebuild(principal);
    await appendEvent(principal, {
      entityType: "translation_profile",
      event: "translation_profile.rebuild_requested",
      detail: { by: actor },
    });
    return {
      ok: true,
      message: jobId
        ? "Reading the store again. The new profile is ready in a minute or two."
        : "The store is already being read.",
    };
  }

  if (intent === "settings") {
    const useStoreContext = formData.get("useStoreContext") === "true";
    const learnTerminology = formData.get("learnTerminology") === "true";
    await setProfileSettings(principal, { useStoreContext, learnTerminology });
    await appendEvent(principal, {
      entityType: "translation_profile",
      event: "translation_profile.settings_changed",
      detail: { useStoreContext, learnTerminology, by: actor },
    });
    return { ok: true, message: "Saved. It applies from the next translation." };
  }

  if (intent === "forget-term") {
    const id = String(formData.get("id") ?? "");
    const deleted = await deleteTerm(principal, id);
    return deleted
      ? { ok: true, message: "Term forgotten. It is learnt again only if the store still uses it." }
      : { ok: false, message: "That term is already gone." };
  }

  if (intent === "forget-memory") {
    const id = String(formData.get("id") ?? "");
    const deleted = await deleteMemoryEntry(principal, id);
    return deleted
      ? { ok: true, message: "Forgotten. The next translation of that text decides afresh." }
      : { ok: false, message: "That entry is already gone." };
  }

  return { ok: false, message: "Unknown action." };
};

type LoaderData = Awaited<ReturnType<typeof loader>>;

function pageUrl(data: LoaderData, patch: Partial<{ term: string; memory: string; locale: string; tp: number; mp: number }>): string {
  const search = new URLSearchParams();
  const term = patch.term ?? data.terms.search;
  const memory = patch.memory ?? data.memory.search;
  const locale = patch.locale ?? data.memory.locale ?? "";
  const tp = patch.tp ?? (patch.term !== undefined ? 1 : data.terms.page);
  const mp = patch.mp ?? (patch.memory !== undefined || patch.locale !== undefined ? 1 : data.memory.page);
  if (term) search.set("term", term);
  if (memory) search.set("memory", memory);
  if (locale) search.set("locale", locale);
  if (tp > 1) search.set("tp", String(tp));
  if (mp > 1) search.set("mp", String(mp));
  const query = search.toString();
  return query ? `${TRANSLATION_ROUTES.context}?${query}` : TRANSLATION_ROUTES.context;
}

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

export default function StoreContext() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const busy = fetcher.state !== "idle";
  const [termQuery, setTermQuery] = useState(data.terms.search);
  const [memoryQuery, setMemoryQuery] = useState(data.memory.search);
  useLivePolling(data.profile?.building ?? false);

  useEffect(() => {
    if (!fetcher.data?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(fetcher.data.message);
  }, [fetcher.data]);

  const profile = data.profile;
  const built = profile !== null && profile.generatedAt !== null;

  return (
    <s-page heading="Store context">
      <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
        Translations
      </s-link>
      <s-button
        slot="primary-action"
        onClick={() => fetcher.submit({ intent: "rebuild" }, { method: "post" })}
        {...(busy || !data.aiConfigured || profile?.building ? { disabled: true } : {})}
        {...(profile?.building ? { loading: true } : {})}
      >
        {built ? "Read the store again" : "Build now"}
      </s-button>

      <s-stack direction="block" gap="large">
        <TranslationsNav current="context" />

        {fetcher.data && !fetcher.data.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{fetcher.data.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="What the AI knows about this store">
          <s-stack direction="block" gap="base">
            {!built ? (
              <s-stack direction="block" gap="small-300">
                <s-text>
                  Not built yet. It is built automatically from the store&apos;s
                  own navigation, collections and products before the first
                  translation, and read again when the store changes.
                </s-text>
                {profile?.lastError ? (
                  <s-text color="subdued">Last attempt: {profile.lastError}</s-text>
                ) : null}
              </s-stack>
            ) : (
              <>
                {profile.industries.length > 0 ? (
                  <s-stack direction="inline" gap="small-300">
                    {profile.industries.map((industry) => (
                      <s-badge key={industry}>{industry}</s-badge>
                    ))}
                  </s-stack>
                ) : null}
                <s-paragraph>{profile.description}</s-paragraph>
                {profile.audience ? (
                  <s-text color="subdued">Audience: {profile.audience}</s-text>
                ) : null}
                {profile.brands.length > 0 ? (
                  <Facts label="Brands" values={profile.brands} />
                ) : null}
                {profile.families.length > 0 ? (
                  <Facts label="Product families" values={profile.families} />
                ) : null}
                {profile.abbreviations.length > 0 ? (
                  <Facts
                    label="Abbreviations"
                    values={profile.abbreviations.map((entry) =>
                      entry.meaning ? `${entry.abbreviation} — ${entry.meaning}` : entry.abbreviation,
                    )}
                  />
                ) : null}
                {profile.terminology.length > 0 ? (
                  <Facts
                    label="Specialised meanings"
                    values={profile.terminology.map((entry) =>
                      entry.meaning ? `${entry.term} — ${entry.meaning}` : entry.term,
                    )}
                  />
                ) : null}
                {profile.notes ? (
                  <s-text color="subdued">Notes for translators: {profile.notes}</s-text>
                ) : null}
                <s-text color="subdued">
                  {`Built ${formatDateTime(profile.generatedAt!)}${
                    profile.sampleStats
                      ? ` from ${profile.sampleStats.products.toLocaleString("en")} products, ${profile.sampleStats.collections} collections and ${profile.sampleStats.menuItems} menu items`
                      : ""
                  }${profile.checkedAt ? ` · checked ${formatDateTime(profile.checkedAt)}` : ""} · version ${profile.version}.`}
                </s-text>
              </>
            )}
            {!data.aiConfigured ? (
              <s-text color="subdued">
                AI translation is not configured on this server, so the profile
                cannot be built.
              </s-text>
            ) : null}
          </s-stack>
        </s-section>

        <s-section heading="How translations use it">
          <s-stack direction="block" gap="base">
            <ToggleRow
              label="Translate with the store in mind"
              description="Every request carries the store profile and the store's terminology, so a one-word label is read the way a shopper of this store reads it."
              checked={profile?.useStoreContext ?? true}
              disabled={busy}
              onChange={(checked) =>
                fetcher.submit(
                  {
                    intent: "settings",
                    useStoreContext: String(checked),
                    learnTerminology: String(profile?.learnTerminology ?? true),
                  },
                  { method: "post" },
                )
              }
            />
            <ToggleRow
              label="Learn as the store is translated"
              description="Terms are found in the store's own data, and each language remembers how short strings were translated so the same term is never translated two ways. A translation you write yourself is remembered first."
              checked={profile?.learnTerminology ?? true}
              disabled={busy}
              onChange={(checked) =>
                fetcher.submit(
                  {
                    intent: "settings",
                    useStoreContext: String(profile?.useStoreContext ?? true),
                    learnTerminology: String(checked),
                  },
                  { method: "post" },
                )
              }
            />
            <s-text color="subdued">
              Want a particular word? A{" "}
              <s-link href={TRANSLATION_ROUTES.glossary}>terminology override</s-link>{" "}
              always wins over anything learnt here.
            </s-text>
          </s-stack>
        </s-section>

        <s-section
          heading={`Terminology · ${data.terms.total.toLocaleString("en")} ${data.terms.total === 1 ? "term" : "terms"}`}
        >
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              Words that carry weight in this store, found in its vendors,
              product types, navigation, collections, tags and product titles
              {data.primary ? ` (${localeLabel(data.primary.locale, data.primary.name)})` : ""}.
              Shown to the AI when they appear in what it translates; never a
              rule on their own.
            </s-text>
            <s-search-field
              label="Search terms"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search terms"
              value={termQuery}
              onInput={(event) => setTermQuery(event.currentTarget.value)}
              onChange={(event) => {
                setTermQuery(event.currentTarget.value);
                void navigate(pageUrl(data, { term: event.currentTarget.value.trim() }));
              }}
            />
            {data.terms.rows.length === 0 ? (
              <s-text color="subdued">
                {data.terms.search ? "No terms match." : "Nothing learnt yet."}
              </s-text>
            ) : (
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header listSlot="primary">Term</s-table-header>
                  <s-table-header listSlot="secondary">What it is here</s-table-header>
                  <s-table-header>Confidence</s-table-header>
                  <s-table-header>Seen in</s-table-header>
                  <s-table-header listSlot="inline">Actions</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {data.terms.rows.map((row) => (
                    <s-table-row key={row.id}>
                      <s-table-cell>
                        <s-text type="strong">{row.term}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text>
                          {TERM_CLASSIFICATION_LABEL[row.classification]}
                        </s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text color="subdued">{confidenceWord(row.confidence)}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text color="subdued">{row.evidence}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack direction="inline" gap="small-300" alignItems="center">
                          <s-link href={glossaryUrl({ sourceTerm: row.term })}>Override</s-link>
                          <s-button
                            type="button"
                            variant="tertiary"
                            accessibilityLabel={`Forget ${row.term}`}
                            onClick={() =>
                              fetcher.submit({ intent: "forget-term", id: row.id }, { method: "post" })
                            }
                            {...(busy ? { disabled: true } : {})}
                          >
                            Forget
                          </s-button>
                        </s-stack>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
            <Pager
              page={data.terms.page}
              total={data.terms.total}
              onPage={(tp) => void navigate(pageUrl(data, { tp }))}
            />
          </s-stack>
        </s-section>

        <s-section
          heading={`Established translations · ${data.memory.total.toLocaleString("en")}`}
        >
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              How this store has said short strings in each language. The same
              string is translated the same way again; one you wrote yourself
              is kept over the AI&apos;s.
            </s-text>
            <s-grid
              gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr 2fr"
              gap="base"
              alignItems="end"
            >
              <Dropdown
                name="locale"
                label="Language"
                value={data.memory.locale ?? ""}
                options={data.languages.map((language) => ({
                  value: language.locale,
                  label: `${localeLabel(language.locale, language.name)} · ${(data.memory.countsByLocale[language.locale] ?? 0).toLocaleString("en")}`,
                }))}
                onChange={(locale) => void navigate(pageUrl(data, { locale }))}
                disabled={busy}
              />
              <s-search-field
                label="Search translations"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search source text"
                value={memoryQuery}
                onInput={(event) => setMemoryQuery(event.currentTarget.value)}
                onChange={(event) => {
                  setMemoryQuery(event.currentTarget.value);
                  void navigate(pageUrl(data, { memory: event.currentTarget.value.trim() }));
                }}
              />
            </s-grid>
            {data.memory.rows.length === 0 ? (
              <s-text color="subdued">
                {data.memory.search ? "Nothing matches." : "Nothing remembered for this language yet."}
              </s-text>
            ) : (
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header listSlot="primary">Source</s-table-header>
                  <s-table-header listSlot="secondary">Translation</s-table-header>
                  <s-table-header>From</s-table-header>
                  <s-table-header format="numeric">Used</s-table-header>
                  <s-table-header listSlot="inline">Actions</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {data.memory.rows.map((row) => (
                    <s-table-row key={row.id}>
                      <s-table-cell>
                        <s-text>{row.sourceText}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text type="strong">{row.targetText}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        {row.origin === "manual" ? (
                          <s-badge tone="success">Edited by a person</s-badge>
                        ) : (
                          <s-badge>AI</s-badge>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        <s-text color="subdued">{row.usageCount.toLocaleString("en")}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack direction="inline" gap="small-300" alignItems="center">
                          <s-link
                            href={glossaryUrl({
                              sourceTerm: row.sourceText,
                              targetTerm: row.targetText,
                              targetLocale: data.memory.locale ?? "",
                            })}
                          >
                            Make it a rule
                          </s-link>
                          <s-button
                            type="button"
                            variant="tertiary"
                            accessibilityLabel={`Forget the translation of ${row.sourceText}`}
                            onClick={() =>
                              fetcher.submit({ intent: "forget-memory", id: row.id }, { method: "post" })
                            }
                            {...(busy ? { disabled: true } : {})}
                          >
                            Forget
                          </s-button>
                        </s-stack>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
            <Pager
              page={data.memory.page}
              total={data.memory.total}
              onPage={(mp) => void navigate(pageUrl(data, { mp }))}
            />
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

function Facts({ label, values }: { label: string; values: string[] }) {
  const shown = values.slice(0, 40);
  return (
    <s-stack direction="block" gap="small-500">
      <s-text type="strong">{label}</s-text>
      <s-text color="subdued">
        {shown.join(" · ")}
        {values.length > shown.length ? ` · +${values.length - shown.length} more` : ""}
      </s-text>
    </s-stack>
  );
}

function Pager({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  if (pages <= 1) return null;
  return (
    <s-stack direction="inline" gap="base" alignItems="center">
      <s-button
        type="button"
        variant="tertiary"
        onClick={() => onPage(page - 1)}
        {...(page <= 1 ? { disabled: true } : {})}
      >
        Previous
      </s-button>
      <s-text color="subdued">{`Page ${page} of ${pages}`}</s-text>
      <s-button
        type="button"
        variant="tertiary"
        onClick={() => onPage(page + 1)}
        {...(page >= pages ? { disabled: true } : {})}
      >
        Next
      </s-button>
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
