import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { replaceCoverage } from "~/adapters/db/repositories/translations.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { listShopLocales } from "~/adapters/shopify/locales";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import { scanCoverage } from "~/adapters/translations/coverage.server";
import { ALL_RESOURCE_TYPES } from "~/domain/translations/types";
import { serviceToken } from "~/domain/types";

export const translationCoverageJobSchema = z.object({
  shopDomain: z.string().min(1),
});

/**
 * Re-reads the coverage cache (docs/translations.md § Coverage): one pass
 * over every translatable resource, counting per language and type. Asked
 * for after a sync completes, from the Languages page, and nightly; throttled
 * so a busy afternoon does not scan the store ten times.
 */
export async function handleTranslationCoverage(job: Job<unknown>): Promise<void> {
  const { shopDomain } = translationCoverageJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "translation-coverage");
  const log = getLogger();

  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });
  if (!shop) return;

  const { admin } = await unauthenticated.admin(shopDomain);
  const locales = await listShopLocales(admin);
  if (locales.kind === "unavailable") {
    log.warn({ shop: shopDomain, reason: locales.reason }, "Coverage not read");
    return;
  }
  const targets = locales.locales
    .filter((locale) => !locale.primary)
    .map((locale) => locale.locale);

  const rows = await scanCoverage(
    admin,
    { types: ALL_RESOURCE_TYPES, locales: targets },
    (done) => log.debug({ shop: shopDomain, ...done }, "Coverage read"),
  );
  await replaceCoverage(principal, rows, new Date());
  log.info(
    { shop: shopDomain, locales: targets.length, rows: rows.length },
    "Translation coverage replaced",
  );
}
