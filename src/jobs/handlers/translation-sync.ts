import type { Job } from "pg-boss";
import { z } from "zod";

import { isConfigured } from "~/adapters/ai/openai.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { raiseException } from "~/adapters/db/repositories/exception.server";
import {
  advanceSync,
  beginSyncPass,
  finishSync,
  getSync,
  isCancelRequested,
  listLanguageSettings,
  listOwnership,
  listSourceOverrides,
  recordLanguageSync,
  recordSyncItems,
  setSyncSource,
  type ClaimedSync,
  type PassCounts,
} from "~/adapters/db/repositories/translations.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES, translationSyncKey } from "~/adapters/queue/queues";
import { listShopLocales } from "~/adapters/shopify/locales";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import {
  readShopName,
  readTranslatableResources,
  readTranslatableResourcesByIds,
  type TranslatableResource,
} from "~/adapters/shopify/translations";
import {
  loadGlossaries,
  translateResource,
  type EngineContext,
} from "~/adapters/translations/engine.server";
import { loadIntelligence } from "~/adapters/translations/intelligence.server";
import { requestCoverageRefresh } from "~/adapters/translations/syncs.server";
import { isResourceType, type ResourceType } from "~/domain/translations/types";
import { serviceToken } from "~/domain/types";

export const translationSyncJobSchema = z.object({
  shopDomain: z.string().min(1),
  syncId: z.string().min(1),
});

/** Resources per pass. Each is up to N provider calls, one per target language. */
const PAGE = 10;

/**
 * One pass of a translation sync (docs/translations.md § Jobs).
 *
 * Reads a page of resources of the current type, runs the engine over each
 * for every target language, records the items, advances the cursor and
 * re-enqueues itself. The cursor moves only after a page's items are
 * written, so a pass that dies is repeated, not skipped — and every write to
 * Shopify replaces rather than appends, so a repeated page changes nothing
 * that was already right.
 *
 * Between pages it looks for a cancel request and stops cleanly if there is
 * one. When the last type's last page is done the sync completes, the
 * languages' last-successful-sync marks move, and a coverage refresh is
 * asked for so the Languages page reflects the work.
 */
