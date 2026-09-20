import type { Prisma } from "@prisma/client";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  createSync,
  recordLanguageSync,
  type Sync,
} from "~/adapters/db/repositories/translations.server";
import { enqueue, enqueueThrottled } from "~/adapters/queue/boss.server";
import {
  QUEUES,
  translationCoverageKey,
  translationProfileKey,
  translationSyncKey,
} from "~/adapters/queue/queues";
import type { ResourceType, SyncMode } from "~/domain/translations/types";
import type { Principal } from "~/domain/types";

/**
 * Starting work (docs/translations.md § Jobs). Shared by the pages and the
 * nightly tick so a sync is created and queued in one way.
 */

export interface StartSyncInput {
  kind: "translate_store" | "language" | "automatic" | "resource";
  mode: SyncMode;
  sourceLocale: string;
  targetLocales: string[];
  resourceTypes: ResourceType[];
  resourceIds?: string[];
  estimate?: Prisma.InputJsonValue | null;
  requestedBy: string | null;
}

export async function startSync(
  principal: Principal,
  input: StartSyncInput,
): Promise<Sync> {
  const sync = await createSync(principal, input);
  await recordLanguageSync(principal, input.targetLocales, "started", new Date());
  await enqueue(
    QUEUES.translationSync,
    { shopDomain: principal.shopDomain, syncId: sync.id },
    { singletonKey: translationSyncKey(sync.id) },
  );
  await appendEvent(principal, {
    entityType: "translation_sync",
    entityId: sync.id,
    event: "translation_sync.started",
    detail: {
      kind: input.kind,
      mode: input.mode,
      targetLocales: input.targetLocales,
      resourceTypes: input.resourceTypes,
      resources: input.resourceIds?.length ?? null,
      by: input.requestedBy,
    },
  });
  return sync;
}

/** Asks for the coverage cache to be re-read; null when one is already pending. */
export async function requestCoverageRefresh(
  principal: Principal,
  windowSeconds = 300,
): Promise<string | null> {
  return enqueueThrottled(
    QUEUES.translationCoverage,
    { shopDomain: principal.shopDomain },
    translationCoverageKey(principal.shopDomain),
    windowSeconds,
  );
}

/**
 * Asks for the store profile to be rebuilt from a fresh read of the store
 * (docs/translations.md § Store profile); null when a rebuild is already
 * waiting.
 */
export async function requestProfileRebuild(principal: Principal): Promise<string | null> {
  return enqueueThrottled(
    QUEUES.translationProfile,
    { shopDomain: principal.shopDomain },
    translationProfileKey(principal.shopDomain),
    60,
  );
}
