import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useMemo, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
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
import { BulkBar, useSelection } from "~/web/components/bulk-selection";
import { Dropdown } from "~/web/components/dropdown";
import { Columns } from "~/web/components/page-columns";
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
import { useLiveRevalidation } from "~/web/lib/live";

/**
 * Store context (docs/translations.md § Translation intelligence): what
 * the AI has worked out about the store on its own — the kind of store it
 * is, the words that carry weight here, and how it has been saying them in
 * each language — so a merchant can see why a menu label was left in
 * English and correct it where it matters. Nothing here needs filling in:
 * it builds itself before the first translation and follows the store.
 *
 * Four tabs, so a page that knows a lot shows a little: Overview is the
 * counts, the two switches and a line of each thing with a way to it;
 * Terminology and Product knowledge are tables, twenty rows a page, a row
 * opening its detail; AI instructions is what the AI is told, in full.
 *
 * The glossary is where a rule lives. This page shows what the engine
 * learnt; a term it learnt wrongly is forgotten here and, if the merchant
 * wants a particular word, told in the glossary.
 */
const PAGE = 20;

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "terminology", label: "Terminology" },
  { key: "knowledge", label: "Product knowledge" },
  { key: "instructions", label: "AI instructions" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const TERM_MODAL_ID = "term-detail";
const MEMORY_MODAL_ID = "memory-detail";
const KNOWLEDGE_MODAL_ID = "knowledge-detail";

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
      source === "productTitle"
        ? `${count} product titles`
        : (EVIDENCE_LABEL[source] ?? source),
    )
    .join(", ");
}

/** The profile's lists as one kind of thing each, for one table. */
const KNOWLEDGE_KINDS = [
  { key: "brand", label: "Brand" },
  { key: "family", label: "Product family" },
  { key: "abbreviation", label: "Abbreviation" },
  { key: "meaning", label: "Specialised meaning" },
  { key: "vocabulary", label: "Technical vocabulary" },
] as const;
type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number]["key"];
const KNOWLEDGE_LABEL: Record<KnowledgeKind, string> = Object.fromEntries(
  KNOWLEDGE_KINDS.map((k) => [k.key, k.label]),
) as Record<KnowledgeKind, string>;

interface KnowledgeRow {
  id: string;
  kind: KnowledgeKind;
  entry: string;
  meaning: string;
}

