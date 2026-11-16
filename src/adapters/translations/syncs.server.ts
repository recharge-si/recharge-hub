import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  getCoverageScan,
  isScanActive,
  startCoverageScan,
  type CoverageScan,
} from "~/adapters/db/repositories/translation-coverage-scan.server";
import {
  appendToCollectingSync,
  createSync,
  getCoverage,
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
import {
  ALL_RESOURCE_TYPES,
  RESOURCE_TYPE_LABEL,
  isResourceType,
  type ResourceType,
  type SyncMode,
} from "~/domain/translations/types";
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
  await recordLanguageSync(
    principal,
    input.targetLocales,
    "started",
    new Date(),
  );
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

/**
 * How long changed resources are collected before one sync translates them
 * together (docs/translations.md § Automatic translation). Shopify sends one
 * webhook per product, and a CSV import or a bulk edit sends hundreds in a
 * minute; one sync per webhook would be a syncs page nobody can read.
 */
export const COLLECT_WINDOW_SECONDS = 120;

/**
 * Puts a resource Shopify says has changed on the sync that is collecting
 * changes for these languages and mode, opening one when there is none.
 * The sync runs `COLLECT_WINDOW_SECONDS` after it was opened; the job is
 * sent once per sync (its singleton key), so every later call in the window
 * only lengthens the list. A sync that has started is not added to — the
 * next change opens the next one.
 */
export async function collectChangedResource(
  principal: Principal,
  input: {
    resourceId: string;
    resourceType: ResourceType;
    sourceLocale: string;
    targetLocales: string[];
    mode: SyncMode;
  },
): Promise<{ sync: Sync; opened: boolean; added: boolean }> {
  const appended = await appendToCollectingSync(principal, input);
  if (appended) return { ...appended, opened: false };

  const sync = await createSync(principal, {
    kind: "resource",
    mode: input.mode,
    sourceLocale: input.sourceLocale,
    targetLocales: input.targetLocales,
    resourceTypes: [input.resourceType],
    resourceIds: [input.resourceId],
    requestedBy: null,
  });
  await recordLanguageSync(
    principal,
    input.targetLocales,
    "started",
    new Date(),
  );
  await enqueue(
    QUEUES.translationSync,
    { shopDomain: principal.shopDomain, syncId: sync.id },
    {
      singletonKey: translationSyncKey(sync.id),
      startAfterSeconds: COLLECT_WINDOW_SECONDS,
    },
  );
  await appendEvent(principal, {
    entityType: "translation_sync",
    entityId: sync.id,
    event: "translation_sync.started",
    detail: {
      kind: "resource",
      mode: input.mode,
      targetLocales: input.targetLocales,
      resourceTypes: [input.resourceType],
      resources: 1,
      by: null,
      collecting: COLLECT_WINDOW_SECONDS,
    },
  });
  return { sync, opened: true, added: true };
}

/**
 * Starts a coverage count (docs/translations.md § Coverage) and returns its
 * run id, or null when one is already running and still moving — a count
 * asked for while another runs would only restart it, and the one running
 * sees most of what changed. A count that stopped (no pass for
 * `SCAN_STALL_MS`) is replaced.
 */
export async function requestCoverageRefresh(
  principal: Principal,
): Promise<string | null> {
  const now = new Date();
  const scan = await getCoverageScan(principal);
  if (isScanActive(scan, now)) return null;

  // What the last count saw per type, as the denominator of a percentage.
  const coverage = await getCoverage(principal);
  const perType = new Map<string, number>();
  for (const row of coverage.rows)
    perType.set(
      row.resourceType,
      Math.max(perType.get(row.resourceType) ?? 0, row.resources),
    );
  const expected = [...perType.values()].reduce((a, b) => a + b, 0);

  const runId = randomUUID();
  await startCoverageScan(
    principal,
    {
      runId,
      typesTotal: ALL_RESOURCE_TYPES.length,
      expectedResources: expected > 0 ? expected : null,
    },
    now,
  );
  await enqueue(
    QUEUES.translationCoverage,
    { shopDomain: principal.shopDomain, runId },
    {
      singletonKey: `${translationCoverageKey(principal.shopDomain)}:${runId}`,
    },
  );
  return runId;
}

/**
 * Where the coverage count stands, for a page: counting (with how far),
 * stopped, finished with content Shopify would not read, or nothing to say.
 * Serialisable, so loaders hand it over as is.
 */
export interface CoverageProgress {
  state: "idle" | "counting" | "stalled" | "problem";
  /** 0–100 while counting: resources against the last count's, or types when there was none. */
  percent: number | null;
  typesDone: number;
  typesTotal: number;
  /** What is being read now, as the merchant calls it. */
  reading: string | null;
  resourcesRead: number;
  expectedResources: number | null;
  startedAt: string | null;
  /** Why it stopped or what could not be read. */
  message: string | null;
}

export function describeCoverageScan(
  scan: CoverageScan | null,
  now: Date,
): CoverageProgress {
  const base = {
    percent: null,
    typesDone: scan?.typesDone ?? 0,
    typesTotal: scan?.typesTotal ?? ALL_RESOURCE_TYPES.length,
    reading: null,
    resourcesRead: scan?.resourcesRead ?? 0,
    expectedResources: scan?.expectedResources ?? null,
    startedAt: scan?.startedAt.toISOString() ?? null,
    message: null,
  };
  if (!scan) return { state: "idle", ...base };
  if (scan.status === "running") {
    const label =
      scan.currentType && isResourceType(scan.currentType)
        ? RESOURCE_TYPE_LABEL[scan.currentType]
        : null;
    if (!isScanActive(scan, now))
      return {
        state: "stalled",
        ...base,
        reading: label,
        message: `The count stopped${label ? ` while reading ${label.toLowerCase()}s` : ""} after ${scan.resourcesRead.toLocaleString("en")} resources. Count again to start over.`,
      };
    const byResources =
      scan.expectedResources && scan.expectedResources > 0
        ? (scan.resourcesRead / scan.expectedResources) * 100
        : null;
    const byTypes =
      scan.typesTotal > 0 ? (scan.typesDone / scan.typesTotal) * 100 : 0;
    return {
      state: "counting",
      ...base,
      reading: label,
      percent: Math.max(0, Math.min(99, Math.floor(byResources ?? byTypes))),
    };
  }
  if (scan.error) return { state: "problem", ...base, message: scan.error };
  return { state: "idle", ...base };
}

export async function coverageProgress(
  principal: Principal,
): Promise<CoverageProgress> {
  return describeCoverageScan(await getCoverageScan(principal), new Date());
}

/**
 * Asks for the store profile to be rebuilt from a fresh read of the store
 * (docs/translations.md § Store profile); null when a rebuild is already
 * waiting.
 */
export async function requestProfileRebuild(
  principal: Principal,
): Promise<string | null> {
  return enqueueThrottled(
    QUEUES.translationProfile,
    { shopDomain: principal.shopDomain },
    translationProfileKey(principal.shopDomain),
    60,
  );
}
