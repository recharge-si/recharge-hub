import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import {
  finishCoverageScan,
  getCoverageScan,
  recordScanProgress,
  replaceCoverageForType,
} from "~/adapters/db/repositories/translation-coverage-scan.server";
import { listLanguageSettings } from "~/adapters/db/repositories/translations.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES, translationCoverageKey } from "~/adapters/queue/queues";
import { listShopLocales } from "~/adapters/shopify/locales";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import {
  describeUnread,
  readCoverageChunk,
} from "~/adapters/translations/coverage.server";
import {
  ALL_RESOURCE_TYPES,
  isResourceType,
} from "~/domain/translations/types";
import { serviceToken } from "~/domain/types";

const rowSchema = z.object({
  locale: z.string(),
  resourceType: z.string(),
  resources: z.number(),
  fields: z.number(),
  translated: z.number(),
  outdated: z.number(),
  missing: z.number(),
  missingChars: z.number(),
  outdatedChars: z.number(),
});

export const translationCoverageJobSchema = z.object({
  shopDomain: z.string().min(1),
  /** Absent on a job queued before counts ran in chunks; it is dropped. */
  runId: z.string().optional(),
  typeIndex: z.number().int().min(0).default(0),
  after: z.string().nullable().default(null),
  /** The current type's counts so far, carried from pass to pass. */
  carried: z.array(rowSchema).default([]),
  resourcesRead: z.number().int().min(0).default(0),
  unread: z
    .array(z.object({ type: z.string(), reason: z.string() }))
    .default([]),
});

/** Pages of `PAGE` resources per pass: a few hundred resources, well inside the job's expiry. */
const PAGES_PER_PASS = 10;
const PAGE = 50;

/**
 * One pass of the coverage count (docs/translations.md § Coverage).
 *
 * A count walks every translatable type a few pages at a time, re-enqueueing
 * itself with its cursor and the current type's counts so far in the job
 * data, the way a sync pages. A type read whole replaces its rows in the
 * cache at once, so the Languages page fills in as the count goes; every
 * pass moves the progress on `translation_coverage_scan`, which is what the
 * pages show. A type Shopify refuses is noted and skipped — it costs that
 * type, not the count — and the count still ends. A pass of a count that has
 * since been replaced (a new run id) stops without writing.
 */
export async function handleTranslationCoverage(
  job: Job<unknown>,
): Promise<void> {
  const data = translationCoverageJobSchema.parse(job.data);
  const { shopDomain, runId } = data;
  if (!runId) return;
  const principal = serviceToken(shopDomain, "translation-coverage");
  const log = getLogger();

  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });
  if (!shop) return;
  const scan = await getCoverageScan(principal);
  if (!scan || scan.runId !== runId || scan.status !== "running") return;

  const types = ALL_RESOURCE_TYPES;
  const type = types[data.typeIndex];
  if (type === undefined || !isResourceType(type)) {
    await finish(principal, runId, data.unread, types.length);
    return;
  }

  const { admin } = await unauthenticated.admin(shopDomain);
  const locales = await listShopLocales(admin);
  if (locales.kind === "unavailable") {
    // Retried by the queue; a count that keeps failing stops and says why.
    throw new Error(
      `The store's languages could not be read. ${locales.reason}`,
    );
  }
  const targets = locales.locales
    .filter((locale) => !locale.primary)
    .map((locale) => locale.locale);
  if (targets.length === 0) {
    await finish(principal, runId, [], types.length);
    return;
  }
  const settings = await listLanguageSettings(principal);

  let next = {
    typeIndex: data.typeIndex,
    after: data.after,
    carried: data.carried,
  };
  let read = 0;
  const unread = [...data.unread];
  try {
    const chunk = await readCoverageChunk(admin, {
      type,
      after: data.after,
      locales: targets,
      carried: data.carried,
      keepOriginal: new Map(
        settings.map((row) => [row.locale, row.keepOriginal]),
      ),
      maxPages: PAGES_PER_PASS,
      pageSize: PAGE,
    });
    read = chunk.read;
    if (chunk.done) {
      await replaceCoverageForType(principal, type, chunk.rows, new Date());
      next = { typeIndex: data.typeIndex + 1, after: null, carried: [] };
    } else {
      next = {
        typeIndex: data.typeIndex,
        after: chunk.after,
        carried: chunk.rows,
      };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn({ shop: shopDomain, type, reason }, "Coverage type not read");
    unread.push({ type, reason });
    next = { typeIndex: data.typeIndex + 1, after: null, carried: [] };
  }

  const resourcesRead = data.resourcesRead + read;
  const moving = await recordScanProgress(
    principal,
    runId,
    {
      typesDone: next.typeIndex,
      currentType: types[next.typeIndex] ?? null,
      resourcesRead,
      unread,
    },
    new Date(),
  );
  if (!moving) return;

  if (next.typeIndex >= types.length) {
    await finish(principal, runId, unread, types.length);
    log.info(
      {
        shop: shopDomain,
        locales: targets.length,
        resources: resourcesRead,
        unread: unread.map((u) => u.type),
      },
      "Translation coverage counted",
    );
    return;
  }
  await enqueue(
    QUEUES.translationCoverage,
    { shopDomain, runId, ...next, resourcesRead, unread },
    { singletonKey: `${translationCoverageKey(shopDomain)}:${runId}` },
  );
}

async function finish(
  principal: ReturnType<typeof serviceToken>,
  runId: string,
  unread: ReadonlyArray<{ type: string; reason: string }>,
  typesTotal: number,
): Promise<void> {
  const nothing = unread.length > 0 && unread.length >= typesTotal;
  await finishCoverageScan(
    principal,
    runId,
    {
      status: nothing ? "failed" : "done",
      error:
        unread.length > 0
          ? `${nothing ? "Nothing" : "Some content"} could not be read from Shopify. ${describeUnread(
              unread.flatMap((entry) =>
                isResourceType(entry.type)
                  ? [{ type: entry.type, reason: entry.reason }]
                  : [],
              ),
            )}`
          : null,
    },
    new Date(),
  );
}
