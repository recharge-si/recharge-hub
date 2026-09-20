import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { isConfigured, translationModel } from "~/adapters/ai/openai.server";
import {
  countTerms,
  getStoreProfile,
} from "~/adapters/db/repositories/translation-intelligence.server";
import {
  getCoverage,
  listActiveSyncs,
  listLanguageSettings,
  type StoredLanguage,
} from "~/adapters/db/repositories/translations.server";
import { listShopLocales } from "~/adapters/shopify/locales";
import { totalsFor } from "~/domain/translations/coverage";
import {
  coveragePercent,
  type CoverageRow,
} from "~/domain/translations/estimate";
import type { ShopLocale } from "~/domain/translations/types";
import type { Principal } from "~/domain/types";

/**
 * What the Translations pages read (docs/translations.md § Screens), put
 * together in one place so every page describes a language the same way.
 *
 * Shopify's part — the locales — is read live on each request; the cost is
 * one query. This app's part — settings, coverage, running syncs — comes
 * from its own tables. Nothing here waits on OpenAI.
 */

export interface LanguageRow {
  locale: string;
  name: string;
  primary: boolean;
  published: boolean;
  /** Market names the locale is served in, from its web presences. */
  markets: string[];
  settings: StoredLanguage | null;
  coverage: number | null;
  missing: number;
  outdated: number;
  fields: number;
  lastSuccessfulSyncAt: string | null;
  syncing: boolean;
}

export interface LanguagesOverview {
  kind: "read";
  locales: ShopLocale[];
  primary: ShopLocale | null;
  rows: LanguageRow[];
  coverageAt: string | null;
  coverageRows: CoverageRow[];
  ai: { configured: boolean; model: string };
  activeSyncs: number;
  /** What the AI knows about the store, in a line (docs/translations.md § Store profile). */
  intelligence: { summary: string | null; terms: number; building: boolean };
}

export type LanguagesOverviewResult =
  | LanguagesOverview
  | {
      kind: "unavailable";
      reason: string;
      ai: { configured: boolean; model: string };
    };

export async function loadLanguagesOverview(
  principal: Principal,
  admin: AdminApiContext,
): Promise<LanguagesOverviewResult> {
  const ai = { configured: isConfigured(), model: translationModel() };
  const [locales, settings, coverage, active, profile] = await Promise.all([
    listShopLocales(admin),
    listLanguageSettings(principal),
    getCoverage(principal),
    listActiveSyncs(principal),
    getStoreProfile(principal),
  ]);
  if (locales.kind === "unavailable")
    return { kind: "unavailable", reason: locales.reason, ai };
  const primaryLocale = locales.locales.find((locale) => locale.primary)?.locale;
  const terms = primaryLocale ? await countTerms(principal, primaryLocale) : 0;

  const byLocale = new Map(settings.map((row) => [row.locale, row]));
  const syncingLocales = new Set(active.flatMap((sync) => sync.targetLocales));

  const rows = locales.locales.map((locale): LanguageRow => {
    const totals = totalsFor(coverage.rows, locale.locale);
    const stored = byLocale.get(locale.locale) ?? null;
    return {
      locale: locale.locale,
      name: locale.name,
      primary: locale.primary,
      published: locale.published,
      markets: [
        ...new Set(
          locale.webPresences.flatMap((presence) =>
            presence.markets.map((market) => market.name),
          ),
        ),
      ],
      settings: stored,
      coverage: locale.primary
        ? 100
        : coveragePercent(
            coverage.rows.filter((row) => row.locale === locale.locale),
          ),
      missing: totals.missing,
      outdated: totals.outdated,
      fields: totals.fields,
      lastSuccessfulSyncAt: stored?.lastSuccessfulSyncAt?.toISOString() ?? null,
      syncing: syncingLocales.has(locale.locale),
    };
  });

  return {
    kind: "read",
    locales: locales.locales,
    primary: locales.locales.find((locale) => locale.primary) ?? null,
    rows,
    coverageAt: coverage.readAt?.toISOString() ?? null,
    coverageRows: coverage.rows,
    ai,
    activeSyncs: active.length,
    intelligence: {
      summary: profile?.profile ? profile.summary : null,
      terms,
      building: profile?.generatingAt !== null && profile?.generatingAt !== undefined,
    },
  };
}
