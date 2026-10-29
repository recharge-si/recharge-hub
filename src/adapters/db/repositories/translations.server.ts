import {
  Prisma,
  type AiUsageResult,
  type TranslationGlossaryTerm,
  type TranslationItemStatus,
  type TranslationLanguage,
  type TranslationSourceOverride,
  type TranslationSync,
  type TranslationSyncItem,
  type TranslationSyncKind,
  type TranslationSyncMode,
  type TranslationSyncStatus,
} from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import type { CoverageRow } from "~/domain/translations/estimate";
import {
  defaultLanguageSettings,
  isContentGroup,
  isKeepOriginal,
  type GlossaryTerm,
  type LanguageSettings,
  type OwnershipRecord,
  type TranslationTrace,
} from "~/domain/translations/types";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * What this app keeps about translations (docs/translations.md § Data
 * model): the engine's settings per language, the glossary, source-language
 * overrides, what it wrote, the syncs it ran, and what they cost. Never the
 * locales' own state and never a translated string — those are read from
 * Shopify each time.
 *
 * Every read and write is scoped to the principal's shop.
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
/* Language settings                                                          */
/* -------------------------------------------------------------------------- */

function toSettings(row: TranslationLanguage): LanguageSettings {
  return {
    locale: row.locale,
    aiEnabled: row.aiEnabled,
    autoTranslateNew: row.autoTranslateNew,
    autoUpdateOutdated: row.autoUpdateOutdated,
    contentScope: row.contentScope.filter(isContentGroup),
    overwritePolicy: row.overwritePolicy,
    keepOriginal: row.keepOriginal.filter(isKeepOriginal),
  };
}

export interface StoredLanguage extends LanguageSettings {
  lastSyncAt: Date | null;
  lastSuccessfulSyncAt: Date | null;
}

export async function listLanguageSettings(
  principal: Principal,
): Promise<StoredLanguage[]> {
  const rows = await prisma.translationLanguage.findMany({
    where: { shop: { domain: shopDomainOf(principal) } },
  });
  return rows.map((row) => ({
    ...toSettings(row),
    lastSyncAt: row.lastSyncAt,
    lastSuccessfulSyncAt: row.lastSuccessfulSyncAt,
  }));
}

/** The settings for a locale, defaults when the merchant has not touched it. */
export async function getLanguageSettings(
  principal: Principal,
  locale: string,
): Promise<StoredLanguage> {
  const row = await prisma.translationLanguage.findFirst({
    where: { shop: { domain: shopDomainOf(principal) }, locale },
  });
  if (!row)
    return {
      ...defaultLanguageSettings(locale),
      lastSyncAt: null,
      lastSuccessfulSyncAt: null,
    };
  return {
    ...toSettings(row),
    lastSyncAt: row.lastSyncAt,
    lastSuccessfulSyncAt: row.lastSuccessfulSyncAt,
  };
}

export async function saveLanguageSettings(
  principal: Principal,
  settings: LanguageSettings,
): Promise<void> {
  const shopId = await shopIdFor(principal);
  const data = {
    aiEnabled: settings.aiEnabled,
    autoTranslateNew: settings.autoTranslateNew,
    autoUpdateOutdated: settings.autoUpdateOutdated,
    contentScope: [...settings.contentScope],
    overwritePolicy: settings.overwritePolicy,
    keepOriginal: [...settings.keepOriginal],
  };
  await prisma.translationLanguage.upsert({
    where: { shopId_locale: { shopId, locale: settings.locale } },
    create: { shopId, locale: settings.locale, ...data },
    update: data,
  });
}

/** Languages, across every shop, with automatic translation on. For the nightly tick. */
export async function listAutomaticLanguages(): Promise<
  Array<{ shopDomain: string; settings: LanguageSettings }>
> {
  const rows = await prisma.translationLanguage.findMany({
    where: {
      aiEnabled: true,
      OR: [{ autoTranslateNew: true }, { autoUpdateOutdated: true }],
      shop: { installState: "installed", setupCompletedAt: { not: null } },
    },
    include: { shop: { select: { domain: true } } },
  });
  return rows.map((row) => ({
    shopDomain: row.shop.domain,
    settings: toSettings(row),
  }));
}

export async function recordLanguageSync(
  principal: Principal,
  locales: readonly string[],
  outcome: "started" | "succeeded",
  now: Date,
): Promise<void> {
  const shopId = await shopIdFor(principal);
  for (const locale of locales) {
    const data =
      outcome === "started"
        ? { lastSyncAt: now }
        : { lastSyncAt: now, lastSuccessfulSyncAt: now };
    await prisma.translationLanguage.upsert({
      where: { shopId_locale: { shopId, locale } },
      create: {
        shopId,
        locale,
        contentScope: [...defaultLanguageSettings(locale).contentScope],
        ...data,
      },
      update: data,
    });
  }
}

