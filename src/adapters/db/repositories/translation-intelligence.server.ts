import { randomUUID } from "node:crypto";

import {
  Prisma,
  type TranslationMemory,
  type TranslationStoreProfile,
  type TranslationTerm,
} from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import type { MemoryEntry, MemoryOrigin } from "~/domain/translations/memory";
import {
  TERM_CLASSIFICATIONS,
  storeProfileSchema,
  type StoreProfile,
  type TermClassification,
} from "~/domain/translations/profile";
import type { StoredTerm, TermCandidate } from "~/domain/translations/terminology";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * What the engine learns about a store (docs/translations.md § Translation
 * intelligence): the store profile, the terms the store's data supports,
 * and the memory of how short strings were translated. Every read and
 * write is scoped to the principal's shop.
 *
 * Terms and memory are written with `INSERT … ON CONFLICT DO UPDATE` in one
 * statement per batch rather than read-modify-write, so two workers
 * translating different pages at the same moment never lose each other's
 * learning and never corrupt a row: the database merges, and the merge rule
 * is written once, here.
 */

async function shopIdFor(principal: Principal): Promise<string> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: { id: true },
  });
  if (!shop) throw new Error(`Unknown shop ${shopDomainOf(principal)}`);
  return shop.id;
}

/* -------------------------------------------------------------------------- */
/* Store profile                                                              */
/* -------------------------------------------------------------------------- */

export interface StoredProfile {
  profile: StoreProfile | null;
  summary: string | null;
  version: number;
  promptVersion: string | null;
  model: string | null;
  vocabulary: string[];
  sampleStats: { products: number; collections: number; menuItems: number } | null;
  useStoreContext: boolean;
  learnTerminology: boolean;
  generatedAt: Date | null;
  checkedAt: Date | null;
  generatingAt: Date | null;
  lastError: string | null;
}

function toStoredProfile(row: TranslationStoreProfile): StoredProfile {
  const parsed = row.profile === null ? null : storeProfileSchema.safeParse(row.profile);
  const stats =
    row.sampleStats && typeof row.sampleStats === "object" && !Array.isArray(row.sampleStats)
      ? row.sampleStats
      : null;
  const int = (value: unknown) => (typeof value === "number" ? Math.round(value) : 0);
  return {
    profile: parsed?.success ? parsed.data : null,
    summary: row.summary,
    version: row.version,
    promptVersion: row.promptVersion,
    model: row.model,
    vocabulary: row.vocabulary,
    sampleStats: stats
      ? { products: int(stats.products), collections: int(stats.collections), menuItems: int(stats.menuItems) }
      : null,
    useStoreContext: row.useStoreContext,
    learnTerminology: row.learnTerminology,
    generatedAt: row.generatedAt,
    checkedAt: row.checkedAt,
    generatingAt: row.generatingAt,
    lastError: row.lastError,
  };
}

export async function getStoreProfile(principal: Principal): Promise<StoredProfile | null> {
  const row = await prisma.translationStoreProfile.findFirst({
    where: { shop: { domain: shopDomainOf(principal) } },
  });
  return row ? toStoredProfile(row) : null;
}

/**
 * Makes sure the shop's row exists. `ON CONFLICT DO NOTHING`, so concurrent
 * workers creating it at the same moment all succeed.
 */
async function createRowIfMissing(shopId: string): Promise<void> {
  await prisma.translationStoreProfile.createMany({ data: [{ shopId }], skipDuplicates: true });
}

/** The settings row, created with the defaults when the shop has none yet. */
export async function ensureProfileRow(principal: Principal): Promise<StoredProfile> {
  const shopId = await shopIdFor(principal);
  await createRowIfMissing(shopId);
  const row = await prisma.translationStoreProfile.findUniqueOrThrow({ where: { shopId } });
  return toStoredProfile(row);
}

/**
 * Takes the build lease: true for the one caller that may build the profile
 * now. A lease older than `leaseMs` belongs to a worker that died and is
 * taken over. One conditional update, so two workers cannot both win.
 */
