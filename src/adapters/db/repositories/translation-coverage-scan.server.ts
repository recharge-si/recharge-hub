import { Prisma } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import type { CoverageRow } from "~/domain/translations/estimate";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * The coverage count as it runs (docs/translations.md § Coverage).
 *
 * One row per shop. A count is started with a fresh `runId`, every pass of
 * the chunked count moves the heartbeat and the progress, and a pass whose
 * `runId` is no longer the row's belongs to a count that was replaced and
 * stops. The counted rows themselves go to `translation_coverage` a type
 * at a time, as each type is read whole.
 */

/** A running count whose heartbeat is older than this has stopped. */
export const SCAN_STALL_MS = 15 * 60 * 1000;

export interface UnreadType {
  type: string;
  reason: string;
}

export interface CoverageScan {
  runId: string;
  status: "running" | "done" | "failed";
  typesTotal: number;
  typesDone: number;
  currentType: string | null;
  resourcesRead: number;
  expectedResources: number | null;
  unread: UnreadType[];
  error: string | null;
  startedAt: Date;
  heartbeatAt: Date;
  finishedAt: Date | null;
}

function toScan(
  row: Prisma.TranslationCoverageScanGetPayload<object>,
): CoverageScan {
  const unread = Array.isArray(row.unread)
    ? (row.unread as unknown[]).flatMap((entry) =>
        entry &&
        typeof entry === "object" &&
        "type" in entry &&
        "reason" in entry
          ? [{ type: String(entry.type), reason: String(entry.reason) }]
          : [],
      )
    : [];
  return {
    runId: row.runId,
    status:
      row.status === "done" || row.status === "failed" ? row.status : "running",
    typesTotal: row.typesTotal,
    typesDone: row.typesDone,
    currentType: row.currentType,
    resourcesRead: row.resourcesRead,
    expectedResources: row.expectedResources,
    unread,
    error: row.error,
    startedAt: row.startedAt,
    heartbeatAt: row.heartbeatAt,
    finishedAt: row.finishedAt,
  };
}

async function shopIdFor(principal: Principal): Promise<string | null> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: { id: true },
  });
  return shop?.id ?? null;
}

export async function getCoverageScan(
  principal: Principal,
): Promise<CoverageScan | null> {
  const row = await prisma.translationCoverageScan.findFirst({
    where: { shop: { domain: shopDomainOf(principal) } },
  });
  return row ? toScan(row) : null;
}

/** Whether a count is running and still moving. */
export function isScanActive(scan: CoverageScan | null, now: Date): boolean {
  return (
    scan !== null &&
    scan.status === "running" &&
    now.getTime() - scan.heartbeatAt.getTime() < SCAN_STALL_MS
  );
}

/** Starts (or restarts) the shop's count under a new run id. */
export async function startCoverageScan(
  principal: Principal,
  input: {
    runId: string;
    typesTotal: number;
    expectedResources: number | null;
  },
  now: Date,
): Promise<void> {
  const shopId = await shopIdFor(principal);
  if (!shopId) return;
  const data = {
    runId: input.runId,
    status: "running",
    typesTotal: input.typesTotal,
    typesDone: 0,
    currentType: null,
    resourcesRead: 0,
    expectedResources: input.expectedResources,
    unread: Prisma.DbNull,
    error: null,
    startedAt: now,
    heartbeatAt: now,
    finishedAt: null,
  };
  await prisma.translationCoverageScan.upsert({
    where: { shopId },
    create: { shopId, ...data },
    update: data,
  });
}

/**
 * Moves a count on. Returns false when the run is no longer the shop's
 * current one, and the caller stops.
 */
export async function recordScanProgress(
  principal: Principal,
  runId: string,
  progress: {
    typesDone: number;
    currentType: string | null;
    resourcesRead: number;
    unread: readonly UnreadType[];
  },
  now: Date,
): Promise<boolean> {
  const shopId = await shopIdFor(principal);
  if (!shopId) return false;
  const updated = await prisma.translationCoverageScan.updateMany({
    where: { shopId, runId, status: "running" },
    data: {
      typesDone: progress.typesDone,
      currentType: progress.currentType,
      resourcesRead: progress.resourcesRead,
      unread:
        progress.unread.length > 0
          ? progress.unread.map((entry) => ({
              type: entry.type,
              reason: entry.reason,
            }))
          : Prisma.DbNull,
      heartbeatAt: now,
    },
  });
  return updated.count > 0;
}

export async function finishCoverageScan(
  principal: Principal,
  runId: string,
  outcome: { status: "done" | "failed"; error: string | null },
  now: Date,
): Promise<void> {
  const shopId = await shopIdFor(principal);
  if (!shopId) return;
  await prisma.translationCoverageScan.updateMany({
    where: { shopId, runId },
    data: {
      status: outcome.status,
      error: outcome.error,
      currentType: null,
      heartbeatAt: now,
      finishedAt: now,
    },
  });
}

/**
 * Replaces one type's counted rows, for every locale, in one transaction:
 * the cache fills in type by type as a count goes, and a reader never sees
 * half a type.
 */
export async function replaceCoverageForType(
  principal: Principal,
  resourceType: string,
  rows: readonly CoverageRow[],
  readAt: Date,
): Promise<void> {
  const shopId = await shopIdFor(principal);
  if (!shopId) return;
  await prisma.$transaction([
    prisma.translationCoverage.deleteMany({ where: { shopId, resourceType } }),
    prisma.translationCoverage.createMany({
      data: rows
        .filter((row) => row.resourceType === resourceType)
        .map((row) => ({ shopId, readAt, ...row })),
    }),
  ]);
}
