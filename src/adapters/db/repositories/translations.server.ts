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
  type GlossaryTerm,
  type LanguageSettings,
  type OwnershipRecord,
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
  input: { resourceId: string; resourceType: string; detectedLocale: string; primaryLocale: string },
): Promise<void> {
  const shopId = await shopIdFor(principal);
  const existing = await prisma.translationSourceOverride.findUnique({
    where: { shopId_resourceId: { shopId, resourceId: input.resourceId } },
  });
  if (existing) {
    await prisma.translationSourceOverride.update({
      where: { id: existing.id },
      data: { detectedLocale: input.detectedLocale },
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
      estimate: input.estimate ?? Prisma.DbNull,
      requestedBy: input.requestedBy,
    },
  });
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
  const sync = await getSync(principal, id);
  if (!sync) return null;
  if (sync.status === "queued") {
    await prisma.translationSync.update({
      where: { id },
      data: { status: "running", startedAt: now },
    });
  } else if (sync.status !== "running") {
    return null;
  }
  return { ...sync, status: "running", cursor: parseCursor(sync.cursor) };
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
  purpose: "translate" | "detect";
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

export interface UsageTotals {
  requests: number;
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
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costMicros: 0n,
  unpriced: 0,
  resources: 0,
};

export async function usageTotals(
  principal: Principal,
  since: Date | null,
): Promise<UsageTotals> {
  const shopId = await shopIdFor(principal);
  const where: Prisma.AiUsageWhereInput = {
    shopId,
    ...(since ? { createdAt: { gte: since } } : {}),
  };
  const [aggregate, unpriced, resources] = await Promise.all([
    prisma.aiUsage.aggregate({
      where,
      _count: { _all: true },
      _sum: {
        inputTokens: true,
        cachedInputTokens: true,
        outputTokens: true,
        totalTokens: true,
        estimatedCostMicros: true,
      },
    }),
    prisma.aiUsage.count({ where: { ...where, estimatedCostMicros: null } }),
    prisma.aiUsage.findMany({
      where: { ...where, resourceId: { not: null }, result: "ok" },
      distinct: ["resourceId"],
      select: { resourceId: true },
    }),
  ]);
  return {
    ...EMPTY_TOTALS,
    requests: aggregate._count._all,
    inputTokens: aggregate._sum.inputTokens ?? 0,
    cachedInputTokens: aggregate._sum.cachedInputTokens ?? 0,
    outputTokens: aggregate._sum.outputTokens ?? 0,
    totalTokens: aggregate._sum.totalTokens ?? 0,
    costMicros: aggregate._sum.estimatedCostMicros ?? 0n,
    unpriced,
    resources: resources.length,
  };
}

export type UsageDimension = "targetLocale" | "model" | "resourceType" | "syncId";

export interface UsageBreakdownRow {
  key: string | null;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: bigint;
}

export async function usageBreakdown(
  principal: Principal,
  by: UsageDimension,
  since: Date | null,
  limit = 20,
): Promise<UsageBreakdownRow[]> {
  const shopId = await shopIdFor(principal);
  const groups = await prisma.aiUsage.groupBy({
    by: [by],
    where: { shopId, ...(since ? { createdAt: { gte: since } } : {}) },
    _count: { _all: true },
    _sum: {
      inputTokens: true,
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
    outputTokens: group._sum.outputTokens ?? 0,
    totalTokens: group._sum.totalTokens ?? 0,
    costMicros: group._sum.estimatedCostMicros ?? 0n,
  }));
}

/** Usage for one sync, for its page. */
export async function usageForSync(
  principal: Principal,
  syncId: string,
): Promise<UsageTotals> {
  const shopId = await shopIdFor(principal);
  const where: Prisma.AiUsageWhereInput = { shopId, syncId };
  const [aggregate, unpriced] = await Promise.all([
    prisma.aiUsage.aggregate({
      where,
      _count: { _all: true },
      _sum: {
        inputTokens: true,
        cachedInputTokens: true,
        outputTokens: true,
        totalTokens: true,
        estimatedCostMicros: true,
      },
    }),
    prisma.aiUsage.count({ where: { ...where, estimatedCostMicros: null } }),
  ]);
  return {
    ...EMPTY_TOTALS,
    requests: aggregate._count._all,
    inputTokens: aggregate._sum.inputTokens ?? 0,
    cachedInputTokens: aggregate._sum.cachedInputTokens ?? 0,
    outputTokens: aggregate._sum.outputTokens ?? 0,
    totalTokens: aggregate._sum.totalTokens ?? 0,
    costMicros: aggregate._sum.estimatedCostMicros ?? 0n,
    unpriced,
  };
}