export async function claimProfileBuild(
  principal: Principal,
  now: Date,
  leaseMs: number,
): Promise<boolean> {
  const shopId = await shopIdFor(principal);
  await createRowIfMissing(shopId);
  const claimed = await prisma.translationStoreProfile.updateMany({
    where: {
      shopId,
      OR: [{ generatingAt: null }, { generatingAt: { lt: new Date(now.getTime() - leaseMs) } }],
    },
    data: { generatingAt: now },
  });
  return claimed.count === 1;
}

export async function saveStoreProfile(
  principal: Principal,
  input: {
    profile: StoreProfile;
    summary: string;
    promptVersion: string;
    model: string;
    vocabulary: string[];
    sampleStats: { products: number; collections: number; menuItems: number };
    now: Date;
  },
): Promise<StoredProfile> {
  const shopId = await shopIdFor(principal);
  const row = await prisma.translationStoreProfile.update({
    where: { shopId },
    data: {
      profile: input.profile satisfies Prisma.InputJsonValue,
      summary: input.summary,
      version: { increment: 1 },
      promptVersion: input.promptVersion,
      model: input.model,
      vocabulary: input.vocabulary,
      sampleStats: input.sampleStats satisfies Prisma.InputJsonObject,
      generatedAt: input.now,
      checkedAt: input.now,
      generatingAt: null,
      lastError: null,
    },
  });
  return toStoredProfile(row);
}

/** Releases the lease after a build that did not produce a profile. */
export async function releaseProfileBuild(
  principal: Principal,
  error: string | null,
  now: Date,
): Promise<void> {
  await prisma.translationStoreProfile.updateMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    data: { generatingAt: null, lastError: error, checkedAt: now },
  });
}

/** Notes that the store was read and the profile found current. */
export async function touchProfileChecked(
  principal: Principal,
  now: Date,
  vocabulary: string[] | null,
): Promise<void> {
  await prisma.translationStoreProfile.updateMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    data: { checkedAt: now, ...(vocabulary ? { vocabulary } : {}) },
  });
}

export async function setProfileSettings(
  principal: Principal,
  settings: { useStoreContext?: boolean; learnTerminology?: boolean },
): Promise<void> {
  const shopId = await shopIdFor(principal);
  await createRowIfMissing(shopId);
  await prisma.translationStoreProfile.update({ where: { shopId }, data: settings });
}

/* -------------------------------------------------------------------------- */
/* Terms                                                                      */
/* -------------------------------------------------------------------------- */

function isClassification(value: string): value is TermClassification {
  return (TERM_CLASSIFICATIONS as readonly string[]).includes(value);
}

function toStoredTerm(row: TranslationTerm): StoredTerm {
  return {
    id: row.id,
    term: row.term,
    normalised: row.normalised,
    classification: isClassification(row.classification) ? row.classification : "generic",
    confidence: row.confidence,
    evidence: readEvidence(row.evidence),
  };
}

function readEvidence(value: Prisma.JsonValue | null): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) if (typeof count === "number") out[key] = count;
  return out;
}

/**
 * Writes what discovery found, merging into what is there: a term already
 * known keeps its id and gains the new evidence and confidence; a merchant's
 * term is never reclassified by discovery. Then forgets the auto-inferred
 * terms discovery no longer found — a vendor whose products are gone.
 */
export async function replaceDiscoveredTerms(
  principal: Principal,
  sourceLocale: string,
  candidates: readonly TermCandidate[],
  now: Date,
): Promise<number> {
  const shopId = await shopIdFor(principal);
  for (let start = 0; start < candidates.length; start += 200) {
    const chunk = candidates.slice(start, start + 200);
    if (chunk.length === 0) continue;
    const rows = chunk.map(
      (candidate) => Prisma.sql`(${randomUUID()}, ${shopId}, ${sourceLocale}, ${candidate.normalised}, ${candidate.term}, ${candidate.classification}, ${candidate.confidence}, 'auto_inferred'::translation_term_origin, ${JSON.stringify(candidate.evidence)}::jsonb, ${candidate.occurrences}, ${now}, ${now})`,
    );
    await prisma.$executeRaw`
      INSERT INTO translation_term (id, shop_id, source_locale, normalised, term, classification, confidence, origin, evidence, occurrences, first_seen_at, last_seen_at)
      VALUES ${Prisma.join(rows)}
      ON CONFLICT (shop_id, source_locale, normalised) DO UPDATE SET
        term = CASE WHEN translation_term.origin = 'merchant' THEN translation_term.term ELSE EXCLUDED.term END,
        classification = CASE WHEN translation_term.origin = 'merchant' THEN translation_term.classification ELSE EXCLUDED.classification END,
        confidence = CASE WHEN translation_term.origin = 'merchant' THEN translation_term.confidence ELSE EXCLUDED.confidence END,
        evidence = EXCLUDED.evidence,
        occurrences = EXCLUDED.occurrences,
        last_seen_at = EXCLUDED.last_seen_at
    `;
  }
  await prisma.translationTerm.deleteMany({
    where: { shopId, sourceLocale, origin: "auto_inferred", lastSeenAt: { lt: now } },
  });
  return prisma.translationTerm.count({ where: { shopId, sourceLocale } });
}

