import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useRef, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  addGlossaryTerm,
  deleteGlossaryTerm,
  listGlossary,
  updateGlossaryTerm,
} from "~/adapters/db/repositories/translations.server";
import { listShopLocales } from "~/adapters/shopify/locales";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { isLocaleCode } from "~/adapters/shopify/translations";
import {
  glossaryConflict,
  type GlossaryConflict,
} from "~/domain/translations/glossary";
import { describeLanguage } from "~/domain/translations/languages";
import type { GlossaryTerm } from "~/domain/translations/types";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { Dropdown, type DropdownOption } from "~/web/components/dropdown";
import type { LanguageLabelInfo } from "~/web/components/language-label";
import { LocaleFlag } from "~/web/components/locale-flag";
import { TranslationsNav } from "~/web/components/translations-nav";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import {
  TRANSLATION_ROUTES,
  glossaryPrefill,
  type GlossaryPrefill,
} from "~/web/lib/translations";

/**
 * Terminology overrides — the glossary (docs/translations.md § Terminology
 * overrides): terms the AI must translate a given way in a given language,
 * and terms it must never translate at all. Sent with every request for the
 * language, above everything the engine learnt on its own; a change applies
 * from the next translation, and does not rewrite what is already in
 * Shopify. A store translates well with none of these: they exist for the
 * word a business wants exactly so.
 *
 * Opened from the Store context page with `?term=…` the dialog starts
 * filled with the learnt term or the established translation, so an
 * override is one confirmation away from the thing it overrides.
 *
 * One table of rules, one dialog to add or edit a rule. Two rules about the
 * same term in the same language would contradict each other in the prompt,
 * so the action refuses the second (`glossaryConflict`) and names the first.
 *
 * A language is named the way every translations screen names it — its flag
 * and its English name (`describeLanguage`, `LocaleFlag`) — and a rule for
 * every language at once carries the globe the same component draws for a
 * language with no country.
 */
const TERM_MODAL_ID = "glossary-term";
const DELETE_MODAL_ID = "glossary-delete";
const EVERY_LANGUAGE = "All languages";

type Kind = GlossaryTerm["kind"];

const KIND_LABEL: Record<Kind, string> = {
  translate: "Translate as",
  protect: "Never translate",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const prefill = glossaryPrefill(new URL(request.url).searchParams);
  const [terms, locales] = await Promise.all([
    listGlossary(principal),
    listShopLocales(admin),
  ]);
  const languages: LanguageLabelInfo[] =
    locales.kind === "read"
      ? locales.locales
          .filter((l) => !l.primary)
          .map((l) => describeLanguage(l.locale, l.name))
      : [];
  /*
   * A rule can name a language Shopify no longer has. It is still shown,
   * still editable and still filterable, under the name the language had.
   */
  const gone = [
    ...new Set(
      terms.flatMap((term) => (term.targetLocale ? [term.targetLocale] : [])),
    ),
  ]
    .filter((locale) => !languages.some((l) => l.locale === locale))
    .map((locale) => describeLanguage(locale));
  return {
    terms: terms.map((term) => ({
      id: term.id,
      kind: term.kind,
      targetLocale: term.targetLocale,
      sourceTerm: term.sourceTerm,
      targetTerm: term.targetTerm,
      note: term.note,
    })),
    languages,
    goneLanguages: gone,
    prefill,
  };
};

type Intent = "add" | "edit" | "delete";

interface ActionResult {
  ok: boolean;
  intent: Intent;
  message: string;
}