function clip(text: string, length: number): string {
  return text.length > length
    ? `${text.slice(0, length - 1).trimEnd()}…`
    : text;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const url = new URL(request.url);
  const tabParam = url.searchParams.get("tab") ?? "";
  const tab: Tab = TABS.some((t) => t.key === tabParam)
    ? (tabParam as Tab)
    : "overview";
  const termSearch = (url.searchParams.get("term") ?? "").trim().slice(0, 60);
  const memorySearch = (url.searchParams.get("memory") ?? "")
    .trim()
    .slice(0, 60);
  const localeParam = url.searchParams.get("locale") ?? "";
  const termPage = Math.max(1, Number(url.searchParams.get("tp") ?? "1") || 1);
  const memoryPage = Math.max(
    1,
    Number(url.searchParams.get("mp") ?? "1") || 1,
  );

  const locales = await listShopLocales(admin);
  const primary =
    locales.kind === "read"
      ? locales.locales.find((l) => l.primary)
      : undefined;
  const targets =
    locales.kind === "read" ? locales.locales.filter((l) => !l.primary) : [];
  const memoryLocale = targets.some((l) => l.locale === localeParam)
    ? localeParam
    : (targets[0]?.locale ?? null);

  const sourceLocale = primary?.locale ?? "";
  const [profile, termTotal, terms, memoryTotal, memory, memoryCounts] =
    await Promise.all([
      getStoreProfile(principal),
      sourceLocale
        ? countTerms(principal, sourceLocale, termSearch || undefined)
        : Promise.resolve(0),
      sourceLocale
        ? listTerms(principal, sourceLocale, {
            search: termSearch || undefined,
            limit: PAGE,
            offset: (termPage - 1) * PAGE,
          })
        : Promise.resolve([]),
      countMemory(principal, {
        targetLocale: memoryLocale,
        search: memorySearch || undefined,
      }),
      listMemory(principal, {
        targetLocale: memoryLocale,
        search: memorySearch || undefined,
        limit: PAGE,
        offset: (memoryPage - 1) * PAGE,
      }),
      memoryCountsByLocale(principal),
    ]);

  const stored = profile?.profile ?? null;
  const knowledge: KnowledgeRow[] = stored
    ? [
        ...stored.likelyBrands.map((entry, i) => ({
          id: `brand-${i}`,
          kind: "brand" as const,
          entry,
          meaning: "",
        })),
        ...stored.productFamilies.map((entry, i) => ({
          id: `family-${i}`,
          kind: "family" as const,
          entry,
          meaning: "",
        })),
        ...stored.commonAbbreviations.map((entry, i) => ({
          id: `abbreviation-${i}`,
          kind: "abbreviation" as const,
          entry: entry.abbreviation,
          meaning: entry.meaning ?? "",
        })),
        ...stored.importantTerminology.map((entry, i) => ({
          id: `meaning-${i}`,
          kind: "meaning" as const,
          entry: entry.term,
          meaning: [
            TERM_CLASSIFICATION_LABEL[entry.classification],
            entry.meaning,
          ]
            .filter(Boolean)
            .join(" — "),
        })),
        ...stored.technicalVocabulary.map((entry, i) => ({
          id: `vocabulary-${i}`,
          kind: "vocabulary" as const,
          entry,
          meaning: "",
        })),
      ]
    : [];

  return {
    tab,
    aiConfigured: isConfigured(),
    primary: primary ? { locale: primary.locale, name: primary.name } : null,
    languages: targets.map((l) => ({ locale: l.locale, name: l.name })),
    profile: profile
      ? {
          summary: profile.summary,
          description: stored?.storeDescription ?? null,
          industries: stored?.industries ?? [],
          audience: stored?.audience ?? "",
          notes: stored?.localisationNotes ?? "",
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
    knowledge,
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
      totalAll: [...memoryCounts.values()].reduce((a, b) => a + b, 0),
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
  const ids = String(formData.get("ids") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, PAGE);

  if (intent === "rebuild") {
    if (!isConfigured())
      return {
        ok: false,
        message: "AI translation is not configured on this server.",
      };
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
    return {
      ok: true,
      message: "Saved. It applies from the next translation.",
    };
  }

  if (intent === "forget-term") {
    const id = String(formData.get("id") ?? "");
    const deleted = await deleteTerm(principal, id);
    return deleted
      ? {
          ok: true,
          message:
            "Term forgotten. It is learnt again only if the store still uses it.",
        }
      : { ok: false, message: "That term is already gone." };
  }

  if (intent === "forget-memory") {
    const id = String(formData.get("id") ?? "");
    const deleted = await deleteMemoryEntry(principal, id);
    return deleted
      ? {
          ok: true,
          message:
            "Forgotten. The next translation of that text decides afresh.",
        }
      : { ok: false, message: "That entry is already gone." };
  }

  // Selected rows, one page at most: the same forgetting, several times.
  if (intent === "forget-terms" || intent === "forget-memories") {
    if (ids.length === 0) return { ok: false, message: "Nothing selected." };
    let count = 0;
    for (const id of ids) {
      const deleted =
        intent === "forget-terms"
          ? await deleteTerm(principal, id)
          : await deleteMemoryEntry(principal, id);
      if (deleted) count += 1;
    }
    return {
      ok: true,
      message:
        intent === "forget-terms"
          ? `${count} ${count === 1 ? "term" : "terms"} forgotten. They are learnt again only if the store still uses them.`
          : `${count} ${count === 1 ? "translation" : "translations"} forgotten. The next translation of that text decides afresh.`,
    };
  }

  return { ok: false, message: "Unknown action." };
};

type LoaderData = Awaited<ReturnType<typeof loader>>;

function pageUrl(
  data: LoaderData,
  patch: Partial<{
    tab: Tab;
    term: string;
    memory: string;
    locale: string;
    tp: number;
    mp: number;
  }>,
): string {
  const search = new URLSearchParams();
  const tab = patch.tab ?? data.tab;
  const term = patch.term ?? data.terms.search;
  const memory = patch.memory ?? data.memory.search;
  const locale = patch.locale ?? data.memory.locale ?? "";
  const tp = patch.tp ?? (patch.term !== undefined ? 1 : data.terms.page);
  const mp =
    patch.mp ??
    (patch.memory !== undefined || patch.locale !== undefined
      ? 1
      : data.memory.page);
  if (tab !== "overview") search.set("tab", tab);
  if (term) search.set("term", term);
  if (memory) search.set("memory", memory);
  if (locale) search.set("locale", locale);
  if (tp > 1) search.set("tp", String(tp));
  if (mp > 1) search.set("mp", String(mp));
  const query = search.toString();
  return query
    ? `${TRANSLATION_ROUTES.context}?${query}`
    : TRANSLATION_ROUTES.context;
}

const n = (value: number) => value.toLocaleString("en");

export default function StoreContext() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const busy = fetcher.state !== "idle";
  useLiveRevalidation({
    active: data.profile?.building ?? false,
    idleEveryMs: null,
  });

  useEffect(() => {
    if (!fetcher.data?.ok) return;
    if (typeof shopify !== "undefined")
      shopify.toast.show(fetcher.data.message);
  }, [fetcher.data]);

  const submit = (body: Record<string, string>) =>
    void fetcher.submit(body, { method: "post" });

  const profile = data.profile;
  const built = profile !== null && profile.generatedAt !== null;

  const settings = (patch: {
    useStoreContext?: boolean;
    learnTerminology?: boolean;
  }) =>
    submit({
      intent: "settings",
      useStoreContext: String(
        patch.useStoreContext ?? profile?.useStoreContext ?? true,
      ),
      learnTerminology: String(
        patch.learnTerminology ?? profile?.learnTerminology ?? true,
      ),
    });

  return (
    <s-page heading="Store context" inlineSize="large">
      <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
        Translations
      </s-link>
      <s-button
        slot="primary-action"
        onClick={() => submit({ intent: "rebuild" })}
        {...(busy || !data.aiConfigured || profile?.building
          ? { disabled: true }
          : {})}
        {...(profile?.building ? { loading: true } : {})}
      >
        {built ? "Read the store again" : "Build now"}
      </s-button>

      <s-stack direction="block" gap="base">
        <TranslationsNav current="context" />

        {fetcher.data && !fetcher.data.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{fetcher.data.message}</s-paragraph>
          </s-banner>
        ) : null}

        {!data.aiConfigured ? (
          <s-banner tone="warning">
            <s-paragraph>
              AI translation is not configured on this server, so the profile
              cannot be built.
            </s-paragraph>
          </s-banner>
        ) : null}

        {/*
         * The tabs: the current one a filled button, the rest plain, the
         * way the admin's own index pages switch views. Each is an address,
         * so a tab survives a reload and can be linked to.
         */}
        <s-stack direction="inline" gap="small-200">
          {TABS.map((tab) => (
            <s-button
              key={tab.key}
              variant={tab.key === data.tab ? "secondary" : "tertiary"}
              href={pageUrl(data, { tab: tab.key })}
              {...(tab.key === data.tab
                ? { accessibilityLabel: `${tab.label}, current` }
                : {})}
            >
              {tab.label}
            </s-button>
          ))}
        </s-stack>

        {data.tab === "overview" ? (
          <Overview
            data={data}
            busy={busy}
            onSettings={settings}
            onRebuild={() => submit({ intent: "rebuild" })}
          />
        ) : null}
        {data.tab === "terminology" ? (
          <Terminology
            data={data}
            busy={busy}
            submit={submit}
            navigate={(url) => void navigate(url)}
          />
        ) : null}
        {data.tab === "knowledge" ? <Knowledge data={data} /> : null}
        {data.tab === "instructions" ? (
          <Instructions data={data} busy={busy} onSettings={settings} />
        ) : null}
      </s-stack>
    </s-page>
  );
}