/** Every term of a source locale, most confident first. Bounded by discovery's cap. */
export async function listTerms(
  principal: Principal,
  sourceLocale: string,
  filter: { search?: string; limit?: number; offset?: number } = {},
): Promise<StoredTerm[]> {
  const rows = await prisma.translationTerm.findMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      sourceLocale,
      ...(filter.search
        ? { normalised: { contains: filter.search.toLowerCase().trim() } }
        : {}),
    },
    orderBy: [{ confidence: "desc" }, { occurrences: "desc" }, { normalised: "asc" }],
    take: filter.limit ?? 1000,
    skip: filter.offset ?? 0,
  });
  return rows.map(toStoredTerm);
}

export async function countTerms(principal: Principal, sourceLocale: string, search?: string): Promise<number> {
  return prisma.translationTerm.count({
    where: {
      shop: { domain: shopDomainOf(principal) },
      sourceLocale,
      ...(search ? { normalised: { contains: search.toLowerCase().trim() } } : {}),
    },
  });
}

export async function deleteTerm(principal: Principal, id: string): Promise<boolean> {
  const deleted = await prisma.translationTerm.deleteMany({
    where: { id, shop: { domain: shopDomainOf(principal) } },
  });
  return deleted.count === 1;
}

/* -------------------------------------------------------------------------- */
/* Memory                                                                     */
/* -------------------------------------------------------------------------- */

function toMemoryEntry(row: TranslationMemory): MemoryEntry & { sourceKey: string; targetLocale: string } {
  return {
    id: row.id,
    sourceKey: row.sourceKey,
    sourceText: row.sourceText,
    targetText: row.targetText,
    origin: row.origin,
    usageCount: row.usageCount,
    resourceType: row.resourceType,
    targetLocale: row.targetLocale,
  };
}

export type StoredMemory = ReturnType<typeof toMemoryEntry>;

/**
 * Entries for a language pair whose source key is one of those asked for.
 * The caller passes every key it might match — whole fields and the short
 * phrases inside them — so one query answers both reuse and hints.
 * `targetLocales` lets a regional locale fall back to its language: the
 * caller lists them most specific first and prefers the first hit.
 */
export async function lookupMemory(
  principal: Principal,
  input: { sourceLocale: string; targetLocales: readonly string[]; keys: readonly string[] },
): Promise<StoredMemory[]> {
  if (input.keys.length === 0 || input.targetLocales.length === 0) return [];
  const rows = await prisma.translationMemory.findMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      sourceLocale: input.sourceLocale,
      targetLocale: { in: [...input.targetLocales] },
      sourceKey: { in: [...new Set(input.keys)].slice(0, 500) },
    },
  });
  return rows.map(toMemoryEntry);
}

export interface MemoryWrite {
  sourceLocale: string;
  targetLocale: string;
  sourceKey: string;
  sourceText: string;
  targetText: string;
  resourceType: string | null;
  resourceId: string | null;
}

/**
 * Remembers translations. The merge rule, in one statement so concurrent
 * workers cannot interleave:
 *
 * - a person's translation (`manual`) replaces whatever is there and is
 *   never replaced by the machine's;
 * - the machine's translation of a string already remembered the same way
 *   counts one more use; remembered differently, the earlier answer stands
 *   (consistency is the point) and the disagreement is counted.
 */
