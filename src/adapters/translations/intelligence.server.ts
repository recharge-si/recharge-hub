import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  listTerms,
  lookupMemory,
  rememberTranslations,
  type StoredMemory,
} from "~/adapters/db/repositories/translation-intelligence.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { ContextSource, type ResourceContexts } from "~/adapters/translations/context.server";
import { ensureStoreProfile } from "~/adapters/translations/profile.server";
import { localeChain } from "~/domain/translations/locale";
import { memoryKey, type MemoryOrigin } from "~/domain/translations/memory";
import { renderStoreContext } from "~/domain/translations/profile";
import type { StoredTerm } from "~/domain/translations/terminology";
import { normaliseTerm, stripHtml, wordsOf } from "~/domain/translations/text";
import type { SourceField } from "~/domain/translations/types";
import type { Principal } from "~/domain/types";

/**
 * Everything the engine knows beyond the fields themselves
 * (docs/translations.md § Translation intelligence), loaded once per pass:
 * the store context the prompt carries, the store's terms per source
 * locale, translation memory per language pair, and where each resource
 * sits. One object, handed to the engine, so a sync pass and the editor's
 * "translate now" are informed the same way.
 */

/** Phrases up to this many words are looked up in memory as hints. */
const MAX_HINT_WORDS = 4;
/** Lookup keys per request; a long description would otherwise ask for thousands. */
const MAX_LOOKUP_KEYS = 400;

export interface Intelligence {
  /** The store profile rendered for the prompt, or null when there is none or it is switched off. */
  storeContext: string | null;
  profileVersion: number | null;
  /** Whether translations written should teach terminology and memory. */
  learn: boolean;
  contexts: ResourceContexts;
  termsFor(sourceLocale: string): Promise<StoredTerm[]>;
  /**
   * Memory entries that could answer or inform these fields, for a language
   * pair. The target locale's chain is consulted (`de-AT`, then `de`) and
   * an entry for the exact locale shadows the language's.
   */
  memoryFor(sourceLocale: string, targetLocale: string, fields: readonly SourceField[]): Promise<StoredMemory[]>;
  remember(
    input: {
      sourceLocale: string;
      targetLocale: string;
      resourceType: string;
      resourceId: string;
      pairs: ReadonlyArray<{ sourceText: string; targetText: string }>;
    },
    origin: MemoryOrigin,
  ): Promise<void>;
}

/**
 * The keys memory is asked for: each field as a whole, and every short
 * phrase inside it. Normalised the way memory keys are, so "Wing Foil" in a
 * title finds the entry for "wing foil".
 */
export function lookupKeys(fields: readonly SourceField[]): string[] {
  const keys = new Set<string>();
  for (const field of fields) {
    const text = stripHtml(field.value);
    const whole = normaliseTerm(text);
    if (whole !== "") keys.add(whole);
    const words = wordsOf(text);
    for (let i = 0; i < words.length && keys.size < MAX_LOOKUP_KEYS; i += 1) {
      for (let n = 1; n <= MAX_HINT_WORDS && i + n <= words.length; n += 1) {
        const key = normaliseTerm(words.slice(i, i + n).join(" "));
        if (key.length >= 2 && /\p{L}/u.test(key)) keys.add(key);
      }
    }
    if (keys.size >= MAX_LOOKUP_KEYS) break;
  }
  return [...keys].slice(0, MAX_LOOKUP_KEYS);
}

export async function loadIntelligence(
  principal: Principal,
  admin: AdminApiContext,
  input: { primaryLocale: string; storeName: string | null },
): Promise<Intelligence> {
  const ensured = await ensureStoreProfile(principal, admin, { primaryLocale: input.primaryLocale });
  const stored = ensured.profile;
  if (ensured.kind === "failed")
    getLogger().warn({ shop: principal.shopDomain, reason: ensured.reason }, "Translating without a store profile");

  const storeContext =
    stored.useStoreContext && stored.profile ? renderStoreContext(stored.profile, input.storeName) : null;
  const termCache = new Map<string, Promise<StoredTerm[]>>();

  return {
    storeContext,
    profileVersion: stored.profile ? stored.version : null,
    learn: stored.learnTerminology,
    contexts: new ContextSource(admin),
    termsFor(sourceLocale) {
      if (!stored.useStoreContext) return Promise.resolve([]);
      let cached = termCache.get(sourceLocale);
      if (!cached) {
        cached = listTerms(principal, sourceLocale);
        termCache.set(sourceLocale, cached);
      }
      return cached;
    },
    async memoryFor(sourceLocale, targetLocale, fields) {
      const keys = lookupKeys(fields);
      if (keys.length === 0) return [];
      const chain = localeChain(targetLocale);
      const rows = await lookupMemory(principal, { sourceLocale, targetLocales: chain, keys });
      // The most specific locale wins per source key.
      const best = new Map<string, StoredMemory>();
      for (const row of rows) {
        const current = best.get(row.sourceKey);
        if (!current || chain.indexOf(row.targetLocale) < chain.indexOf(current.targetLocale)) best.set(row.sourceKey, row);
      }
      return [...best.values()];
    },
    async remember(input, origin) {
      if (!stored.learnTerminology && origin === "ai") return;
      await rememberTranslations(
        principal,
        input.pairs.map((pair) => ({
          sourceLocale: input.sourceLocale,
          targetLocale: input.targetLocale,
          sourceKey: memoryKey(pair.sourceText),
          sourceText: pair.sourceText,
          targetText: pair.targetText,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
        })),
        origin,
        new Date(),
      );
    },
  };
}