/**
 * When a locale is removed in Shopify the engine's settings for it go too —
 * they described a language the store no longer has. Ownership rows, syncs,
 * items and usage stay: they are history, and history is not undone by a
 * configuration change.
 */
export async function forgetLanguageSettings(
  principal: Principal,
  locale: string,
): Promise<void> {
  await prisma.translationLanguage.deleteMany({
    where: { shop: { domain: shopDomainOf(principal) }, locale },
  });
  await prisma.translationCoverage.deleteMany({
    where: { shop: { domain: shopDomainOf(principal) }, locale },
  });
}

/* -------------------------------------------------------------------------- */
/* Coverage cache                                                             */
/* -------------------------------------------------------------------------- */

export interface CoverageState {
  rows: CoverageRow[];
  readAt: Date | null;
}

export async function getCoverage(principal: Principal): Promise<CoverageState> {
  const rows = await prisma.translationCoverage.findMany({
    where: { shop: { domain: shopDomainOf(principal) } },
  });
  let readAt: Date | null = null;
  for (const row of rows)
    if (!readAt || row.readAt > readAt) readAt = row.readAt;
  return {
    rows: rows.map((row) => ({
      locale: row.locale,
      resourceType: row.resourceType,
      resources: row.resources,
      fields: row.fields,
      translated: row.translated,
      outdated: row.outdated,
      missing: row.missing,
      missingChars: row.missingChars,
      outdatedChars: row.outdatedChars,
    })),
    readAt,
  };
}

/** Replaces the whole cache in one transaction, so a reader never sees half a read. */
export async function replaceCoverage(
  principal: Principal,
  rows: readonly CoverageRow[],
  readAt: Date,
): Promise<void> {
  const shopId = await shopIdFor(principal);
  await prisma.$transaction([
    prisma.translationCoverage.deleteMany({ where: { shopId } }),
    prisma.translationCoverage.createMany({
      data: rows.map((row) => ({ shopId, readAt, ...row })),
    }),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Glossary                                                                   */
/* -------------------------------------------------------------------------- */

export type GlossaryRow = TranslationGlossaryTerm;

export async function listGlossary(principal: Principal): Promise<GlossaryRow[]> {
  return prisma.translationGlossaryTerm.findMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    orderBy: [{ kind: "asc" }, { targetLocale: "asc" }, { sourceTerm: "asc" }],
  });
}

/** The terms that apply to one target language, as the prompt wants them. */
export async function glossaryFor(
  principal: Principal,
  targetLocale: string,
): Promise<GlossaryTerm[]> {
  const rows = await prisma.translationGlossaryTerm.findMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      OR: [{ kind: "protect" }, { targetLocale }, { targetLocale: null }],
    },
  });
  return rows.map((row) => ({
    kind: row.kind,
    targetLocale: row.targetLocale,
    sourceTerm: row.sourceTerm,
    targetTerm: row.targetTerm,
  }));
}

export async function addGlossaryTerm(
  principal: Principal,
  term: GlossaryTerm & { note?: string | null },
): Promise<GlossaryRow> {
  const shopId = await shopIdFor(principal);
  return prisma.translationGlossaryTerm.create({
    data: {
      shopId,
      kind: term.kind,
      targetLocale: term.kind === "protect" ? null : term.targetLocale,
      sourceTerm: term.sourceTerm,
      targetTerm: term.kind === "protect" ? null : term.targetTerm,
      note: term.note ?? null,
    },
  });
}

/**
 * Rewrites one term in place. The row keeps its id, so a rule a merchant
 * corrects stays the rule they saw; `false` when the term is gone already.
 */
export async function updateGlossaryTerm(
  principal: Principal,
  id: string,
  term: GlossaryTerm & { note?: string | null },
): Promise<boolean> {
  const updated = await prisma.translationGlossaryTerm.updateMany({
    where: { id, shop: { domain: shopDomainOf(principal) } },
    data: {
      kind: term.kind,
      targetLocale: term.kind === "protect" ? null : term.targetLocale,
      sourceTerm: term.sourceTerm,
      targetTerm: term.kind === "protect" ? null : term.targetTerm,
      note: term.note ?? null,
    },
  });
  return updated.count === 1;
}

export async function deleteGlossaryTerm(
  principal: Principal,
  id: string,
): Promise<boolean> {
  const deleted = await prisma.translationGlossaryTerm.deleteMany({
    where: { id, shop: { domain: shopDomainOf(principal) } },
  });
  return deleted.count === 1;
}

/* -------------------------------------------------------------------------- */
/* Source-language overrides                                                  */
/* -------------------------------------------------------------------------- */

export type SourceOverride = TranslationSourceOverride;

export async function getSourceOverride(
  principal: Principal,
  resourceId: string,
): Promise<SourceOverride | null> {
  return prisma.translationSourceOverride.findFirst({
    where: { shop: { domain: shopDomainOf(principal) }, resourceId },
  });
}

