import { languageName } from "~/domain/translations/prompt";
import type { LanguageSettings, ShopLocale } from "~/domain/translations/types";

/**
 * Words and addresses for the Translations pages (docs/translations.md
 * § Screens). Client-safe: labels and formatting only.
 *
 * Two vocabularies are kept apart on every screen. **Shopify** says whether
 * a language is the default, published or unpublished. **AI translation**
 * says whether this app works on it and how. A language is never shown as
 * published because AI is on, and never as "on" because it is published.
 */

export const TRANSLATION_ROUTES = {
  languages: "/app/translations",
  add: "/app/translations/add",
  language: (locale: string) =>
    `/app/translations/languages/${encodeURIComponent(locale)}`,
  editor: "/app/translations/editor",
  translate: "/app/translations/translate",
  syncs: "/app/translations/syncs",
  sync: (id: string) => `/app/translations/syncs/${id}`,
  glossary: "/app/translations/glossary",
  context: "/app/translations/context",
  usage: "/app/translations/usage",
} as const;

export type TranslationsSection =
  | "languages"
  | "editor"
  | "syncs"
  | "context"
  | "glossary"
  | "usage";

export const TRANSLATIONS_SECTIONS: ReadonlyArray<{
  key: TranslationsSection;
  label: string;
  href: string;
}> = [
  { key: "languages", label: "Languages", href: TRANSLATION_ROUTES.languages },
  { key: "editor", label: "Editor", href: TRANSLATION_ROUTES.editor },
  { key: "syncs", label: "Syncs", href: TRANSLATION_ROUTES.syncs },
  { key: "context", label: "Store context", href: TRANSLATION_ROUTES.context },
  { key: "glossary", label: "Overrides", href: TRANSLATION_ROUTES.glossary },
  { key: "usage", label: "AI usage", href: TRANSLATION_ROUTES.usage },
];

/** What Shopify says about the locale, in one word. */
export function shopifyStateLabel(
  locale: Pick<ShopLocale, "primary" | "published">,
): "Default" | "Published" | "Unpublished" {
  if (locale.primary) return "Default";
  return locale.published ? "Published" : "Unpublished";
}

/** What the engine does for the language, in a few words. */
export function aiStateLabel(
  locale: Pick<ShopLocale, "primary">,
  settings: Pick<
    LanguageSettings,
    "aiEnabled" | "autoTranslateNew" | "autoUpdateOutdated"
  > | null,
): string {
  if (locale.primary) return "Source";
  if (!settings || !settings.aiEnabled) return "Off";
  if (settings.autoTranslateNew && settings.autoUpdateOutdated)
    return "Automatic";
  if (settings.autoTranslateNew) return "Automatic for new content";
  if (settings.autoUpdateOutdated) return "Automatic for outdated";
  return "On, when asked";
}

/** "German (de)". Shopify's own name where it gave one. */
export function localeLabel(locale: string, name?: string | null): string {
  return `${name ?? languageName(locale)} (${locale})`;
}

export const SYNC_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const SYNC_KIND_LABEL: Record<string, string> = {
  translate_store: "Translate store",
  language: "Language",
  automatic: "Automatic",
  resource: "One resource",
};

export const ITEM_STATUS_LABEL: Record<string, string> = {
  translated: "Translated",
  copied: "Copied from source",
  skipped: "Nothing to do",
  failed: "Failed",
};

export function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

/** The bit of a GID a person can read: "Product 123". */
export function describeResourceId(resourceId: string): string {
  const match = /^gid:\/\/shopify\/([A-Za-z]+)\/(\d+)/.exec(resourceId);
  return match ? `${match[1]} ${match[2]}` : resourceId;
}

/** What a link into the overrides page may ask the dialog to start with. */
export interface GlossaryPrefill {
  sourceTerm: string;
  targetTerm: string;
  targetLocale: string;
}

/**
 * The overrides page opened from a learnt term or an established
 * translation: `?term=Foil&translation=Hidrokrilo&locale=sl` opens the
 * dialog with those values so the merchant only confirms. Values are
 * clipped; a locale that is not a locale code is dropped.
 */
export function glossaryPrefill(search: URLSearchParams): GlossaryPrefill | null {
  const sourceTerm = (search.get("term") ?? "").trim().slice(0, 200);
  if (sourceTerm === "") return null;
  const locale = (search.get("locale") ?? "").trim();
  return {
    sourceTerm,
    targetTerm: (search.get("translation") ?? "").trim().slice(0, 200),
    targetLocale: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale) ? locale : "",
  };
}

/** The address that opens the overrides dialog prefilled. */
export function glossaryUrl(prefill: Partial<GlossaryPrefill> & { sourceTerm: string }): string {
  const search = new URLSearchParams();
  search.set("term", prefill.sourceTerm);
  if (prefill.targetTerm) search.set("translation", prefill.targetTerm);
  if (prefill.targetLocale) search.set("locale", prefill.targetLocale);
  return `${TRANSLATION_ROUTES.glossary}?${search.toString()}`;
}