export async function handleTranslationSync(job: Job<unknown>): Promise<void> {
  const { shopDomain, syncId } = translationSyncJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "translation-sync");
  const log = getLogger();
  const now = new Date();

  const sync = await beginSyncPass(principal, syncId, now);
  if (!sync) return;

  if (sync.cancelRequested) {
    await finishSync(syncId, "cancelled", new Date());
    await appendEvent(principal, {
      entityType: "translation_sync",
      entityId: syncId,
      event: "translation_sync.cancelled",
    });
    return;
  }

  if (!isConfigured()) {
    await fail(
      principal,
      sync,
      "AI translation is not configured on this server (OPENAI_API_KEY is not set).",
    );
    return;
  }

  const { admin } = await unauthenticated.admin(shopDomain);
  const locales = await listShopLocales(admin);
  if (locales.kind === "unavailable") {
    await fail(principal, sync, locales.reason);
    return;
  }
  const primary = locales.locales.find((locale) => locale.primary);
  if (!primary) {
    await fail(principal, sync, "Shopify reports no primary locale for the store.");
    return;
  }
  if (sync.sourceLocale === "") await setSyncSource(syncId, primary.locale);
  const enabled = new Set(locales.locales.map((locale) => locale.locale));
  const targetLocales = sync.targetLocales.filter(
    (locale) => enabled.has(locale) && locale !== primary.locale,
  );
  if (targetLocales.length === 0) {
    await complete(principal, sync, []);
    return;
  }

  const types = sync.resourceTypes.filter(isResourceType);
  const type: ResourceType | undefined = types[sync.cursor.typeIndex];
  if (type === undefined) {
    await complete(principal, sync, targetLocales);
    return;
  }

  const [settingsRows, glossaries, storeName] = await Promise.all([
    listLanguageSettings(principal),
    loadGlossaries(principal, targetLocales),
    readShopName(admin),
  ]);
  // The store profile is checked (and, rarely, rebuilt) before the first
  // page and read from the database on every page after.
  const intelligence = await loadIntelligence(principal, admin, {
    primaryLocale: primary.locale,
    storeName,
  });
  const ctx: EngineContext = {
    principal,
    admin,
    primaryLocale: primary.locale,
    storeName,
    syncId,
    mode: sync.mode,
    requestedBy: sync.requestedBy,
    settings: new Map(settingsRows.map((row) => [row.locale, row])),
    intelligence,
  };

  // A resource sync names its resources and has one page; a store or
  // language sync walks the type's connection.
  let resources: TranslatableResource[];
  let nextCursor: { typeIndex: number; after: string | null };
  if (sync.resourceIds.length > 0) {
    resources = await readTranslatableResourcesByIds(admin, {
      ids: sync.resourceIds,
      locales: targetLocales,
    });
    nextCursor = { typeIndex: types.length, after: null };
  } else {
    const page = await readTranslatableResources(admin, {
      type,
      first: PAGE,
      after: sync.cursor.after,
      locales: targetLocales,
    });
    resources = page.resources;
    nextCursor =
      page.hasNextPage && page.endCursor
        ? { typeIndex: sync.cursor.typeIndex, after: page.endCursor }
        : { typeIndex: sync.cursor.typeIndex + 1, after: null };
  }

  const ids = resources.map((resource) => resource.resourceId);
  const [overrides, ownership] = await Promise.all([
    listSourceOverrides(principal, ids),
    listOwnership(principal, ids),
    intelligence.contexts.prime(ids.map((resourceId) => ({ resourceId, type }))),
  ]);

  const counts: PassCounts = {
    resources: 0,
    translated: 0,
    copied: 0,
    skipped: 0,
    failed: 0,
  };
  for (const resource of resources) {
    const outcome = await translateResource(ctx, {
      resource,
      resourceType: type,
      targetLocales,
      override: overrides.get(resource.resourceId) ?? null,
      ownership: ownership.get(resource.resourceId) ?? [],
      glossaries,
    });
    await recordSyncItems(principal, syncId, outcome.items);
    counts.resources += 1;
    counts.translated += outcome.translated;
    counts.copied += outcome.copied;
    counts.skipped += outcome.skipped;
    counts.failed += outcome.failed;
  }
  await advanceSync(syncId, nextCursor, counts);
  log.info(
    { shop: shopDomain, syncId, type, ...counts },
    "Translation sync page done",
  );

  if (await isCancelRequested(syncId)) {
    await finishSync(syncId, "cancelled", new Date());
    await appendEvent(principal, {
      entityType: "translation_sync",
      entityId: syncId,
      event: "translation_sync.cancelled",
    });
    return;
  }

  if (nextCursor.typeIndex >= types.length) {
    await complete(principal, sync, targetLocales);
    return;
  }
  await enqueue(
    QUEUES.translationSync,
    { shopDomain, syncId },
    { singletonKey: translationSyncKey(syncId) },
  );
}

async function complete(
  principal: ReturnType<typeof serviceToken>,
  sync: ClaimedSync,
  targetLocales: readonly string[],
): Promise<void> {
  const now = new Date();
  await finishSync(sync.id, "completed", now);
  await recordLanguageSync(principal, targetLocales, "succeeded", now);
  await appendEvent(principal, {
    entityType: "translation_sync",
    entityId: sync.id,
    event: "translation_sync.completed",
  });
  // Items with failures are a condition a person should see, once.
  const fresh = await getSync(principal, sync.id);
  if (fresh && fresh.failedFields > 0) {
    await raiseException(principal, {
      kind: "translation_failed",
      dedupeKey: `translation-sync:${sync.id}`,
      message: `${fresh.failedFields.toLocaleString("en")} fields could not be translated in a sync. Open the sync to see each resource and the reason.`,
      detail: { syncId: sync.id, failedFields: fresh.failedFields },
    });
  }
  await requestCoverageRefresh(principal, 60);
}

async function fail(
  principal: ReturnType<typeof serviceToken>,
  sync: ClaimedSync,
  reason: string,
): Promise<void> {
  await finishSync(sync.id, "failed", new Date(), reason);
  await raiseException(principal, {
    kind: "translation_failed",
    dedupeKey: `translation-sync:${sync.id}`,
    message: `A translation sync could not run: ${reason}`,
    detail: { syncId: sync.id },
  });
  await appendEvent(principal, {
    entityType: "translation_sync",
    entityId: sync.id,
    event: "translation_sync.failed",
    detail: { reason },
  });
}
