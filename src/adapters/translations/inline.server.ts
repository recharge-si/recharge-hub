import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  advanceSync,
  beginSyncPass,
  createSync,
  finishSync,
  listLanguageSettings,
  listOwnership,
  listSourceOverrides,
  recordLanguageSync,
  recordSyncItems,
  setSyncTotal,
} from "~/adapters/db/repositories/translations.server";
import {
  readShopName,
  readTranslatableResourcesByIds,
} from "~/adapters/shopify/translations";
import {
  loadGlossaries,
  translateResource,
  type EngineContext,
  type ResourceOutcome,
} from "~/adapters/translations/engine.server";
import { loadIntelligence } from "~/adapters/translations/intelligence.server";
import type { ResourceType, SyncMode } from "~/domain/translations/types";
import type { Principal } from "~/domain/types";

/**
 * One resource, translated now, recorded as a `resource` sync
 * (docs/translations.md § Jobs). What the editor's "Translate" button and
 * the product webhook both do: the work is small enough to run inline, and
 * recording it as a sync is what keeps every provider request attributed
 * and every outcome visible on the syncs page.
 */
export interface InlineResult {
  syncId: string;
  outcome: ResourceOutcome;
  /** Null when the resource could not be read from Shopify. */
  found: boolean;
}

export async function translateResourceNow(
  principal: Principal,
  admin: AdminApiContext,
  input: {
    resourceId: string;
    resourceType: ResourceType;
    primaryLocale: string;
    targetLocales: string[];
    mode: SyncMode;
    requestedBy: string | null;
  },
): Promise<InlineResult> {
  const now = new Date();
  const [languages, overrides, ownership, glossaries, storeName, resources] =
    await Promise.all([
      listLanguageSettings(principal),
      listSourceOverrides(principal, [input.resourceId]),
      listOwnership(principal, [input.resourceId]),
      loadGlossaries(principal, input.targetLocales),
      readShopName(admin),
      readTranslatableResourcesByIds(admin, {
        ids: [input.resourceId],
        locales: input.targetLocales,
      }),
    ]);
  const override = overrides.get(input.resourceId) ?? null;

  const sync = await createSync(principal, {
    kind: "resource",
    mode: input.mode,
    sourceLocale: override?.sourceLocale ?? input.primaryLocale,
    targetLocales: input.targetLocales,
    resourceTypes: [input.resourceType],
    resourceIds: [input.resourceId],
    requestedBy: input.requestedBy,
  });
  await beginSyncPass(principal, sync.id, now);
  await setSyncTotal(sync.id, 1);

  const resource = resources[0];
  if (!resource) {
    await finishSync(
      sync.id,
      "failed",
      new Date(),
      "The resource could not be read from Shopify.",
    );
    return {
      syncId: sync.id,
      found: false,
      outcome: { items: [], translated: 0, copied: 0, skipped: 0, failed: 0 },
    };
  }

  const intelligence = await loadIntelligence(principal, admin, {
    primaryLocale: input.primaryLocale,
    storeName,
  });
  await intelligence.contexts.prime([
    { resourceId: input.resourceId, type: input.resourceType },
  ]);
  const ctx: EngineContext = {
    principal,
    admin,
    primaryLocale: input.primaryLocale,
    storeName,
    syncId: sync.id,
    mode: input.mode,
    requestedBy: input.requestedBy,
    settings: new Map(languages.map((language) => [language.locale, language])),
    intelligence,
  };
  const outcome = await translateResource(ctx, {
    resource,
    resourceType: input.resourceType,
    targetLocales: input.targetLocales,
    override,
    ownership: ownership.get(input.resourceId) ?? [],
    glossaries,
  });
  await recordSyncItems(principal, sync.id, outcome.items);
  await advanceSync(
    sync.id,
    { typeIndex: 1, after: null },
    {
      resources: 1,
      translated: outcome.translated,
      copied: outcome.copied,
      skipped: outcome.skipped,
      failed: outcome.failed,
    },
  );
  const finished = new Date();
  if (outcome.failed > 0) {
    await finishSync(
      sync.id,
      "failed",
      finished,
      outcome.items.find((item) => item.error)?.error ??
        "Some fields could not be translated.",
    );
  } else {
    await finishSync(sync.id, "completed", finished);
    await recordLanguageSync(
      principal,
      input.targetLocales,
      "succeeded",
      finished,
    );
  }
  return { syncId: sync.id, found: true, outcome };
}
