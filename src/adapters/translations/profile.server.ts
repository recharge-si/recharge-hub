import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { generateStoreProfile, isConfigured } from "~/adapters/ai/openai.server";
import {
  claimProfileBuild,
  ensureProfileRow,
  getStoreProfile,
  releaseProfileBuild,
  replaceDiscoveredTerms,
  saveStoreProfile,
  touchProfileChecked,
  type StoredProfile,
} from "~/adapters/db/repositories/translation-intelligence.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { readStoreSnapshot } from "~/adapters/shopify/store-context";
import {
  PROFILE_PROMPT_VERSION,
  profileSummary,
} from "~/domain/translations/profile";
import {
  buildStoreSample,
  sampleVocabulary,
  vocabularyOverlap,
} from "~/domain/translations/snapshot";
import { discoverTerminology } from "~/domain/translations/terminology";
import type { Principal } from "~/domain/types";

/**
 * Keeping the store profile and the automatic terminology current
 * (docs/translations.md § Store profile).
 *
 * `ensureStoreProfile` is what every translation pass calls first. Most of
 * the time it returns the stored profile at once: the store was checked
 * within the day. Otherwise it reads the store's snapshot — Shopify only,
 * no model — and decides whether the profile is stale: none yet, an older
 * prompt, a vocabulary that has drifted, or simply old. Only a stale
 * profile costs a model request. Terminology discovery is deterministic
 * and runs on every check, so the vocabulary follows the store for free.
 *
 * Two workers may reach here together; a lease on the profile row lets one
 * build and the other proceed with what is stored.
 */

/** A check within this window is trusted without reading the store again. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * With no profile yet — no key, or a build that failed — the store is still
 * not re-read on every page: it is tried again after this long.
 */
const RETRY_INTERVAL_MS = 60 * 60 * 1000;
/** A profile older than this is rebuilt even when the vocabulary looks the same. */
const MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;
/** Below this share of shared vocabulary the store has changed enough to re-read. */
const MIN_OVERLAP = 0.8;
/** A build that has not finished in this long is presumed dead and taken over. */
const LEASE_MS = 10 * 60 * 1000;

export interface EnsureOptions {
  primaryLocale: string;
  /** Rebuild whatever the checks say — the merchant pressed Regenerate. */
  force?: boolean;
  now?: Date;
}

export type EnsureOutcome =
  | { kind: "current"; profile: StoredProfile }
  | { kind: "rebuilt"; profile: StoredProfile; terms: number }
  | { kind: "checked"; profile: StoredProfile; terms: number }
  | { kind: "busy"; profile: StoredProfile }
  | { kind: "failed"; profile: StoredProfile; reason: string };

export async function ensureStoreProfile(
  principal: Principal,
  admin: AdminApiContext,
  options: EnsureOptions,
): Promise<EnsureOutcome> {
  const now = options.now ?? new Date();
  const stored = (await getStoreProfile(principal)) ?? (await ensureProfileRow(principal));
  const interval = stored.profile ? CHECK_INTERVAL_MS : RETRY_INTERVAL_MS;
  const checkedRecently =
    stored.checkedAt !== null && now.getTime() - stored.checkedAt.getTime() < interval;
  if (!options.force && checkedRecently) return { kind: "current", profile: stored };

  const claimed = await claimProfileBuild(principal, now, LEASE_MS);
  if (!claimed) return { kind: "busy", profile: stored };

  const log = getLogger();
  try {
    const snapshot = await readStoreSnapshot(admin, options.primaryLocale);
    const sample = buildStoreSample(snapshot);
    const vocabulary = sampleVocabulary(sample);
    const stale = options.force || isStale(stored, vocabulary, sample.totals.products, now);

    let profile = stored.profile;
    let rebuilt = false;
    if (stale && isConfigured()) {
      const outcome = await generateStoreProfile(principal, sample);
      if (outcome.kind === "failed") {
        await releaseProfileBuild(principal, outcome.message, now);
        log.warn({ shop: principal.shopDomain, reason: outcome.message }, "Store profile not built");
        // The old profile, if any, still serves; terminology still learns.
        const terms = await learnTerms(principal, options.primaryLocale, snapshot, profile, stored.learnTerminology, now);
        const after = (await getStoreProfile(principal)) ?? stored;
        return profile ? { kind: "checked", profile: after, terms } : { kind: "failed", profile: after, reason: outcome.message };
      }
      profile = outcome.profile;
      rebuilt = true;
      await saveStoreProfile(principal, {
        profile: outcome.profile,
        summary: profileSummary(outcome.profile),
        promptVersion: PROFILE_PROMPT_VERSION,
        model: outcome.model,
        vocabulary,
        sampleStats: sample.totals,
        now,
      });
      await appendEvent(principal, {
        entityType: "translation_profile",
        event: "translation_profile.built",
        detail: {
          industries: outcome.profile.industries,
          products: sample.totals.products,
          collections: sample.totals.collections,
          menuItems: sample.totals.menuItems,
        },
      });
    } else {
      await touchProfileChecked(principal, now, vocabulary);
      await releaseProfileBuild(principal, null, now);
    }

    const terms = await learnTerms(principal, options.primaryLocale, snapshot, profile, stored.learnTerminology, now);
    const after = (await getStoreProfile(principal)) ?? stored;
    log.info(
      { shop: principal.shopDomain, rebuilt, terms, products: sample.totals.products },
      "Store profile checked",
    );
    return rebuilt ? { kind: "rebuilt", profile: after, terms } : { kind: "checked", profile: after, terms };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await releaseProfileBuild(principal, reason, now);
    log.warn({ shop: principal.shopDomain, reason }, "Store profile check failed");
    return { kind: "failed", profile: stored, reason };
  }
}

function isStale(
  stored: StoredProfile,
  vocabulary: readonly string[],
  products: number,
  now: Date,
): boolean {
  if (!stored.profile || !stored.generatedAt) return true;
  if (stored.promptVersion !== PROFILE_PROMPT_VERSION) return true;
  if (now.getTime() - stored.generatedAt.getTime() > MAX_AGE_MS) return true;
  if (vocabularyOverlap(stored.vocabulary, vocabulary) < MIN_OVERLAP) return true;
  const before = stored.sampleStats?.products ?? 0;
  if (before > 0 && Math.abs(products - before) / before > 0.25) return true;
  return false;
}

async function learnTerms(
  principal: Principal,
  sourceLocale: string,
  snapshot: Awaited<ReturnType<typeof readStoreSnapshot>>,
  profile: StoredProfile["profile"],
  enabled: boolean,
  now: Date,
): Promise<number> {
  if (!enabled) return 0;
  const candidates = discoverTerminology(snapshot, profile);
  return replaceDiscoveredTerms(principal, sourceLocale, candidates, now);
}