export async function listSourceOverrides(
  principal: Principal,
  resourceIds: readonly string[],
): Promise<Map<string, SourceOverride>> {
  if (resourceIds.length === 0) return new Map();
  const rows = await prisma.translationSourceOverride.findMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      resourceId: { in: [...resourceIds] },
    },
  });
  return new Map(rows.map((row) => [row.resourceId, row]));
}

export async function listAllSourceOverrides(
  principal: Principal,
): Promise<SourceOverride[]> {
  return prisma.translationSourceOverride.findMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    orderBy: { updatedAt: "desc" },
  });
}

/** Sets or clears the language a resource is written in. Null clears it. */
export async function setSourceOverride(
  principal: Principal,
  input: {
    resourceId: string;
    resourceType: string;
    sourceLocale: string | null;
    setBy: string | null;
  },
): Promise<void> {
  const shopId = await shopIdFor(principal);
  if (input.sourceLocale === null) {
    await prisma.translationSourceOverride.deleteMany({
      where: { shopId, resourceId: input.resourceId },
    });
    return;
  }
  await prisma.translationSourceOverride.upsert({
    where: { shopId_resourceId: { shopId, resourceId: input.resourceId } },
    create: {
      shopId,
      resourceId: input.resourceId,
      resourceType: input.resourceType,
      sourceLocale: input.sourceLocale,
      setBy: input.setBy,
    },
    update: { sourceLocale: input.sourceLocale, setBy: input.setBy },
  });
}