/* -------------------------------------------------------------------------- */
/* Overview                                                                   */
/* -------------------------------------------------------------------------- */

function Overview({
  data,
  busy,
  onSettings,
}: {
  data: LoaderData;
  busy: boolean;
  onSettings: (patch: {
    useStoreContext?: boolean;
    learnTerminology?: boolean;
  }) => void;
  onRebuild: () => void;
}) {
  const profile = data.profile;
  const built = profile !== null && profile.generatedAt !== null;
  const count = (kind: KnowledgeKind) =>
    data.knowledge.filter((row) => row.kind === kind).length;

  return (
    <s-stack direction="block" gap="base">
      <Columns>
        <s-section heading="What the AI knows">
          <s-stack direction="block" gap="base">
            {!built ? (
              <s-stack direction="block" gap="small-300">
                <s-text>
                  Not built yet. It is built from the store&apos;s own
                  navigation, collections and products before the first
                  translation.
                </s-text>
                {profile?.lastError ? (
                  <s-text tone="critical">
                    Last attempt: {profile.lastError}
                  </s-text>
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
                {profile.description ? (
                  <s-text>{clip(profile.description, 180)}</s-text>
                ) : null}
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-link href={pageUrl(data, { tab: "instructions" })}>
                    View what the AI is told
                  </s-link>
                  <s-text color="subdued">
                    {`Built ${formatDateTime(profile.generatedAt!)} · version ${profile.version}`}
                  </s-text>
                </s-stack>
              </>
            )}
          </s-stack>
        </s-section>

        <s-section heading="How translations use it">
          <s-stack direction="block" gap="base">
            <ToggleRow
              label="Translate with the store in mind"
              checked={profile?.useStoreContext ?? true}
              disabled={busy}
              onChange={(checked) => onSettings({ useStoreContext: checked })}
            />
            <ToggleRow
              label="Learn as the store is translated"
              checked={profile?.learnTerminology ?? true}
              disabled={busy}
              onChange={(checked) => onSettings({ learnTerminology: checked })}
            />
            <s-text color="subdued">
              A{" "}
              <s-link href={TRANSLATION_ROUTES.glossary}>
                terminology override
              </s-link>{" "}
              always wins over anything learnt here.
            </s-text>
          </s-stack>
        </s-section>
      </Columns>

      <s-section heading="Learnt from the store">
        <s-grid
          gridTemplateColumns="@container (inline-size <= 640px) 1fr 1fr, 1fr 1fr 1fr 1fr"
          gap="base"
        >
          <Stat
            label="Terms"
            value={n(data.terms.total)}
            href={pageUrl(data, { tab: "terminology" })}
          />
          <Stat
            label="Established translations"
            value={n(data.memory.totalAll)}
            href={pageUrl(data, { tab: "terminology" })}
          />
          <Stat
            label="Brands and product families"
            value={n(count("brand") + count("family"))}
            href={pageUrl(data, { tab: "knowledge" })}
          />
          <Stat
            label="Abbreviations and meanings"
            value={n(
              count("abbreviation") + count("meaning") + count("vocabulary"),
            )}
            href={pageUrl(data, { tab: "knowledge" })}
          />
        </s-grid>
      </s-section>
    </s-stack>
  );
}

function Stat({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href: string;
}) {
  return (
    <s-stack direction="block" gap="small-500">
      <s-text color="subdued">{label}</s-text>
      <s-text type="strong">{value}</s-text>
      <s-link href={href}>View</s-link>
    </s-stack>
  );
}

/* -------------------------------------------------------------------------- */
/* Terminology: learnt terms and established translations                     */
/* -------------------------------------------------------------------------- */

type TermRow = LoaderData["terms"]["rows"][number];
type MemoryRow = LoaderData["memory"]["rows"][number];

function Terminology({
  data,
  busy,
  submit,
  navigate,
}: {
  data: LoaderData;
  busy: boolean;
  submit: (body: Record<string, string>) => void;
  navigate: (url: string) => void;
}) {
  const [termQuery, setTermQuery] = useState(data.terms.search);
  const [memoryQuery, setMemoryQuery] = useState(data.memory.search);
  const [term, setTerm] = useState<TermRow | null>(null);
  const [entry, setEntry] = useState<MemoryRow | null>(null);
  const termIds = useMemo(() => data.terms.rows.map((r) => r.id), [data]);
  const memoryIds = useMemo(() => data.memory.rows.map((r) => r.id), [data]);
  const terms = useSelection(termIds);
  const memory = useSelection(memoryIds);

  return (
    <s-stack direction="block" gap="base">
      {/* One term, in full, with what can be done about it. */}
      <s-modal id={TERM_MODAL_ID} heading={term?.term ?? "Term"}>
        {term ? (
          <s-stack direction="block" gap="base">
            <Detail label="What it is here">
              {TERM_CLASSIFICATION_LABEL[term.classification]}
            </Detail>
            <Detail label="Confidence">
              {`${confidenceWord(term.confidence)} (${Math.round(term.confidence * 100)}%)`}
            </Detail>
            <Detail label="Seen in">{term.evidence || "—"}</Detail>
            <s-text color="subdued">
              Shown to the AI when it appears in what is translated; never a
              rule on its own. To say how it must be translated, add an
              override.
            </s-text>
          </s-stack>
        ) : null}
        <s-button
          slot="primary-action"
          variant="primary"
          href={term ? glossaryUrl({ sourceTerm: term.term }) : "#"}
        >
          Add an override
        </s-button>
        <s-button
          slot="secondary-actions"
          tone="critical"
          command="--hide"
          commandFor={TERM_MODAL_ID}
          onClick={() => {
            if (term) submit({ intent: "forget-term", id: term.id });
          }}
          {...(busy ? { disabled: true } : {})}
        >
          Forget
        </s-button>
        <s-button
          slot="secondary-actions"
          command="--hide"
          commandFor={TERM_MODAL_ID}
        >
          Close
        </s-button>
      </s-modal>

      {/* One established translation, in full. */}
      <s-modal id={MEMORY_MODAL_ID} heading="Established translation">
        {entry ? (
          <s-stack direction="block" gap="base">
            <Detail label="Source">{entry.sourceText}</Detail>
            <Detail label="Translation">{entry.targetText}</Detail>
            <Detail label="Language">
              {data.memory.locale
                ? localeLabel(
                    data.memory.locale,
                    data.languages.find((l) => l.locale === data.memory.locale)
                      ?.name ?? data.memory.locale,
                  )
                : "—"}
            </Detail>
            <Detail label="From">
              {entry.origin === "manual" ? "Edited by a person" : "AI"}
            </Detail>
            <Detail label="Used">
              {`${n(entry.usageCount)} ${entry.usageCount === 1 ? "time" : "times"}${entry.resourceType ? ` · first seen on a ${entry.resourceType.toLowerCase()}` : ""}`}
            </Detail>
          </s-stack>
        ) : null}
        <s-button
          slot="primary-action"
          variant="primary"
          href={
            entry
              ? glossaryUrl({
                  sourceTerm: entry.sourceText,
                  targetTerm: entry.targetText,
                  targetLocale: data.memory.locale ?? "",
                })
              : "#"
          }
        >
          Make it a rule
        </s-button>
        <s-button
          slot="secondary-actions"
          tone="critical"
          command="--hide"
          commandFor={MEMORY_MODAL_ID}
          onClick={() => {
            if (entry) submit({ intent: "forget-memory", id: entry.id });
          }}
          {...(busy ? { disabled: true } : {})}
        >
          Forget
        </s-button>
        <s-button
          slot="secondary-actions"
          command="--hide"
          commandFor={MEMORY_MODAL_ID}
        >
          Close
        </s-button>
      </s-modal>

      <s-section heading={`Terms · ${n(data.terms.total)}`}>
        <s-stack direction="block" gap="base">
          <s-text color="subdued">
            Words that carry weight in this store, found in its own data
            {data.primary
              ? ` (${localeLabel(data.primary.locale, data.primary.name)})`
              : ""}
            . Open one for where it was seen.
          </s-text>
          <s-table variant="auto">
            <s-search-field
              slot="filters"
              label="Search terms"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search terms"
              value={termQuery}
              onInput={(event) => setTermQuery(event.currentTarget.value)}
              onChange={(event) => {
                setTermQuery(event.currentTarget.value);
                navigate(
                  pageUrl(data, { term: event.currentTarget.value.trim() }),
                );
              }}
            />
            <s-table-header-row>
              <s-table-header listSlot="inline">
                <s-checkbox
                  label="Select every term on this page"
                  labelAccessibilityVisibility="exclusive"
                  checked={terms.all}
                  onChange={(e) => terms.toggleAll(e.currentTarget.checked)}
                />
              </s-table-header>
              <s-table-header listSlot="primary">Term</s-table-header>
              <s-table-header listSlot="secondary">Type</s-table-header>
              <s-table-header listSlot="labeled">Confidence</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.terms.rows.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>
                    <s-checkbox
                      label={`Select ${row.term}`}
                      labelAccessibilityVisibility="exclusive"
                      checked={terms.selected.has(row.id)}
                      onChange={(e) =>
                        terms.toggle(row.id, e.currentTarget.checked)
                      }
                    />
                  </s-table-cell>
                  <s-table-cell>
                    <s-clickable
                      command="--show"
                      commandFor={TERM_MODAL_ID}
                      accessibilityLabel={`Open ${row.term}`}
                      onClick={() => setTerm(row)}
                    >
                      <s-text type="strong">{row.term}</s-text>
                    </s-clickable>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text>
                      {TERM_CLASSIFICATION_LABEL[row.classification]}
                    </s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge
                      {...(row.confidence < 0.6
                        ? { tone: "caution" as const }
                        : {})}
                    >
                      {confidenceWord(row.confidence)}
                    </s-badge>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          {data.terms.rows.length === 0 ? (
            <s-text color="subdued">
              {data.terms.search ? "No terms match." : "Nothing learnt yet."}
            </s-text>
          ) : null}
          <s-stack
            direction="inline"
            gap="base"
            alignItems="center"
            justifyContent="space-between"
          >
            <BulkBar
              count={terms.selected.size}
              noun={terms.selected.size === 1 ? "term" : "terms"}
              actions={[
                {
                  label: "Forget selected",
                  tone: "critical",
                  onAct: () =>
                    submit({
                      intent: "forget-terms",
                      ids: [...terms.selected].join(","),
                    }),
                },
              ]}
              busy={busy}
              onClear={terms.clear}
            />
            <Pager
              page={data.terms.page}
              total={data.terms.total}
              onPage={(tp) => navigate(pageUrl(data, { tp }))}
            />
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading={`Established translations · ${n(data.memory.total)}`}>
        <s-stack direction="block" gap="base">
          <s-text color="subdued">
            How this store has said short strings in each language. The same
            string is translated the same way again.
          </s-text>
          <s-table variant="auto">
            <s-grid
              slot="filters"
              gridTemplateColumns="@container (inline-size <= 560px) 1fr, auto 1fr"
              gap="small-300"
              alignItems="center"
            >
              <s-box minInlineSize="200px">
                <Dropdown
                  name="locale"
                  label="Language"
                  hideLabel
                  value={data.memory.locale ?? ""}
                  options={data.languages.map((language) => ({
                    value: language.locale,
                    label: `${localeLabel(language.locale, language.name)} · ${n(data.memory.countsByLocale[language.locale] ?? 0)}`,
                  }))}
                  onChange={(locale) => navigate(pageUrl(data, { locale }))}
                  disabled={busy}
                />
              </s-box>
              <s-search-field
                label="Search translations"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search source text"
                value={memoryQuery}
                onInput={(event) => setMemoryQuery(event.currentTarget.value)}
                onChange={(event) => {
                  setMemoryQuery(event.currentTarget.value);
                  navigate(
                    pageUrl(data, {
                      memory: event.currentTarget.value.trim(),
                    }),
                  );
                }}
              />
            </s-grid>
            <s-table-header-row>
              <s-table-header listSlot="inline">
                <s-checkbox
                  label="Select every translation on this page"
                  labelAccessibilityVisibility="exclusive"
                  checked={memory.all}
                  onChange={(e) => memory.toggleAll(e.currentTarget.checked)}
                />
              </s-table-header>
              <s-table-header listSlot="primary">Source</s-table-header>
              <s-table-header listSlot="secondary">Translation</s-table-header>
              <s-table-header listSlot="labeled">From</s-table-header>
              <s-table-header format="numeric">Used</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.memory.rows.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>
                    <s-checkbox
                      label={`Select ${row.sourceText}`}
                      labelAccessibilityVisibility="exclusive"
                      checked={memory.selected.has(row.id)}
                      onChange={(e) =>
                        memory.toggle(row.id, e.currentTarget.checked)
                      }
                    />
                  </s-table-cell>
                  <s-table-cell>
                    <s-clickable
                      command="--show"
                      commandFor={MEMORY_MODAL_ID}
                      accessibilityLabel={`Open ${row.sourceText}`}
                      onClick={() => setEntry(row)}
                    >
                      <s-text>{clip(row.sourceText, 60)}</s-text>
                    </s-clickable>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text type="strong">{clip(row.targetText, 60)}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    {row.origin === "manual" ? (
                      <s-badge tone="success">Person</s-badge>
                    ) : (
                      <s-badge>AI</s-badge>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <s-text color="subdued">{n(row.usageCount)}</s-text>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          {data.memory.rows.length === 0 ? (
            <s-text color="subdued">
              {data.memory.search
                ? "Nothing matches."
                : "Nothing remembered for this language yet."}
            </s-text>
          ) : null}
          <s-stack
            direction="inline"
            gap="base"
            alignItems="center"
            justifyContent="space-between"
          >
            <BulkBar
              count={memory.selected.size}
              noun={memory.selected.size === 1 ? "translation" : "translations"}
              actions={[
                {
                  label: "Forget selected",
                  tone: "critical",
                  onAct: () =>
                    submit({
                      intent: "forget-memories",
                      ids: [...memory.selected].join(","),
                    }),
                },
              ]}
              busy={busy}
              onClear={memory.clear}
            />
            <Pager
              page={data.memory.page}
              total={data.memory.total}
              onPage={(mp) => navigate(pageUrl(data, { mp }))}
            />
          </s-stack>
        </s-stack>
      </s-section>
    </s-stack>
  );
}

/* -------------------------------------------------------------------------- */
/* Product knowledge: the profile's lists as one table                        */
/* -------------------------------------------------------------------------- */

function Knowledge({ data }: { data: LoaderData }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KnowledgeKind | "">("");
  const [page, setPage] = useState(1);
  const [row, setRow] = useState<KnowledgeRow | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.knowledge.filter(
      (entry) =>
        (!kind || entry.kind === kind) &&
        (!q ||
          entry.entry.toLowerCase().includes(q) ||
          entry.meaning.toLowerCase().includes(q)),
    );
  }, [data.knowledge, query, kind]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(page, pages);
  const shown = rows.slice((current - 1) * PAGE, current * PAGE);

  return (
    <s-section heading={`Product knowledge · ${n(rows.length)}`}>
      <s-modal id={KNOWLEDGE_MODAL_ID} heading={row?.entry ?? "Entry"}>
        {row ? (
          <s-stack direction="block" gap="base">
            <Detail label="Kind">{KNOWLEDGE_LABEL[row.kind]}</Detail>
            {row.meaning ? (
              <Detail label="Meaning">{row.meaning}</Detail>
            ) : null}
            <s-text color="subdued">
              Read from the store by the AI when the profile was built. Read the
              store again to refresh it; add an override to fix how it is
              translated.
            </s-text>
          </s-stack>
        ) : null}
        <s-button
          slot="primary-action"
          variant="primary"
          href={row ? glossaryUrl({ sourceTerm: row.entry }) : "#"}
        >
          Add an override
        </s-button>
        <s-button
          slot="secondary-actions"
          command="--hide"
          commandFor={KNOWLEDGE_MODAL_ID}
        >
          Close
        </s-button>
      </s-modal>

      <s-stack direction="block" gap="base">
        <s-text color="subdued">
          Brands, product families, abbreviations and specialised meanings the
          AI read from the store. Open one for its meaning.
        </s-text>
        <s-table variant="auto">
          <s-grid
            slot="filters"
            gridTemplateColumns="@container (inline-size <= 560px) 1fr, auto 1fr"
            gap="small-300"
            alignItems="center"
          >
            <s-box minInlineSize="200px">
              <Dropdown
                name="kind"
                label="Kind"
                hideLabel
                value={kind}
                options={[
                  { value: "", label: "All kinds" },
                  ...KNOWLEDGE_KINDS.map((k) => ({
                    value: k.key,
                    label: `${k.label} · ${n(data.knowledge.filter((r) => r.kind === k.key).length)}`,
                  })),
                ]}
                onChange={(value) => {
                  setKind(value as KnowledgeKind | "");
                  setPage(1);
                }}
              />
            </s-box>
            <s-search-field
              label="Search product knowledge"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search"
              value={query}
              onInput={(event) => {
                setQuery(event.currentTarget.value);
                setPage(1);
              }}
            />
          </s-grid>
          <s-table-header-row>
            <s-table-header listSlot="primary">Entry</s-table-header>
            <s-table-header listSlot="secondary">Kind</s-table-header>
            <s-table-header listSlot="labeled">Meaning</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {shown.map((entry) => (
              <s-table-row key={entry.id}>
                <s-table-cell>
                  <s-clickable
                    command="--show"
                    commandFor={KNOWLEDGE_MODAL_ID}
                    accessibilityLabel={`Open ${entry.entry}`}
                    onClick={() => setRow(entry)}
                  >
                    <s-text type="strong">{entry.entry}</s-text>
                  </s-clickable>
                </s-table-cell>
                <s-table-cell>
                  <s-badge>{KNOWLEDGE_LABEL[entry.kind]}</s-badge>
                </s-table-cell>
                <s-table-cell>
                  <s-text color="subdued">
                    {entry.meaning ? clip(entry.meaning, 80) : "—"}
                  </s-text>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {shown.length === 0 ? (
          <s-text color="subdued">
            {data.knowledge.length === 0
              ? "Nothing read yet. The profile is built before the first translation."
              : "Nothing matches."}
          </s-text>
        ) : null}
        <s-stack direction="inline" justifyContent="end">
          <Pager page={current} total={rows.length} onPage={setPage} />
        </s-stack>
      </s-stack>
    </s-section>
  );
}

/* -------------------------------------------------------------------------- */
/* AI instructions: what the AI is told, and the switches                     */
/* -------------------------------------------------------------------------- */

function Instructions({
  data,
  busy,
  onSettings,
}: {
  data: LoaderData;
  busy: boolean;
  onSettings: (patch: {
    useStoreContext?: boolean;
    learnTerminology?: boolean;
  }) => void;
}) {
  const profile = data.profile;
  const built = profile !== null && profile.generatedAt !== null;

  return (
    <Columns>
      <s-section heading="What the AI is told">
        <s-stack direction="block" gap="base">
          {!built ? (
            <s-text color="subdued">
              Not built yet. It is built from the store&apos;s own navigation,
              collections and products before the first translation, and read
              again when the store changes.
            </s-text>
          ) : (
            <>
              <Detail label="The store">{profile.description ?? "—"}</Detail>
              {profile.audience ? (
                <Detail label="Audience">{profile.audience}</Detail>
              ) : null}
              {profile.notes ? (
                <Detail label="Notes for translators">{profile.notes}</Detail>
              ) : null}
              <s-text color="subdued">
                {`Built ${formatDateTime(profile.generatedAt!)}${
                  profile.sampleStats
                    ? ` from ${n(profile.sampleStats.products)} products, ${n(profile.sampleStats.collections)} collections and ${n(profile.sampleStats.menuItems)} menu items`
                    : ""
                }${profile.checkedAt ? ` · checked ${formatDateTime(profile.checkedAt)}` : ""} · version ${profile.version}.`}
              </s-text>
            </>
          )}
          {profile?.lastError ? (
            <s-text tone="critical">Last attempt: {profile.lastError}</s-text>
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
            onChange={(checked) => onSettings({ useStoreContext: checked })}
          />
          <ToggleRow
            label="Learn as the store is translated"
            description="Terms are found in the store's own data, and each language remembers how short strings were translated so the same term is never translated two ways. A translation you write yourself is remembered first."
            checked={profile?.learnTerminology ?? true}
            disabled={busy}
            onChange={(checked) => onSettings({ learnTerminology: checked })}
          />
          <s-text color="subdued">
            Want a particular word? A{" "}
            <s-link href={TRANSLATION_ROUTES.glossary}>
              terminology override
            </s-link>{" "}
            always wins over anything learnt here.
          </s-text>
        </s-stack>
      </s-section>
    </Columns>
  );
}

/* -------------------------------------------------------------------------- */

function Detail({ label, children }: { label: string; children: string }) {
  return (
    <s-stack direction="block" gap="small-500">
      <s-text color="subdued">{label}</s-text>
      <s-text>{children}</s-text>
    </s-stack>
  );
}

function Pager({
  page,
  total,
  onPage,
}: {
  page: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  if (pages <= 1) return null;
  return (
    <s-stack direction="inline" gap="base" alignItems="center">
      <s-button
        type="button"
        variant="tertiary"
        icon="chevron-left"
        accessibilityLabel="Previous page"
        onClick={() => onPage(page - 1)}
        {...(page <= 1 ? { disabled: true } : {})}
      />
      <s-text color="subdued">{`${page} of ${pages}`}</s-text>
      <s-button
        type="button"
        variant="tertiary"
        icon="chevron-right"
        accessibilityLabel="Next page"
        onClick={() => onPage(page + 1)}
        {...(page >= pages ? { disabled: true } : {})}
      />
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