export async function rememberTranslations(
  principal: Principal,
  writes: readonly MemoryWrite[],
  origin: MemoryOrigin,
  now: Date,
): Promise<void> {
  if (writes.length === 0) return;
  const shopId = await shopIdFor(principal);
  for (let start = 0; start < writes.length; start += 200) {
    const chunk = writes.slice(start, start + 200);
    const rows = chunk.map(
      (write) => Prisma.sql`(${randomUUID()}, ${shopId}, ${write.sourceLocale}, ${write.targetLocale}, ${write.sourceKey}, ${write.sourceText}, ${write.targetText}, ${origin}::translation_memory_origin, 1, 0, ${write.resourceType}, ${write.resourceId}, ${now}, ${now})`,
    );
    await prisma.$executeRaw`
      INSERT INTO translation_memory (id, shop_id, source_locale, target_locale, source_key, source_text, target_text, origin, usage_count, conflicts, resource_type, last_resource_id, first_seen_at, last_seen_at)
      VALUES ${Prisma.join(rows)}
      ON CONFLICT (shop_id, source_locale, target_locale, source_key) DO UPDATE SET
        target_text = CASE
          WHEN EXCLUDED.origin = 'manual' THEN EXCLUDED.target_text
          ELSE translation_memory.target_text END,
        origin = CASE
          WHEN EXCLUDED.origin = 'manual' THEN EXCLUDED.origin
          ELSE translation_memory.origin END,
        usage_count = CASE
          WHEN EXCLUDED.origin = 'manual' OR lower(translation_memory.target_text) = lower(EXCLUDED.target_text)
            THEN translation_memory.usage_count + 1
          ELSE translation_memory.usage_count END,
        conflicts = CASE
          WHEN EXCLUDED.origin = 'ai' AND lower(translation_memory.target_text) <> lower(EXCLUDED.target_text)
            THEN translation_memory.conflicts + 1
          ELSE translation_memory.conflicts END,
        source_text = EXCLUDED.source_text,
        resource_type = EXCLUDED.resource_type,
        last_resource_id = EXCLUDED.last_resource_id,
        last_seen_at = EXCLUDED.last_seen_at
    `;
  }
}

/** A translation removed in the editor is forgotten by memory too. */
export async function forgetMemory(
  principal: Principal,
  input: { sourceLocale: string; targetLocale: string; sourceKeys: readonly string[] },
): Promise<void> {
  if (input.sourceKeys.length === 0) return;
  await prisma.translationMemory.deleteMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      sourceLocale: input.sourceLocale,
      targetLocale: input.targetLocale,
      sourceKey: { in: [...input.sourceKeys] },
    },
  });
}

export async function listMemory(
  principal: Principal,
  filter: { targetLocale?: string | null; search?: string; limit?: number; offset?: number } = {},
): Promise<StoredMemory[]> {
  const rows = await prisma.translationMemory.findMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      ...(filter.targetLocale ? { targetLocale: filter.targetLocale } : {}),
      ...(filter.search ? { sourceKey: { contains: filter.search.toLowerCase().trim() } } : {}),
    },
    orderBy: [{ usageCount: "desc" }, { lastSeenAt: "desc" }],
    take: filter.limit ?? 100,
    skip: filter.offset ?? 0,
  });
  return rows.map(toMemoryEntry);
}

export async function countMemory(
  principal: Principal,
  filter: { targetLocale?: string | null; search?: string } = {},
): Promise<number> {
  return prisma.translationMemory.count({
    where: {
      shop: { domain: shopDomainOf(principal) },
      ...(filter.targetLocale ? { targetLocale: filter.targetLocale } : {}),
      ...(filter.search ? { sourceKey: { contains: filter.search.toLowerCase().trim() } } : {}),
    },
  });
}

export async function deleteMemoryEntry(principal: Principal, id: string): Promise<boolean> {
  const deleted = await prisma.translationMemory.deleteMany({
    where: { id, shop: { domain: shopDomainOf(principal) } },
  });
  return deleted.count === 1;
}

/** Memory entries per target locale, for the status line. */
export async function memoryCountsByLocale(principal: Principal): Promise<Map<string, number>> {
  const shopId = await shopIdFor(principal);
  const groups = await prisma.translationMemory.groupBy({
    by: ["targetLocale"],
    where: { shopId },
    _count: { _all: true },
  });
  return new Map(groups.map((group) => [group.targetLocale, group._count._all]));
}