/** Records what detection suggested without changing what is decided. */
export async function recordDetectedSource(
  principal: Principal,
  input: {
    resourceId: string;
    resourceType: string;
    detectedLocale: string;
    detectedConfidence: number | null;
    primaryLocale: string;
  },
): Promise<void> {
  const shopId = await shopIdFor(principal);
  const existing = await prisma.translationSourceOverride.findUnique({
    where: { shopId_resourceId: { shopId, resourceId: input.resourceId } },
  });
  if (existing) {
    await prisma.translationSourceOverride.update({
      where: { id: existing.id },
      data: {
        detectedLocale: input.detectedLocale,
        detectedConfidence: input.detectedConfidence,
      },
    });
    return;
  }
  // No decision yet: the row carries the suggestion, and the source stays the
  // store default until a person says otherwise.
  await prisma.translationSourceOverride.create({
    data: {
      shopId,
      resourceId: input.resourceId,
      resourceType: input.resourceType,
      sourceLocale: input.primaryLocale,
      detectedLocale: input.detectedLocale,
      detectedConfidence: input.detectedConfidence,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Ownership                                                                  */
/* -------------------------------------------------------------------------- */

export async function listOwnership(
  principal: Principal,
  resourceIds: readonly string[],
): Promise<Map<string, OwnershipRecord[]>> {
  if (resourceIds.length === 0) return new Map();
  const rows = await prisma.translationOwnership.findMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      resourceId: { in: [...resourceIds] },
    },
  });
  const map = new Map<string, OwnershipRecord[]>();
  for (const row of rows) {
    const list = map.get(row.resourceId) ?? [];
    list.push({
      key: row.key,
      locale: row.locale,
      owner: row.owner,
      valueHash: row.valueHash,
    });
    map.set(row.resourceId, list);
  }
  return map;
}

export interface OwnershipWrite {
  resourceId: string;
  resourceType: string;
  key: string;
  locale: string;
  owner: "ai" | "manual";
  valueHash: string;
  sourceDigest: string | null;
  syncId: string | null;
  writtenBy: string | null;
}

/** Records what was just written to Shopify, replacing any earlier record of the field. */
export async function recordOwnership(
  principal: Principal,
  writes: readonly OwnershipWrite[],
  now: Date,
): Promise<void> {
  if (writes.length === 0) return;
  const shopId = await shopIdFor(principal);
  await prisma.$transaction(
    writes.map((write) =>
      prisma.translationOwnership.upsert({
        where: {
          shopId_resourceId_key_locale: {
            shopId,
            resourceId: write.resourceId,
            key: write.key,
            locale: write.locale,
          },
        },
        create: { shopId, writtenAt: now, ...write },
        update: {
          owner: write.owner,
          valueHash: write.valueHash,
          sourceDigest: write.sourceDigest,
          syncId: write.syncId,
          writtenBy: write.writtenBy,
          writtenAt: now,
        },
      }),
    ),
  );
}

/**
 * Whether this app wrote a translation of the resource since `since`. A
 * products/update webhook that arrives right after the engine registered a
 * product's translations is the echo of that write, not a merchant's edit.
 */
export async function wroteResourceSince(
  principal: Principal,
  resourceId: string,
  since: Date,
): Promise<boolean> {
  const count = await prisma.translationOwnership.count({
    where: {
      shop: { domain: shopDomainOf(principal) },
      resourceId,
      writtenAt: { gte: since },
    },
  });
  return count > 0;
}

/** A translation removed in Shopify has no owner any more. */
export async function forgetOwnership(
  principal: Principal,
  resourceId: string,
  locale: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  await prisma.translationOwnership.deleteMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      resourceId,
      locale,
      key: { in: [...keys] },
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Syncs                                                                      */
/* -------------------------------------------------------------------------- */

export type Sync = TranslationSync;
export type SyncItem = TranslationSyncItem;

export interface SyncInput {
  kind: TranslationSyncKind;
  mode: TranslationSyncMode;
  sourceLocale: string;
  targetLocales: string[];
  resourceTypes: string[];
  resourceIds?: string[];
  estimate?: Prisma.InputJsonValue | null;
  requestedBy: string | null;
}

export async function createSync(
  principal: Principal,
  input: SyncInput,
): Promise<Sync> {
  const shopId = await shopIdFor(principal);
  return prisma.translationSync.create({
    data: {
      shopId,
      kind: input.kind,
      mode: input.mode,
      sourceLocale: input.sourceLocale,
      targetLocales: input.targetLocales,
      resourceTypes: input.resourceTypes,
      resourceIds: input.resourceIds ?? [],
      // A sync that names its resources knows its size; one that walks the
      // store learns it as it goes.
      totalResources: input.resourceIds?.length ?? 0,
      estimate: input.estimate ?? Prisma.DbNull,
      requestedBy: input.requestedBy,
    },
  });
}

/**
 * Adds a resource to the sync that is still collecting changed resources
 * for the same languages and mode — queued, from Shopify rather than a
 * person — and returns it; null when there is no such sync, or it started
 * between the read and the write, so the caller opens a new one. A resource
 * already on the list is not added twice.
 */
export async function appendToCollectingSync(
  principal: Principal,
  input: {
    resourceId: string;
    resourceType: string;
    mode: TranslationSyncMode;
    targetLocales: readonly string[];
  },
): Promise<{ sync: Sync; added: boolean } | null> {
  const sync = await prisma.translationSync.findFirst({
    where: {
      shop: { domain: shopDomainOf(principal) },
      kind: "resource",
      status: "queued",
      requestedBy: null,
      mode: input.mode,
      targetLocales: { equals: [...input.targetLocales] },
      resourceTypes: { equals: [input.resourceType] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!sync) return null;
  if (sync.resourceIds.includes(input.resourceId)) return { sync, added: false };
  const updated = await prisma.translationSync.updateMany({
    where: { id: sync.id, status: "queued" },
    data: {
      resourceIds: { push: input.resourceId },
      totalResources: { increment: 1 },
    },
  });
  if (updated.count === 0) return null;
  return {
    sync: {
      ...sync,
      resourceIds: [...sync.resourceIds, input.resourceId],
      totalResources: sync.totalResources + 1,
    },
    added: true,
  };
}

export async function getSync(
  principal: Principal,
  id: string,
): Promise<Sync | null> {
  return prisma.translationSync.findFirst({
    where: { id, shop: { domain: shopDomainOf(principal) } },
  });
}

export async function listSyncs(
  principal: Principal,
  limit = 50,
): Promise<Sync[]> {
  return prisma.translationSync.findMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function listActiveSyncs(principal: Principal): Promise<Sync[]> {
  return prisma.translationSync.findMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      status: { in: ["queued", "running"] },
    },
    orderBy: { createdAt: "asc" },
  });
}

export interface SyncCursor {
  typeIndex: number;
  after: string | null;
}

export type ClaimedSync = Omit<Sync, "cursor"> & { cursor: SyncCursor };

/**
 * Claims the sync for one pass: queued → running, or running stays running.
 * Returns null when the sync is finished or cancelled, so a job that was
 * queued before a cancel does nothing.
 */
export async function beginSyncPass(
  principal: Principal,
  id: string,
  now: Date,
): Promise<ClaimedSync | null> {
  // Claim first, read second: a sync that was collecting resources while
  // queued (`appendToCollectingSync`) stops taking them the moment it is
  // running, and the read after the claim sees the whole list.
  await prisma.translationSync.updateMany({
    where: { id, shop: { domain: shopDomainOf(principal) }, status: "queued" },
    data: { status: "running", startedAt: now },
  });
  const sync = await getSync(principal, id);
  if (!sync || sync.status !== "running") return null;
  return { ...sync, cursor: parseCursor(sync.cursor) };
}

function parseCursor(value: Prisma.JsonValue | null): SyncCursor {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const typeIndex = value.typeIndex;
    const after = value.after;
    return {
      typeIndex: typeof typeIndex === "number" ? typeIndex : 0,
      after: typeof after === "string" ? after : null,
    };
  }
  return { typeIndex: 0, after: null };
}

export interface PassCounts {
  resources: number;
  translated: number;
  copied: number;
  skipped: number;
  failed: number;
}

/** Advances the cursor and the counts together, after a page is fully done. */
export async function advanceSync(
  id: string,
  cursor: SyncCursor,
  counts: PassCounts,
): Promise<void> {
  await prisma.translationSync.update({
    where: { id },
    data: {
      cursor: { typeIndex: cursor.typeIndex, after: cursor.after } satisfies Prisma.InputJsonObject,
      doneResources: { increment: counts.resources },
      translatedFields: { increment: counts.translated },
      copiedFields: { increment: counts.copied },
      skippedFields: { increment: counts.skipped },
      failedFields: { increment: counts.failed },
    },
  });
}

/**
 * A sync created before the primary locale was known (the nightly tick has
 * no Shopify client) learns it on its first pass. Empty means "the store's
 * default", which is what every page shows for it.
 */
export async function setSyncSource(id: string, sourceLocale: string): Promise<void> {
  await prisma.translationSync.updateMany({
    where: { id, sourceLocale: "" },
    data: { sourceLocale },
  });
}

export async function setSyncTotal(id: string, total: number): Promise<void> {
  await prisma.translationSync.update({
    where: { id },
    data: { totalResources: total },
  });
}

export async function finishSync(
  id: string,
  status: Extract<TranslationSyncStatus, "completed" | "failed" | "cancelled">,
  now: Date,
  lastError: string | null = null,
): Promise<void> {
  await prisma.translationSync.update({
    where: { id },
    data: { status, finishedAt: now, lastError },
  });
}

/**
 * Removes a sync and its items. Only for a sync collected from Shopify's
 * webhooks that found nothing to do: a row saying "12 products, nothing
 * translated" every few minutes is what makes a syncs page unreadable, and
 * such a sync made no provider request, so no usage points at it.
 */
export async function deleteSync(id: string): Promise<void> {
  await prisma.translationSync.delete({ where: { id } });
}

export async function requestSyncCancel(
  principal: Principal,
  id: string,
): Promise<boolean> {
  const updated = await prisma.translationSync.updateMany({
    where: {
      id,
      shop: { domain: shopDomainOf(principal) },
      status: { in: ["queued", "running"] },
    },
    data: { cancelRequested: true },
  });
  return updated.count === 1;
}

/** Whether a cancel was asked for since the pass began. Read between pages. */
export async function isCancelRequested(id: string): Promise<boolean> {
  const row = await prisma.translationSync.findUnique({
    where: { id },
    select: { cancelRequested: true },
  });
  return row?.cancelRequested ?? true;
}

export interface SyncItemInput {
  resourceId: string;
  resourceType: string;
  locale: string;
  title: string | null;
  status: TranslationItemStatus;
  fields: number;
  detail?: Prisma.InputJsonValue | null;
  error?: string | null;
  /** Why the translation came out as it did; for developers (docs/translations.md § Explainability). */
  trace?: TranslationTrace | null;
}

export async function recordSyncItems(
  principal: Principal,
  syncId: string,
  items: readonly SyncItemInput[],
): Promise<void> {
  if (items.length === 0) return;
  const shopId = await shopIdFor(principal);
  await prisma.translationSyncItem.createMany({
    data: items.map((item) => ({
      shopId,
      syncId,
      resourceId: item.resourceId,
      resourceType: item.resourceType,
      locale: item.locale,
      title: item.title,
      status: item.status,
      fields: item.fields,
      detail: item.detail ?? Prisma.DbNull,
      error: item.error ?? null,
      trace: item.trace ?? Prisma.DbNull,
    })),
  });
}

export async function listSyncItems(
  principal: Principal,
  syncId: string,
  filter: { status?: TranslationItemStatus | null; limit?: number } = {},
): Promise<SyncItem[]> {
  return prisma.translationSyncItem.findMany({
    where: {
      syncId,
      shop: { domain: shopDomainOf(principal) },
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: filter.limit ?? 200,
  });
}

export async function countSyncItems(
  principal: Principal,
  syncId: string,
): Promise<Partial<Record<TranslationItemStatus, number>>> {
  const shopId = await shopIdFor(principal);
  const groups = await prisma.translationSyncItem.groupBy({
    by: ["status"],
    where: { syncId, shopId },
    _count: { _all: true },
  });
  const counts: Partial<Record<TranslationItemStatus, number>> = {};
  for (const group of groups) counts[group.status] = group._count._all;
  return counts;
}

/**
 * A sync whose job has not touched it for far too long is dead: its pg-boss
 * job expired after the retries ran out and nothing will come back for it.
 */
export async function abandonStaleSyncs(olderThan: Date, now: Date): Promise<number> {
  const updated = await prisma.translationSync.updateMany({
    where: {
      status: { in: ["queued", "running"] },
      updatedAt: { lt: olderThan },
    },
    data: {
      status: "failed",
      finishedAt: now,
      lastError: "The sync stopped without finishing and was given up on.",
    },
  });
  return updated.count;
}

/* -------------------------------------------------------------------------- */
/* AI usage                                                                   */
/* -------------------------------------------------------------------------- */

export interface UsageWrite {
  syncId: string | null;
  resourceId: string | null;
  resourceType: string | null;
  sourceLocale: string;
  targetLocale: string;
  purpose: "translate" | "detect" | "profile" | "autofill";
  /** The prompt version the request was built with; null for requests without one. */
  promptVersion: string | null;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  result: AiUsageResult;
  errorMessage: string | null;
  pricingVersion: string | null;
  estimatedCostMicros: number | null;
}

export async function recordUsage(
  principal: Principal,
  write: UsageWrite,
): Promise<void> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: { id: true },
  });
  if (!shop) return;
  await prisma.aiUsage.create({
    data: {
      shopId: shop.id,
      ...write,
      estimatedCostMicros:
        write.estimatedCostMicros === null
          ? null
          : BigInt(write.estimatedCostMicros),
    },
  });
}


