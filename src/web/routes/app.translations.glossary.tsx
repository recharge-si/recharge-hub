import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useState } from "react";
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
} from "~/adapters/db/repositories/translations.server";
import { listShopLocales } from "~/adapters/shopify/locales";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { isLocaleCode } from "~/adapters/shopify/translations";
import { Dropdown } from "~/web/components/dropdown";
import { TranslationsNav } from "~/web/components/translations-nav";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { TRANSLATION_ROUTES, localeLabel } from "~/web/lib/translations";

/**
 * Glossary (docs/translations.md § Glossary): terms the AI must translate a
 * given way in a given language, and terms it must never translate at all.
 * Sent with every request for the language; a change applies from the next
 * translation, and does not rewrite what is already in Shopify.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const [terms, locales] = await Promise.all([
    listGlossary(principal),
    listShopLocales(admin),
  ]);
  return {
    terms: terms.map((term) => ({
      id: term.id,
      kind: term.kind,
      targetLocale: term.targetLocale,
      sourceTerm: term.sourceTerm,
      targetTerm: term.targetTerm,
      note: term.note,
    })),
    languages:
      locales.kind === "read"
        ? locales.locales
            .filter((l) => !l.primary)
            .map((l) => ({ locale: l.locale, name: l.name }))
        : [],
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "add") {
    const kind = String(formData.get("kind") ?? "");
    const sourceTerm = String(formData.get("sourceTerm") ?? "").trim();
    const targetTerm = String(formData.get("targetTerm") ?? "").trim();
    const targetLocale = String(formData.get("targetLocale") ?? "").trim();
    const note = String(formData.get("note") ?? "").trim();
    if (sourceTerm === "") return { ok: false, message: "Enter the term." };
    if (kind !== "translate" && kind !== "protect")
      return { ok: false, message: "Unknown kind." };
    if (kind === "translate") {
      if (targetTerm === "")
        return { ok: false, message: "Enter what the term should become." };
      if (targetLocale !== "" && !isLocaleCode(targetLocale))
        return { ok: false, message: "Unknown language." };
    }
    await addGlossaryTerm(principal, {
      kind,
      sourceTerm,
      targetTerm: kind === "translate" ? targetTerm : null,
      targetLocale:
        kind === "translate" && targetLocale !== "" ? targetLocale : null,
      note: note === "" ? null : note,
    });
    await appendEvent(principal, {
      entityType: "translation_glossary",
      event: "translation_glossary.added",
      detail: {
        kind,
        sourceTerm,
        targetLocale: targetLocale || null,
        by: actorFromSession(session),
      },
    });
    return {
      ok: true,
      message: "Term added. It applies from the next translation.",
    };
  }

  if (intent === "delete") {
    const id = String(formData.get("id") ?? "");
    const deleted = await deleteGlossaryTerm(principal, id);
    return deleted
      ? { ok: true, message: "Term removed." }
      : { ok: false, message: "That term is already gone." };
  }
  return { ok: false, message: "Unknown action." };
};

export default function Glossary() {
  const { terms, languages } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const [kind, setKind] = useState<"translate" | "protect">("translate");
  const [sourceTerm, setSourceTerm] = useState("");
  const [targetTerm, setTargetTerm] = useState("");
  const [targetLocale, setTargetLocale] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!fetcher.data?.ok) return;
    if (typeof shopify !== "undefined")
      shopify.toast.show(fetcher.data.message);
    setSourceTerm("");
    setTargetTerm("");
    setNote("");
  }, [fetcher.data]);

  const add = () =>
    fetcher.submit(
      { intent: "add", kind, sourceTerm, targetTerm, targetLocale, note },
      { method: "post" },
    );

  const protectTerms = terms.filter((term) => term.kind === "protect");
  const translateTerms = terms.filter((term) => term.kind === "translate");
  const byLocale = new Map<string | null, typeof translateTerms>();
  for (const term of translateTerms)
    byLocale.set(term.targetLocale, [
      ...(byLocale.get(term.targetLocale) ?? []),
      term,
    ]);

  return (
    <s-page heading="Glossary">
      <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
        Translations
      </s-link>

      <s-stack direction="block" gap="large">
        <TranslationsNav current="glossary" />

        {fetcher.data && !fetcher.data.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{fetcher.data.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="Add a term">
          <s-stack direction="block" gap="base">
            <s-choice-list
              label="Kind"
              labelAccessibilityVisibility="exclusive"
              name="kind"
              values={[kind]}
              onChange={(event) => {
                const next = event.currentTarget.values[0];
                if (next === "translate" || next === "protect") setKind(next);
              }}
              {...(busy ? { disabled: true } : {})}
            >
              <s-choice value="translate">
                Translate as
                <s-text slot="details">
                  The source term always becomes the given term in one language,
                  or in every language.
                </s-text>
              </s-choice>
              <s-choice value="protect">
                Never translate
                <s-text slot="details">
                  A brand, a product name, a model number: kept exactly as
                  written in every language.
                </s-text>
              </s-choice>
            </s-choice-list>
            <s-grid
              gridTemplateColumns="@container (inline-size <= 720px) 1fr, 1fr 1fr 1fr"
              gap="base"
              alignItems="end"
            >
              <s-text-field
                label="Term"
                placeholder="Boom"
                value={sourceTerm}
                onInput={(event) => setSourceTerm(event.currentTarget.value)}
                onChange={(event) => setSourceTerm(event.currentTarget.value)}
                {...(busy ? { disabled: true } : {})}
              />
              {kind === "translate" ? (
                <>
                  <s-text-field
                    label="Becomes"
                    placeholder="Gabelbaum"
                    value={targetTerm}
                    onInput={(event) =>
                      setTargetTerm(event.currentTarget.value)
                    }
                    onChange={(event) =>
                      setTargetTerm(event.currentTarget.value)
                    }
                    {...(busy ? { disabled: true } : {})}
                  />
                  <Dropdown
                    name="targetLocale"
                    label="In"
                    value={targetLocale}
                    options={[
                      { value: "", label: "Every language" },
                      ...languages.map((l) => ({
                        value: l.locale,
                        label: localeLabel(l.locale, l.name),
                      })),
                    ]}
                    onChange={setTargetLocale}
                    disabled={busy}
                  />
                </>
              ) : null}
            </s-grid>
            <s-text-field
              label="Note"
              details="For your team. Not sent to the AI."
              value={note}
              onInput={(event) => setNote(event.currentTarget.value)}
              onChange={(event) => setNote(event.currentTarget.value)}
              {...(busy ? { disabled: true } : {})}
            />
            <s-stack direction="inline">
              <s-button
                type="button"
                variant="primary"
                onClick={add}
                {...(busy || sourceTerm.trim() === ""
                  ? { disabled: true }
                  : {})}
              >
                Add term
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>

        <s-section heading="Never translated">
          {protectTerms.length === 0 ? (
            <s-text color="subdued">No protected terms yet.</s-text>
          ) : (
            <TermTable
              terms={protectTerms}
              busy={busy}
              onDelete={(id) =>
                fetcher.submit({ intent: "delete", id }, { method: "post" })
              }
            />
          )}
        </s-section>

        {[...byLocale.entries()]
          .sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))
          .map(([locale, rows]) => (
            <s-section
              key={locale ?? "all"}
              heading={
                locale
                  ? `Translate as · ${localeLabel(locale, languages.find((l) => l.locale === locale)?.name)}`
                  : "Translate as · every language"
              }
            >
              <TermTable
                terms={rows}
                busy={busy}
                onDelete={(id) =>
                  fetcher.submit({ intent: "delete", id }, { method: "post" })
                }
              />
            </s-section>
          ))}
        {translateTerms.length === 0 ? (
          <s-section heading="Translate as">
            <s-text color="subdued">No terms yet. Add one above.</s-text>
          </s-section>
        ) : null}
      </s-stack>
    </s-page>
  );
}

function TermTable({
  terms,
  busy,
  onDelete,
}: {
  terms: Array<{
    id: string;
    sourceTerm: string;
    targetTerm: string | null;
    note: string | null;
  }>;
  busy: boolean;
  onDelete: (id: string) => void;
}) {
  return (
    <s-table variant="auto">
      <s-table-header-row>
        <s-table-header listSlot="primary">Term</s-table-header>
        <s-table-header listSlot="secondary">Becomes</s-table-header>
        <s-table-header>Note</s-table-header>
        <s-table-header listSlot="inline">Actions</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {terms.map((term) => (
          <s-table-row key={term.id}>
            <s-table-cell>
              <s-text type="strong">{term.sourceTerm}</s-text>
            </s-table-cell>
            <s-table-cell>
              <s-text>{term.targetTerm ?? "Kept as written"}</s-text>
            </s-table-cell>
            <s-table-cell>
              <s-text color="subdued">{term.note ?? ""}</s-text>
            </s-table-cell>
            <s-table-cell>
              <s-button
                type="button"
                tone="critical"
                variant="tertiary"
                accessibilityLabel={`Remove ${term.sourceTerm}`}
                onClick={() => onDelete(term.id)}
                {...(busy ? { disabled: true } : {})}
              >
                Remove
              </s-button>
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
