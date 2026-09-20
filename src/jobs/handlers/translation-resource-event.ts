import type { Job } from "pg-boss";

import { isConfigured } from "~/adapters/ai/openai.server";
import { prisma } from "~/adapters/db/client.server";
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
import { getLogger } from "~/adapters/observability/logger.server";
import { webhookJobSchema } from "~/adapters/shopify/compliance-payloads";
import { listShopLocales } from "~/adapters/shopify/locales";
import {
  normaliseTopic,
  parseProductDelete,
} from "~/adapters/shopify/product-payload";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import {
  readShopName,
  readTranslatableResourcesByIds,
} from "~/adapters/shopify/translations";
import {
  loadGlossaries,
  translateResource,
  type EngineContext,
} from "~/adapters/translations/engine.server";
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

  const languages = await listLanguageSettings(principal);
  const automatic = languages.filter(
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
  if (byMode.size === 0) return;
  const allTargets = [...new Set([...byMode.values()].flat())];

  const [storeName, resources, overrides, ownership, glossaries] =
    await Promise.all([
      readShopName(admin),
      readTranslatableResourcesByIds(admin, {
        ids: [productId],
        locales: allTargets,
      }),
      listSourceOverrides(principal, [productId]),
      listOwnership(principal, [productId]),
      loadGlossaries(principal, allTargets),
    ]);
  const resource = resources[0];
  if (!resource) return;

  for (const [mode, targetLocales] of byMode) {
    // Recorded as a sync so the work is visible and its usage attributed,
    // but run inline: it is one resource, and the queue already waited.
    const now = new Date();
    const sync = await createSync(principal, {
      kind: "resource",
      mode,
      sourceLocale: overrides.get(productId)?.sourceLocale ?? primary.locale,
      targetLocales,
      resourceTypes: ["PRODUCT"],
      resourceIds: [productId],
      requestedBy: null,
    });
    await beginSyncPass(principal, sync.id, now);
    await setSyncTotal(sync.id, 1);

    const ctx: EngineContext = {
      principal,
      admin,
      primaryLocale: primary.locale,
      storeName,
      syncId: sync.id,
      mode,
      requestedBy: null,
      settings: new Map(languages.map((language) => [language.locale, language])),
    };
    const outcome = await translateResource(ctx, {
      resource,
      resourceType: "PRODUCT",
      targetLocales,
      override: overrides.get(productId) ?? null,
      ownership: ownership.get(productId) ?? [],
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
        "Some fields could not be translated.",
      );
    } else {
      await finishSync(sync.id, "completed", finished);
      await recordLanguageSync(principal, targetLocales, "succeeded", finished);
    }
  }
}