/**
 * What a usage read covers: a span of time, a sync, or both. `from` is
 * inclusive and `to` exclusive; null is unbounded. `syncId` null reads
 * every row, and the explicit `outsideSync` reads the rows no sync owns
 * (language detection).
 */
export interface UsageScope {
  from?: Date | null;
  to?: Date | null;
  syncId?: string | null;
  outsideSync?: boolean;
}

function usageWhere(shopId: string, scope: UsageScope): Prisma.AiUsageWhereInput {
  return {
    shopId,
    // The rig builder's claude-pool rows share the table (docs/rig-builder.md).
    provider: "openai",
    ...(scope.from || scope.to
      ? {
          createdAt: {
            ...(scope.from ? { gte: scope.from } : {}),
            ...(scope.to ? { lt: scope.to } : {}),
          },
        }
      : {}),
    ...(scope.syncId ? { syncId: scope.syncId } : {}),
    ...(scope.outsideSync ? { syncId: null } : {}),
  };
}

function usageSql(shopId: string, scope: UsageScope): Prisma.Sql {
  return Prisma.sql`u."shop_id" = ${shopId}
    AND u."provider" = 'openai'
    ${scope.from ? Prisma.sql`AND u."created_at" >= ${scope.from}` : Prisma.empty}
    ${scope.to ? Prisma.sql`AND u."created_at" < ${scope.to}` : Prisma.empty}
    ${scope.syncId ? Prisma.sql`AND u."sync_id" = ${scope.syncId}` : Prisma.empty}
    ${scope.outsideSync ? Prisma.sql`AND u."sync_id" IS NULL` : Prisma.empty}`;
}