/** The rule as the form sent it, or what is wrong with it. */
function readTerm(
  formData: FormData,
): { term: GlossaryTerm & { note: string | null } } | { message: string } {
  const kind = String(formData.get("kind") ?? "");
  const sourceTerm = String(formData.get("sourceTerm") ?? "").trim();
  const targetTerm = String(formData.get("targetTerm") ?? "").trim();
  const targetLocale = String(formData.get("targetLocale") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  if (kind !== "translate" && kind !== "protect")
    return { message: "Unknown rule." };
  if (sourceTerm === "") return { message: "Enter the term." };
  if (kind === "translate") {
    if (targetTerm === "") return { message: "Enter the translation." };
    if (targetLocale !== "" && !isLocaleCode(targetLocale))
      return { message: "Unknown language." };
  }
  return {
    term: {
      kind,
      sourceTerm,
      targetTerm: kind === "translate" ? targetTerm : null,
      targetLocale:
        kind === "translate" && targetLocale !== "" ? targetLocale : null,
      note: note === "" ? null : note,
    },
  };
}

function conflictMessage(conflict: GlossaryConflict): string {
  const term = `“${conflict.existing.sourceTerm}”`;
  const where = conflict.existing.targetLocale
    ? `for ${describeLanguage(conflict.existing.targetLocale).name}`
    : "for all languages";
  switch (conflict.reason) {
    case "protected":
      return `${term} is already never translated. Edit that rule instead.`;
    case "translated":
      return `${term} is already translated as “${conflict.existing.targetTerm ?? ""}” ${where}. Remove that rule to keep the term as written.`;
    case "same_language":
      return `${term} already has a rule ${where}. Edit that rule instead.`;
  }
}

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionResult> => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "add" || intent === "edit") {
    const read = readTerm(formData);
    if ("message" in read) return { ok: false, intent, message: read.message };
    const id = intent === "edit" ? String(formData.get("id") ?? "") : null;
    const others = (await listGlossary(principal)).filter(
      (row) => row.id !== id,
    );
    const conflict = glossaryConflict(others, read.term);
    if (conflict)
      return { ok: false, intent, message: conflictMessage(conflict) };

    if (id === null) {
      await addGlossaryTerm(principal, read.term);
    } else {
      const updated = await updateGlossaryTerm(principal, id, read.term);
      if (!updated)
        return { ok: false, intent, message: "That term is already gone." };
    }
    await appendEvent(principal, {
      entityType: "translation_glossary",
      event:
        id === null
          ? "translation_glossary.added"
          : "translation_glossary.updated",
      detail: {
        kind: read.term.kind,
        sourceTerm: read.term.sourceTerm,
        targetLocale: read.term.targetLocale,
        by: actorFromSession(session),
      },
    });
    return {
      ok: true,
      intent,
      message:
        id === null
          ? "Term added. It applies from the next translation."
          : "Term saved. It applies from the next translation.",
    };
  }

  if (intent === "delete") {
    const id = String(formData.get("id") ?? "");
    const deleted = await deleteGlossaryTerm(principal, id);
    return deleted
      ? { ok: true, intent, message: "Term removed." }
      : { ok: false, intent, message: "That term is already gone." };
  }
  return { ok: false, intent: "add", message: "Unknown action." };
};

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

interface Row {
  id: string;
  kind: Kind;
  targetLocale: string | null;
  sourceTerm: string;
  targetTerm: string | null;
  note: string | null;
}

interface Draft {
  id: string | null;
  kind: Kind;
  sourceTerm: string;
  targetTerm: string;
  targetLocale: string;
  note: string;
}

const BLANK_DRAFT: Draft = {
  id: null,
  kind: "translate",
  sourceTerm: "",
  targetTerm: "",
  targetLocale: "",
  note: "",
};

type Overlay = { showOverlay?: () => void; hideOverlay?: () => void };

function draftFrom(prefill: GlossaryPrefill): Draft {
  return {
    id: null,
    kind: "translate",
    sourceTerm: prefill.sourceTerm,
    targetTerm: prefill.targetTerm,
    targetLocale: prefill.targetLocale,
    note: "",
  };
}

