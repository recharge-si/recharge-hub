import type { Job } from "pg-boss";

import { isConfigured } from "~/adapters/ai/openai.server";
import { prisma } from "~/adapters/db/client.server";
import { listLanguageSettings } from "~/adapters/db/repositories/translations.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { webhookJobSchema } from "~/adapters/shopify/compliance-payloads";
import { listShopLocales } from "~/adapters/shopify/locales";
import {
  normaliseTopic,
  parseProductDelete,
} from "~/adapters/shopify/product-payload";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import { translateResourceNow } from "~/adapters/translations/inline.server";
import type { SyncMode } from "~/domain/translations/types";
import { serviceToken } from "~/domain/types";

/**
 * A product was created or changed in Shopify (docs/translations.md
 * § Automatic translation).
 *
 * For every language with automatic translation on, the product's missing
 * fields are translated now — and its outdated ones too, where the language
 * asks for that — as a `resource` sync so it shows on the syncs page and its
 * usage is accounted for like any other. A language's overwrite policy
 * applies unchanged: an edit a person made is never replaced from here.
 *
 * Deletes are ignored; Shopify removes the translations with the product.
 * Collections, pages and articles have no webhook here and are picked up by
 * the nightly automatic sync instead.
 */
export async function handleTranslationResourceEvent(
  job: Job<unknown>,
): Promise<void> {
  const { shopDomain, topic, payload } = webhookJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "translation-resource-event");
  const log = getLogger();

  if (normaliseTopic(topic) === "products/delete") return;
  if (!isConfigured()) return;

  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });
  if (!shop) return;

  const automatic = (await listLanguageSettings(principal)).filter(
    (language) =>
      language.aiEnabled &&
      language.autoTranslateNew &&
      language.contentScope.includes("products"),
  );
  if (automatic.length === 0) return;

  // Only the id is needed from the payload; the content is read back from
  // Shopify with its digests, which the webhook does not carry.
  const { productId } = parseProductDelete(payload);

  const { admin } = await unauthenticated.admin(shopDomain);
  const locales = await listShopLocales(admin);
  if (locales.kind === "unavailable") {
    log.warn({ shop: shopDomain, reason: locales.reason }, "Locales not read");
    return;
  }
  const primary = locales.locales.find((locale) => locale.primary);
  if (!primary) return;
  const enabled = new Set(locales.locales.map((locale) => locale.locale));

  // One pass per mode: a language that wants outdated translations refreshed
  // and one that does not cannot share a plan.
  const byMode = new Map<SyncMode, string[]>();
  for (const language of automatic) {
    if (!enabled.has(language.locale) || language.locale === primary.locale)
      continue;
    const mode: SyncMode = language.autoUpdateOutdated
      ? "missing_outdated"
      : "missing";
    byMode.set(mode, [...(byMode.get(mode) ?? []), language.locale]);
  }

  for (const [mode, targetLocales] of byMode) {
    const result = await translateResourceNow(principal, admin, {
      resourceId: productId,
      resourceType: "PRODUCT",
      primaryLocale: primary.locale,
      targetLocales,
      mode,
      requestedBy: null,
    });
    log.info(
      {
        shop: shopDomain,
        productId,
        mode,
        syncId: result.syncId,
        ...counts(result),
      },
      "Product translated from webhook",
    );
  }
}

function counts(result: Awaited<ReturnType<typeof translateResourceNow>>) {
  const { translated, copied, skipped, failed } = result.outcome;
  return { translated, copied, skipped, failed };
}
