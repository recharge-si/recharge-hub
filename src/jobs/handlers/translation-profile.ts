import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { listShopLocales } from "~/adapters/shopify/locales";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import { ensureStoreProfile } from "~/adapters/translations/profile.server";
import { serviceToken } from "~/domain/types";

export const translationProfileJobSchema = z.object({
  shopDomain: z.string().min(1),
});

/**
 * Rebuilds the store profile on request (docs/translations.md § Store
 * profile): the merchant pressed Regenerate on the Store context page, or
 * the profile was never built and a page asked for it. The sync passes
 * keep the profile current on their own; this is the explicit path.
 */
export async function handleTranslationProfile(job: Job<unknown>): Promise<void> {
  const { shopDomain } = translationProfileJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "translation-profile");
  const log = getLogger();

  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });
  if (!shop) return;

  const { admin } = await unauthenticated.admin(shopDomain);
  const locales = await listShopLocales(admin);
  if (locales.kind === "unavailable") {
    log.warn({ shop: shopDomain, reason: locales.reason }, "Store profile not rebuilt");
    return;
  }
  const primary = locales.locales.find((locale) => locale.primary);
  if (!primary) return;

  const outcome = await ensureStoreProfile(principal, admin, {
    primaryLocale: primary.locale,
    force: true,
  });
  log.info({ shop: shopDomain, outcome: outcome.kind }, "Store profile rebuild finished");
}