export default function Glossary() {
  const { terms, languages, goneLanguages, prefill } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";

  const [draft, setDraft] = useState<Draft>(
    prefill ? draftFrom(prefill) : BLANK_DRAFT,
  );
  const [tried, setTried] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Row | null>(null);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [languageFilter, setLanguageFilter] = useState("");
  const modal = useRef<Overlay | null>(null);

  /*
   * The dialog stays open until the server agrees: a rule that clashes with
   * an existing one comes back as an error against the form, where the
   * merchant can change it, rather than as a banner over a closed dialog.
   */
  // Arriving with a term to override: the dialog is already the point.
  useEffect(() => {
    if (prefill) modal.current?.showOverlay?.();
  }, [prefill]);

  useEffect(() => {
    const result = fetcher.data;
    if (!result) return;
    if (result.ok) {
      if (typeof shopify !== "undefined") shopify.toast.show(result.message);
      if (result.intent !== "delete") modal.current?.hideOverlay?.();
    } else if (result.intent !== "delete") {
      setFormError(result.message);
    }
  }, [fetcher.data]);

  const known = new Map(
    [...languages, ...goneLanguages].map((l) => [l.locale, l] as const),
  );
  const languageOf = (locale: string): LanguageLabelInfo =>
    known.get(locale) ?? describeLanguage(locale);
  const nameOf = (locale: string | null) =>
    locale === null ? EVERY_LANGUAGE : languageOf(locale).name;

  const languageOption = (l: LanguageLabelInfo): DropdownOption => ({
    value: l.locale,
    label: l.name,
    icon: (
      <LocaleFlag
        regionCode={l.regionCode}
        regionName={l.regionName}
        size="small"
      />
    ),
  });
  const everyLanguage = (value: string): DropdownOption => ({
    value,
    label: EVERY_LANGUAGE,
    icon: <LocaleFlag regionCode={null} size="small" />,
  });

  const open = (next: Draft) => {
    setDraft(next);
    setTried(false);
    setFormError(null);
  };

  const sourceError =
    tried && draft.sourceTerm.trim() === "" ? "Enter the term." : undefined;
  const targetError =
    tried && draft.kind === "translate" && draft.targetTerm.trim() === ""
      ? "Enter the translation."
      : undefined;

  const save = () => {
    setTried(true);
    setFormError(null);
    if (draft.sourceTerm.trim() === "") return;
    if (draft.kind === "translate" && draft.targetTerm.trim() === "") return;
    fetcher.submit(
      {
        intent: draft.id === null ? "add" : "edit",
        id: draft.id ?? "",
        kind: draft.kind,
        sourceTerm: draft.sourceTerm,
        targetTerm: draft.kind === "translate" ? draft.targetTerm : "",
        targetLocale: draft.kind === "translate" ? draft.targetLocale : "",
        note: draft.note,
      },
      { method: "post" },
    );
  };

  /*
   * A language Shopify no longer has stays choosable while its rule is being
   * edited, so opening the rule does not silently move it to every language.
   */
  const languageOptions: DropdownOption[] = [
    everyLanguage(""),
    ...languages.map(languageOption),
    ...(draft.targetLocale !== "" &&
    !languages.some((l) => l.locale === draft.targetLocale)
      ? [languageOption(languageOf(draft.targetLocale))]
      : []),
  ];

  const needle = query.trim().toLocaleLowerCase();
  const shown = terms
    .filter((term) => kindFilter === "" || term.kind === kindFilter)
    .filter((term) =>
      languageFilter === ""
        ? true
        : languageFilter === "all"
          ? term.targetLocale === null
          : term.targetLocale === languageFilter,
    )
    .filter(
      (term) =>
        needle === "" ||
        [
          term.sourceTerm,
          term.targetTerm ?? "",
          term.note ?? "",
          nameOf(term.targetLocale),
        ].some((value) => value.toLocaleLowerCase().includes(needle)),
    )
    .sort(
      (a, b) =>
        a.sourceTerm.localeCompare(b.sourceTerm, undefined, {
          sensitivity: "base",
        }) || (a.targetLocale ?? "").localeCompare(b.targetLocale ?? ""),
    );
  const filtered =
    query.trim() !== "" || kindFilter !== "" || languageFilter !== "";

  return (
    <s-page heading="Terminology overrides">
      <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
        Translations
      </s-link>

      {terms.length > 0 ? (
        <s-button
          slot="primary-action"
          variant="primary"
          command="--show"
          commandFor={TERM_MODAL_ID}
          onClick={() => open(BLANK_DRAFT)}
        >
          Add term
        </s-button>
      ) : null}

      <s-modal
        id={TERM_MODAL_ID}
        heading={draft.id === null ? "Add term" : `Edit “${draft.sourceTerm}”`}
        ref={(element) => {
          modal.current = (element as Overlay | null) ?? null;
        }}
      >
        <s-stack direction="block" gap="base">
          {formError ? (
            <s-banner tone="critical" heading="That rule cannot be saved">
              <s-paragraph>{formError}</s-paragraph>
            </s-banner>
          ) : null}

          <s-choice-list
            label="Rule"
            name="kind"
            values={[draft.kind]}
            onChange={(event) => {
              const next = event.currentTarget.values[0];
              if (next === "translate" || next === "protect")
                setDraft({ ...draft, kind: next });
            }}
            {...(busy ? { disabled: true } : {})}
          >
            <s-choice value="translate">
              Translate as
              <s-text slot="details">
                Always becomes the given translation, in one language or all.
              </s-text>
            </s-choice>
            <s-choice value="protect">
              Never translate
              <s-text slot="details">
                A brand, a product name, a model number: kept exactly as written
                in every language.
              </s-text>
            </s-choice>
          </s-choice-list>

          <s-text-field
            label="Source term"
            placeholder="Boom"
            value={draft.sourceTerm}
            onInput={(event) =>
              setDraft({ ...draft, sourceTerm: event.currentTarget.value })
            }
            onChange={(event) =>
              setDraft({ ...draft, sourceTerm: event.currentTarget.value })
            }
            {...(sourceError ? { error: sourceError } : {})}
            {...(busy ? { disabled: true } : {})}
          />

          {draft.kind === "translate" ? (
            <s-grid
              gridTemplateColumns="@container (inline-size <= 480px) 1fr, 1fr 1fr"
              gap="base"
              alignItems="start"
            >
              <s-text-field
                label="Translation"
                placeholder="Gabelbaum"
                value={draft.targetTerm}
                onInput={(event) =>
                  setDraft({ ...draft, targetTerm: event.currentTarget.value })
                }
                onChange={(event) =>
                  setDraft({ ...draft, targetTerm: event.currentTarget.value })
                }
                {...(targetError ? { error: targetError } : {})}
                {...(busy ? { disabled: true } : {})}
              />
              <Dropdown
                name="targetLocale"
                label="Language"
                value={draft.targetLocale}
                options={languageOptions}
                onChange={(value) =>
                  setDraft({ ...draft, targetLocale: value })
                }
                disabled={busy}
              />
            </s-grid>
          ) : null}

          <s-text-field
            label="Internal note (optional)"
            details="For your team. Not sent to the AI."
            placeholder="Why this rule exists"
            value={draft.note}
            onInput={(event) =>
              setDraft({ ...draft, note: event.currentTarget.value })
            }
            onChange={(event) =>
              setDraft({ ...draft, note: event.currentTarget.value })
            }
            {...(busy ? { disabled: true } : {})}
          />
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={save}
          {...(busy ? { disabled: true, loading: true } : {})}
        >
          {draft.id === null ? "Add term" : "Save"}
        </s-button>
        <s-button
          slot="secondary-actions"
          command="--hide"
          commandFor={TERM_MODAL_ID}
        >
          Cancel
        </s-button>
      </s-modal>

      <ConfirmModal
        id={DELETE_MODAL_ID}
        heading={`Remove “${pendingDelete?.sourceTerm ?? ""}”?`}
        confirmLabel="Remove term"
        onConfirm={() => {
          if (pendingDelete)
            fetcher.submit(
              { intent: "delete", id: pendingDelete.id },
              { method: "post" },
            );
        }}
      >
        <s-paragraph>
          {pendingDelete?.kind === "protect"
            ? "The AI may translate it from the next translation on. Translations already in Shopify do not change."
            : "The AI decides its translation from the next translation on. Translations already in Shopify do not change."}
        </s-paragraph>
      </ConfirmModal>

      <s-stack direction="block" gap="large">
        <TranslationsNav current="glossary" />

        {fetcher.data &&
        !fetcher.data.ok &&
        fetcher.data.intent === "delete" ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{fetcher.data.message}</s-paragraph>
          </s-banner>
        ) : null}

        {terms.length === 0 ? (
          <s-section>
            <s-box paddingBlock="large-100">
              <s-stack direction="block" gap="base" alignItems="center">
                <s-stack direction="block" gap="small-300" alignItems="center">
                  <s-heading>No overrides yet</s-heading>
                  <s-text color="subdued">
                    None are needed for a good translation: the AI learns the
                    store&apos;s terminology on its own (see{" "}
                    <s-link href={TRANSLATION_ROUTES.context}>
                      Store context
                    </s-link>
                    ). Add a rule when a word must be exactly so — a brand kept
                    as written, a term always translated the same way. Rules
                    apply from the next translation.
                  </s-text>
                </s-stack>
                <s-button
                  variant="primary"
                  command="--show"
                  commandFor={TERM_MODAL_ID}
                  onClick={() => open(BLANK_DRAFT)}
                >
                  Add term
                </s-button>
              </s-stack>
            </s-box>
          </s-section>
        ) : (
          <s-section>
            <s-stack direction="block" gap="base">
              <s-text color="subdued">
                Rules the AI must follow, above everything it learnt about the
                store on its own (see{" "}
                <s-link href={TRANSLATION_ROUTES.context}>Store context</s-link>
                ). Sent with every AI translation; a change applies from the
                next translation and does not rewrite what is already in
                Shopify.
              </s-text>

              <s-table variant="auto">
                <s-grid
                  slot="filters"
                  gridTemplateColumns="@container (inline-size <= 640px) 1fr, auto auto 1fr"
                  gap="small-300"
                  alignItems="center"
                >
                  <s-box minInlineSize="160px">
                    <Dropdown
                      name="kindFilter"
                      label="Rule"
                      hideLabel
                      value={kindFilter}
                      options={[
                        { value: "", label: "All rules" },
                        { value: "translate", label: KIND_LABEL.translate },
                        { value: "protect", label: KIND_LABEL.protect },
                      ]}
                      onChange={setKindFilter}
                    />
                  </s-box>
                  <s-box minInlineSize="200px">
                    <Dropdown
                      name="languageFilter"
                      label="Language"
                      hideLabel
                      value={languageFilter}
                      options={[
                        { value: "", label: "Any language" },
                        everyLanguage("all"),
                        ...languages.map(languageOption),
                        ...goneLanguages.map(languageOption),
                      ]}
                      onChange={setLanguageFilter}
                    />
                  </s-box>
                  <s-search-field
                    label="Search terms"
                    labelAccessibilityVisibility="exclusive"
                    placeholder="Search terms, translations and notes"
                    value={query}
                    onInput={(event) => setQuery(event.currentTarget.value)}
                  />
                </s-grid>

                <s-table-header-row>
                  <s-table-header listSlot="primary">Term</s-table-header>
                  <s-table-header listSlot="inline">Rule</s-table-header>
                  <s-table-header listSlot="secondary">
                    Translation
                  </s-table-header>
                  <s-table-header listSlot="labeled">Language</s-table-header>
                  <s-table-header listSlot="labeled">Note</s-table-header>
                  <s-table-header listSlot="inline">Actions</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {shown.map((term) => (
                    <s-table-row key={term.id}>
                      <s-table-cell>
                        <s-text type="strong">{term.sourceTerm}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text>{KIND_LABEL[term.kind]}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        {term.targetTerm ? (
                          <s-text>{term.targetTerm}</s-text>
                        ) : (
                          <s-text color="subdued">—</s-text>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack
                          direction="inline"
                          gap="small-200"
                          alignItems="center"
                        >
                          {term.targetLocale === null ? (
                            <LocaleFlag regionCode={null} size="small" />
                          ) : (
                            <LocaleFlag
                              regionCode={
                                languageOf(term.targetLocale).regionCode
                              }
                              regionName={
                                languageOf(term.targetLocale).regionName
                              }
                              size="small"
                            />
                          )}
                          <s-text>{nameOf(term.targetLocale)}</s-text>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text color="subdued">{term.note ?? ""}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-button
                          icon="menu-horizontal"
                          variant="tertiary"
                          accessibilityLabel={`Actions for ${term.sourceTerm}`}
                          command="--show"
                          commandFor={`term-menu-${term.id}`}
                          {...(busy ? { disabled: true } : {})}
                        />
                        <s-menu
                          id={`term-menu-${term.id}`}
                          accessibilityLabel={`Actions for ${term.sourceTerm}`}
                        >
                          <s-button
                            command="--show"
                            commandFor={TERM_MODAL_ID}
                            onClick={() =>
                              open({
                                id: term.id,
                                kind: term.kind,
                                sourceTerm: term.sourceTerm,
                                targetTerm: term.targetTerm ?? "",
                                targetLocale: term.targetLocale ?? "",
                                note: term.note ?? "",
                              })
                            }
                          >
                            Edit
                          </s-button>
                          <s-button
                            tone="critical"
                            command="--show"
                            commandFor={DELETE_MODAL_ID}
                            onClick={() => setPendingDelete(term)}
                          >
                            Remove
                          </s-button>
                        </s-menu>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>

              {shown.length === 0 ? (
                <s-box paddingBlock="large-100">
                  <s-stack direction="block" gap="base" alignItems="center">
                    <s-text color="subdued">No terms match this search.</s-text>
                    {filtered ? (
                      <s-button
                        variant="secondary"
                        onClick={() => {
                          setQuery("");
                          setKindFilter("");
                          setLanguageFilter("");
                        }}
                      >
                        Clear filters
                      </s-button>
                    ) : null}
                  </s-stack>
                </s-box>
              ) : null}
            </s-stack>
          </s-section>
        )}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
