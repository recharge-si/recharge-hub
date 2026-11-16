import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { raiseException } from "~/adapters/db/repositories/exception.server";
import { listFailures } from "~/adapters/db/repositories/translation-failures.server";
import { listSyncItems } from "~/adapters/db/repositories/translations.server";
import {
  translationFailureKey,
  translationFailureMessage,
} from "~/domain/translations/failure-notice";
import type { Principal } from "~/domain/types";

/**
 * Rewrites the Needs attention rows raised before failures were named per
 * resource (docs/translations.md § Failures).
 *
 * Those were one row per sync — "1 fields could not be translated in a
 * sync" — and collected webhook syncs made them by the thousand. Each is
 * replaced by one row per resource that still fails, with its name,
 * languages and reason, and closed; a resource that has translated since
 * (no failure remembered) gets no row. Rows are taken oldest first, so a
 * resource named by several syncs ends with the newest reason.
 *
 * Runs from the quarter-hourly `recheck-exceptions` in batches; once none
 * are left it is one cheap query.
 */

const legacyDetailSchema = z.object({
  syncId: z.string().min(1),
  failedFields: z.number(),
});

export async function convertLegacyTranslationExceptions(
  principal: Principal,
  limit: number,
): Promise<number> {
  const rows = await prisma.exception.findMany({
    where: {
      shop: { domain: principal.shopDomain },
      kind: "translation_failed",
      status: "open",
      dedupeKey: { startsWith: "translation-sync:" },
    },
    select: { id: true, detail: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let converted = 0;
  for (const row of rows) {
    // A sync that could not run at all keeps its own row; only the
    // "fields could not be translated" count is rewritten.
    const detail = legacyDetailSchema.safeParse(row.detail);
    if (!detail.success) continue;
    const { syncId } = detail.data;

    const failed = await listSyncItems(principal, syncId, { status: "failed" });
    const byResource = new Map<string, typeof failed>();
    for (const item of failed)
      byResource.set(item.resourceId, [
        ...(byResource.get(item.resourceId) ?? []),
        item,
      ]);

    for (const [resourceId, items] of byResource) {
      if ((await listFailures(principal, resourceId)).size === 0) continue;
      const first = items[0];
      if (!first) continue;
      const title = first.title ?? resourceId;
      await raiseException(principal, {
        kind: "translation_failed",
        dedupeKey: translationFailureKey(resourceId),
        message: translationFailureMessage(title, items),
        detail: {
          syncId,
          resourceId,
          resourceType: first.resourceType,
          title,
          locales: items.map((item) => item.locale),
        },
      });
    }

    await prisma.exception.updateMany({
      where: { id: row.id, status: "open" },
      data: { status: "resolved", resolvedBy: "app", resolvedAt: new Date() },
    });
    converted += 1;
  }
  return converted;
}
