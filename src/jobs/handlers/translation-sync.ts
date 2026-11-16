import type { Job } from "pg-boss";
import { z } from "zod";

import { isConfigured } from "~/adapters/ai/openai.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  raiseException,
  resolveExceptionByKey,
} from "~/adapters/db/repositories/exception.server";
import { listFailures } from "~/adapters/db/repositories/translation-failures.server";
import {
  advanceSync,
  beginSyncPass,
  deleteSync,
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
  type ResourceOutcome,
} from "~/adapters/translations/engine.server";
import { loadIntelligence } from "~/adapters/translations/intelligence.server";
import { requestCoverageRefresh } from "~/adapters/translations/syncs.server";
import {
  translationFailureKey,
  translationFailureMessage,
} from "~/domain/translations/failure-notice";
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
    await fail(
      principal,
      sync,
      "Shopify reports no primary locale for the store.",
    );
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

  // A resource sync names its resources and pages through the list, its
  // cursor the offset of the next one; a store or language sync walks the
  // type's connection.
  let resources: TranslatableResource[];
  let nextCursor: { typeIndex: number; after: string | null };
  if (sync.resourceIds.length > 0) {
    const ids = [...new Set(sync.resourceIds)];
    const offset = Number(sync.cursor.after ?? 0) || 0;
    resources = await readTranslatableResourcesByIds(admin, {
      ids: ids.slice(offset, offset + PAGE),
      locales: targetLocales,
    });
    nextCursor =
      offset + PAGE < ids.length
        ? { typeIndex: sync.cursor.typeIndex, after: String(offset + PAGE) }
        : { typeIndex: types.length, after: null };
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
    intelligence.contexts.prime(
      ids.map((resourceId) => ({ resourceId, type })),
    ),
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
    await noteFailures(principal, syncId, resource.resourceId, outcome);
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

  // A sync collected from webhooks that found every product already
  // translated is not worth a row: the change was a price, a stock level or
  // this app's own write. It is removed rather than completed, and nothing
  // downstream — coverage, exceptions — is asked to move for it.
  const collected = sync.kind === "resource" && sync.requestedBy === null;
  if (collected) {
    const fresh = await getSync(principal, sync.id);
    if (
      fresh &&
      fresh.translatedFields + fresh.copiedFields + fresh.failedFields === 0
    ) {
      await deleteSync(sync.id);
      await appendEvent(principal, {
        entityType: "translation_sync",
        entityId: sync.id,
        event: "translation_sync.nothing_to_do",
        detail: { resources: fresh.doneResources },
      });
      return;
    }
  }

  await finishSync(sync.id, "completed", now);
  await recordLanguageSync(principal, targetLocales, "succeeded", now);
  await appendEvent(principal, {
    entityType: "translation_sync",
    entityId: sync.id,
    event: "translation_sync.completed",
  });
  // Failed items were raised per resource as the pages ran (noteFailures).
  // A collected sync is a handful of products from webhooks, all day long;
  // recounting the whole store after each kept a count running for ever.
  // The nightly count covers them.
  if (!collected) await requestCoverageRefresh(principal);
}

/**
 * A resource that failed in any language is one Needs attention row, named
 * and with the reason, updated while it keeps failing; once it translates
 * and no failure is remembered for it, the row closes itself
 * (docs/translations.md § Failures).
 */
async function noteFailures(
  principal: ReturnType<typeof serviceToken>,
  syncId: string,
  resourceId: string,
  outcome: ResourceOutcome,
): Promise<void> {
  const key = translationFailureKey(resourceId);
  const failed = outcome.items.filter((item) => item.status === "failed");
  const first = failed[0];
  if (first) {
    const title = first.title ?? resourceId;
    await raiseException(principal, {
      kind: "translation_failed",
      dedupeKey: key,
      message: translationFailureMessage(title, failed),
      detail: {
        syncId,
        resourceId,
        resourceType: first.resourceType,
        title,
        locales: failed.map((item) => item.locale),
      },
    });
    return;
  }
  if (outcome.translated + outcome.copied === 0) return;
  if ((await listFailures(principal, resourceId)).size > 0) return;
  await resolveExceptionByKey(
    principal,
    "translation_failed",
    key,
    "app",
    new Date(),
  );
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