export interface UsageTotals {
  requests: number;
  /** Requests the provider refused or that failed to parse; their tokens count. */
  failed: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: bigint;
  /** Requests whose model is not in the pricing table, so the cost is short. */
  unpriced: number;
  /** Distinct resources translated. */
  resources: number;
}

const EMPTY_TOTALS: UsageTotals = {
  requests: 0,
  failed: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costMicros: 0n,
  unpriced: 0,
  resources: 0,
};

/** The sums over every request in the scope. */
export async function usageTotals(
  principal: Principal,
  scope: UsageScope,
): Promise<UsageTotals> {
  const shopId = await shopIdFor(principal);
  const rows = await prisma.$queryRaw<
    Array<{
      requests: number;
      failed: number;
      input_tokens: bigint;
      cached_input_tokens: bigint;
      output_tokens: bigint;
      total_tokens: bigint;
      cost_micros: bigint;
      unpriced: number;
      resources: number;
    }>
  >`
    SELECT
      count(*)::int AS "requests",
      count(*) FILTER (WHERE u."result" = 'failed')::int AS "failed",
      coalesce(sum(u."input_tokens"), 0)::bigint AS "input_tokens",
      coalesce(sum(u."cached_input_tokens"), 0)::bigint AS "cached_input_tokens",
      coalesce(sum(u."output_tokens"), 0)::bigint AS "output_tokens",
      coalesce(sum(u."total_tokens"), 0)::bigint AS "total_tokens",
      coalesce(sum(u."estimated_cost_micros"), 0)::bigint AS "cost_micros",
      count(*) FILTER (WHERE u."estimated_cost_micros" IS NULL)::int AS "unpriced",
      count(DISTINCT u."resource_id") FILTER (WHERE u."result" = 'ok')::int AS "resources"
    FROM "ai_usage" u
    WHERE ${usageSql(shopId, scope)}
  `;
  const row = rows[0];
  if (!row) return EMPTY_TOTALS;
  return {
    requests: Number(row.requests),
    failed: Number(row.failed),
    inputTokens: Number(row.input_tokens),
    cachedInputTokens: Number(row.cached_input_tokens),
    outputTokens: Number(row.output_tokens),
    totalTokens: Number(row.total_tokens),
    costMicros: BigInt(row.cost_micros),
    unpriced: Number(row.unpriced),
    resources: Number(row.resources),
  };
}

