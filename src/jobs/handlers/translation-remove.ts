import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { clearFailure } from "~/adapters/db/repositories/translation-failures.server";
import {
  forgetOwnership,
  listOwnership,
} from "~/adapters/db/repositories/translations.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { enqueue } from "~/adapters/queue/boss.server";
import {
  QUEUES,
  translationRemoveAiKey,
  translationRemoveKey,
} from "~/adapters/queue/queues";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import {
  isLocaleCode,
  readTranslatableResources,
  removeTranslations,
} from "~/adapters/shopify/translations";
import { hashValue } from "~/adapters/translations/engine.server";
import { requestCoverageRefresh } from "~/adapters/translations/syncs.server";
import { ownerOf } from "~/domain/translations/plan";
import {
  ALL_RESOURCE_TYPES,
  isResourceType,
  type RemovalScope,
} from "~/domain/translations/types";
import { serviceToken } from "~/domain/types";

export const translationRemoveJobSchema = z.object({
  shopDomain: z.string().min(1),
  locale: z.string().refine(isLocaleCode),
  requestedBy: z.string().nullable(),
  /**
   * `null`: every translation in the language, AI and human alike (Delete
   * all translations). A list: only what the AI wrote and nobody has
   * touched since, in these types and keys (a settings change).
   */
  scope: z
    .array(
      z.object({
        type: z.string().refine(isResourceType),
        keys: z.array(z.string()).nullable(),
      }),
    )
    .nullable()
    .default(null),
  typeIndex: z.number().int().min(0).default(0),
  after: z.string().nullable().default(null),
  removed: z.number().int().min(0).default(0),
  refused: z.number().int().min(0).default(0),
});

type RemoveJob = z.infer<typeof translationRemoveJobSchema>;

/** Resources per pass; each is at most one `translationsRemove`. */
const PAGE = 50;

/**
 * Deletes translations in one language, a page of resources per pass,
 * re-enqueueing itself with its cursor in the job data like the sync does.
 *
 * Without a scope it is **Delete all translations** (docs/translations.md
 * § Delete all translations): every content type this app works with is
 * walked, whether or not it is in the language's scope, and every
 * translation goes. With a scope it is a settings change taking something
 * away (§ Switched off): only the scope's types and keys are walked, and
 * only a translation the AI wrote whose value still matches what it wrote
 * goes — a person's work, and what Shopify held before this app, stay.
 * What this app knew about a removed translation — ownership, a remembered
 * failure — goes with it.
 *
 * A resource Shopify refuses is counted and skipped, not retried for ever;
 * the event at the end says how many. A repeated page removes nothing
 * twice: what is already gone is simply not there to remove.
 */
export async function handleTranslationRemove(
  job: Job<unknown>,
): Promise<void> {
  const data = translationRemoveJobSchema.parse(job.data);
  const { shopDomain, locale } = data;
  const principal = serviceToken(shopDomain, "translation-remove");
  const log = getLogger();

  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });
  if (!shop) return;

  const steps: readonly RemovalScope[] =
    data.scope === null
      ? ALL_RESOURCE_TYPES.map((type) => ({ type, keys: null }))
      : (data.scope as RemovalScope[]);
  const step = steps[data.typeIndex];
  if (step === undefined) {
    await finish(principal, data);
    return;
  }

  const { admin } = await unauthenticated.admin(shopDomain);
  const page = await readTranslatableResources(admin, {
    type: step.type,
    first: PAGE,
    after: data.after,
    locales: [locale],
  });
  const ownership =
    data.scope === null
      ? null
      : await listOwnership(
          principal,
          page.resources.map((resource) => resource.resourceId),
        );

  let removed = data.removed;
  let refused = data.refused;
  for (const resource of page.resources) {
    const records = new Map(
      (ownership?.get(resource.resourceId) ?? [])
        .filter((record) => record.locale === locale)
        .map((record) => [record.key, record]),
    );
    const keys = (resource.translations.get(locale) ?? [])
      .filter((translation) => translation.value !== "")
      .filter(
        (translation) =>
          step.keys === null || step.keys.includes(translation.key),
      )
      .filter(
        (translation) =>
          ownership === null ||
          ownerOf(translation, records.get(translation.key), hashValue) ===
            "ai",
      )
      .map((translation) => translation.key);
    if (keys.length === 0) continue;
    const result = await removeTranslations(
      admin,
      resource.resourceId,
      [locale],
      keys,
    );
    if (result.kind === "rejected") {
      refused += 1;
      log.warn(
        {
          shop: shopDomain,
          locale,
          resourceId: resource.resourceId,
          messages: result.messages,
        },
        "Shopify refused to remove translations",
      );
      continue;
    }
    removed += keys.length;
    await forgetOwnership(principal, resource.resourceId, locale, keys);
    await clearFailure(principal, resource.resourceId, locale);
  }

  const next =
    page.hasNextPage && page.endCursor
      ? { typeIndex: data.typeIndex, after: page.endCursor }
      : { typeIndex: data.typeIndex + 1, after: null };
  const following = { ...data, ...next, removed, refused };
  if (next.typeIndex >= steps.length) {
    await finish(principal, following);
    return;
  }
  await enqueue(QUEUES.translationRemove, following, {
    singletonKey:
      data.scope === null
        ? translationRemoveKey(shopDomain, locale)
        : translationRemoveAiKey(shopDomain, locale, data.scope),
  });
}

async function finish(
  principal: ReturnType<typeof serviceToken>,
  data: RemoveJob,
): Promise<void> {
  await appendEvent(principal, {
    entityType: "translation_language",
    entityId: data.locale,
    event:
      data.scope === null
        ? "translation_language.translations_removed"
        : "translation_language.ai_translations_removed",
    detail: {
      by: data.requestedBy,
      removed: data.removed,
      refused: data.refused,
      ...(data.scope === null ? {} : { scope: data.scope }),
    },
  });
  getLogger().info(
    {
      shop: data.shopDomain,
      locale: data.locale,
      removed: data.removed,
      refused: data.refused,
    },
    "Translations removed",
  );
  await requestCoverageRefresh(principal);
}