export type UsageDimension = "targetLocale" | "model" | "resourceType";

export interface UsageBreakdownRow {
  key: string | null;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: bigint;
}

/** The scope's requests grouped one way, most tokens first. */
export async function usageBreakdown(
  principal: Principal,
  by: UsageDimension,
  scope: UsageScope,
  limit = 50,
): Promise<UsageBreakdownRow[]> {
  const shopId = await shopIdFor(principal);
  const groups = await prisma.aiUsage.groupBy({
    by: [by],
    where: usageWhere(shopId, scope),
    _count: { _all: true },
    _sum: {
      inputTokens: true,
      cachedInputTokens: true,
      outputTokens: true,
      totalTokens: true,
      estimatedCostMicros: true,
    },
    orderBy: { _sum: { totalTokens: "desc" } },
    take: limit,
  });
  return groups.map((group) => ({
    key: group[by],
    requests: group._count._all,
    inputTokens: group._sum.inputTokens ?? 0,
    cachedInputTokens: group._sum.cachedInputTokens ?? 0,
    outputTokens: group._sum.outputTokens ?? 0,
    totalTokens: group._sum.totalTokens ?? 0,
    costMicros: group._sum.estimatedCostMicros ?? 0n,
  }));
}

export interface UsageTrendRow {
  /** The bucket's first instant. */
  at: Date;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: bigint;
}

/**
 * Usage over time for the usage page's chart: one row per hour, day or
 * month that saw a request, oldest first. The same sums as `usageTotals`,
 * cut by `created_at`; Prisma's `groupBy` cannot truncate a date, so this
 * is SQL.
 */
export async function usageTrend(
  principal: Principal,
  scope: UsageScope,
  bucket: "hour" | "day" | "month",
): Promise<UsageTrendRow[]> {
  const shopId = await shopIdFor(principal);
  const rows = await prisma.$queryRaw<
    Array<{
      at: Date;
      requests: number;
      input_tokens: bigint;
      cached_input_tokens: bigint;
      output_tokens: bigint;
      total_tokens: bigint;
      cost_micros: bigint;
    }>
  >`
    SELECT
      date_trunc(${bucket}::text, u."created_at") AS "at",
      count(*)::int AS "requests",
      coalesce(sum(u."input_tokens"), 0)::bigint AS "input_tokens",
      coalesce(sum(u."cached_input_tokens"), 0)::bigint AS "cached_input_tokens",
      coalesce(sum(u."output_tokens"), 0)::bigint AS "output_tokens",
      coalesce(sum(u."total_tokens"), 0)::bigint AS "total_tokens",
      coalesce(sum(u."estimated_cost_micros"), 0)::bigint AS "cost_micros"
    FROM "ai_usage" u
    WHERE ${usageSql(shopId, scope)}
    GROUP BY 1
    ORDER BY 1
  `;
  return rows.map((row) => ({
    at: row.at,
    requests: Number(row.requests),
    inputTokens: Number(row.input_tokens),
    cachedInputTokens: Number(row.cached_input_tokens),
    outputTokens: Number(row.output_tokens),
    totalTokens: Number(row.total_tokens),
    costMicros: BigInt(row.cost_micros),
  }));
}

export type SyncUsageSort =
  | "started"
  | "cost"
  | "tokens"
  | "requests"
  | "resources";

export interface SyncUsageQuery {
  sort: SyncUsageSort;
  desc: boolean;
  /** One-based. */
  page: number;
  pageSize: number;
  /** Only requests into this language. */
  locale?: string | null;
  /** Only syncs run in this mode. */
  mode?: TranslationSyncMode | null;
}

export interface SyncUsageRow {
  /** Null for requests outside any sync. */
  syncId: string | null;
  kind: TranslationSyncKind | null;
  mode: TranslationSyncMode | null;
  status: TranslationSyncStatus | null;
  targetLocales: string[];
  doneResources: number | null;
  /** When the sync was created, or the first request when there is no sync. */
  startedAt: Date;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: bigint;
  unpriced: number;
  /** Distinct resources the provider answered for. */
  resources: number;
}

export interface SyncUsagePage {
  rows: SyncUsageRow[];
  /** How many syncs the scope and filters cover, across every page. */
  total: number;
}

const SYNC_SORT_COLUMN: Record<SyncUsageSort, Prisma.Sql> = {
  started: Prisma.sql`"started_at"`,
  cost: Prisma.sql`"cost_micros"`,
  tokens: Prisma.sql`"total_tokens"`,
  requests: Prisma.sql`"requests"`,
  resources: Prisma.sql`"resources"`,
};

/**
 * The scope's requests grouped by the sync that made them, joined to the
 * sync so a row can be named, sorted and paged in the database. One query:
 * the page's rows and the count of every group come back together, so a
 * hundred syncs are never a hundred reads.
 *
 * The join is a left join and the group key the request's own `sync_id`, so
 * requests outside any sync (language detection) are one row of their own
 * and a deleted sync's requests are still counted.
 */
export async function usageBySync(
  principal: Principal,
  scope: UsageScope,
  query: SyncUsageQuery,
): Promise<SyncUsagePage> {
  const shopId = await shopIdFor(principal);
  const orderBy = SYNC_SORT_COLUMN[query.sort];
  const direction = query.desc ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  const offset = Math.max(0, query.page - 1) * query.pageSize;
  const rows = await prisma.$queryRaw<
    Array<{
      sync_id: string | null;
      kind: TranslationSyncKind | null;
      mode: TranslationSyncMode | null;
      status: TranslationSyncStatus | null;
      target_locales: string[] | null;
      done_resources: number | null;
      started_at: Date;
      requests: number;
      input_tokens: bigint;
      cached_input_tokens: bigint;
      output_tokens: bigint;
      total_tokens: bigint;
      cost_micros: bigint;
      unpriced: number;
      resources: number;
      groups: number;
    }>
  >`
    SELECT * FROM (
      SELECT
        u."sync_id",
        s."kind",
        s."mode",
        s."status",
        s."target_locales",
        s."done_resources",
        coalesce(s."created_at", min(u."created_at")) AS "started_at",
        count(*)::int AS "requests",
        coalesce(sum(u."input_tokens"), 0)::bigint AS "input_tokens",
        coalesce(sum(u."cached_input_tokens"), 0)::bigint AS "cached_input_tokens",
        coalesce(sum(u."output_tokens"), 0)::bigint AS "output_tokens",
        coalesce(sum(u."total_tokens"), 0)::bigint AS "total_tokens",
        coalesce(sum(u."estimated_cost_micros"), 0)::bigint AS "cost_micros",
        count(*) FILTER (WHERE u."estimated_cost_micros" IS NULL)::int AS "unpriced",
        count(DISTINCT u."resource_id") FILTER (WHERE u."result" = 'ok')::int AS "resources",
        count(*) OVER ()::int AS "groups"
      FROM "ai_usage" u
      LEFT JOIN "translation_sync" s ON s."id" = u."sync_id"
      WHERE ${usageSql(shopId, scope)}
        ${query.locale ? Prisma.sql`AND u."target_locale" = ${query.locale}` : Prisma.empty}
        ${query.mode ? Prisma.sql`AND s."mode"::text = ${query.mode}` : Prisma.empty}
      GROUP BY u."sync_id", s."id"
    ) grouped
    ORDER BY ${orderBy} ${direction} NULLS LAST, "sync_id"
    LIMIT ${query.pageSize} OFFSET ${offset}
  `;
  return {
    rows: rows.map((row) => ({
      syncId: row.sync_id,
      kind: row.kind,
      mode: row.mode,
      status: row.status,
      targetLocales: row.target_locales ?? [],
      doneResources: row.done_resources,
      startedAt: row.started_at,
      requests: Number(row.requests),
      inputTokens: Number(row.input_tokens),
      cachedInputTokens: Number(row.cached_input_tokens),
      outputTokens: Number(row.output_tokens),
      totalTokens: Number(row.total_tokens),
      costMicros: BigInt(row.cost_micros),
      unpriced: Number(row.unpriced),
      resources: Number(row.resources),
    })),
    total: Number(rows[0]?.groups ?? 0),
  };
}

export type UsageRequest = Pick<
  Prisma.AiUsageGetPayload<Record<string, never>>,
  | "id"
  | "resourceId"
  | "resourceType"
  | "targetLocale"
  | "purpose"
  | "model"
  | "inputTokens"
  | "cachedInputTokens"
  | "outputTokens"
  | "totalTokens"
  | "result"
  | "errorMessage"
  | "estimatedCostMicros"
  | "createdAt"
>;

/** The scope's requests one by one, newest first, for a drill-down. */
export async function usageRequests(
  principal: Principal,
  scope: UsageScope,
  limit = 50,
): Promise<UsageRequest[]> {
  const shopId = await shopIdFor(principal);
  return prisma.aiUsage.findMany({
    where: usageWhere(shopId, scope),
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      resourceId: true,
      resourceType: true,
      targetLocale: true,
      purpose: true,
      model: true,
      inputTokens: true,
      cachedInputTokens: true,
      outputTokens: true,
      totalTokens: true,
      result: true,
      errorMessage: true,
      estimatedCostMicros: true,
      createdAt: true,
    },
  });
}
