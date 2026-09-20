import { createHash } from "node:crypto";

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { translateFields } from "~/adapters/ai/openai.server";
import {
  glossaryFor,
  recordOwnership,
  type OwnershipWrite,
  type SourceOverride,
  type SyncItemInput,
} from "~/adapters/db/repositories/translations.server";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  registerTranslations,
  resourceTitle,
  type TranslatableResource,
  type TranslationWrite,
} from "~/adapters/shopify/translations";
import {
  planResource,
  summarisePlan,
  type FieldDecision,
} from "~/domain/translations/plan";
import {
  RESOURCE_TYPE_LABEL,
  defaultLanguageSettings,
  type GlossaryTerm,
  type LanguageSettings,
  type OwnershipRecord,
  type ResourceType,
  type SyncMode,
} from "~/domain/translations/types";
import type { Principal } from "~/domain/types";

/**
 * Translating one resource into its target languages
 * (docs/translations.md § The engine).
 *
 * The one path every sync takes, page by page, and the editor's "translate
 * this" takes for a single resource. Per target language: plan the fields
 * (`domain/translations/plan`), ask the provider for the ones that need it,
 * write the answers to Shopify with the source digests, and record what was
 * written so the next pass knows it was this app's. Nothing is kept from the
 * resource itself once the pass is over.
 *
 * Failures are per resource and language, never per sync: a description the
 * model mangles fails that one item and the pass continues.
 */

/** SHA-256, base64url: the identity of a translation value in `translation_ownership`. */
export function hashValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export interface EngineContext {
  principal: Principal;
  admin: AdminApiContext;
  primaryLocale: string;
  storeName: string | null;
  syncId: string | null;
  mode: SyncMode;
  requestedBy: string | null;
  /** Per target locale. Missing means the defaults. */
  settings: ReadonlyMap<string, LanguageSettings>;
}

export interface ResourceOutcome {
  items: SyncItemInput[];
  translated: number;
  copied: number;
  skipped: number;
  failed: number;
}

/**
 * The glossary per language, loaded once for a pass rather than once per
 * resource.
 */
export async function loadGlossaries(
  principal: Principal,
  locales: readonly string[],
): Promise<Map<string, GlossaryTerm[]>> {
  const entries = await Promise.all(
    locales.map(async (locale) => [locale, await glossaryFor(principal, locale)] as const),
  );
  return new Map(entries);
}

export async function translateResource(
  ctx: EngineContext,
  input: {
    resource: TranslatableResource;
    resourceType: ResourceType;
    targetLocales: readonly string[];
    override: SourceOverride | null;
    ownership: readonly OwnershipRecord[];
    glossaries: ReadonlyMap<string, GlossaryTerm[]>;
  },
): Promise<ResourceOutcome> {
  const { resource, resourceType } = input;
  const title = resourceTitle(resource.fields, resource.resourceId);
  const sourceLocale = input.override?.sourceLocale ?? ctx.primaryLocale;
  const outcome: ResourceOutcome = {
    items: [],
    translated: 0,
    copied: 0,
    skipped: 0,
    failed: 0,
  };

  const perLocale = await Promise.all(
    input.targetLocales
      // Shopify does not take translations for the primary locale: its text
      // is the resource itself.
      .filter((locale) => locale !== ctx.primaryLocale)
      .map((locale) =>
        translateIntoLocale(ctx, {
          resource,
          resourceType,
          title,
          locale,
          sourceLocale,
          ownership: input.ownership,
          glossary: input.glossaries.get(locale) ?? [],
        }),
      ),
  );

  for (const result of perLocale) {
    outcome.items.push(result.item);
    outcome.translated += result.translated;
    outcome.copied += result.copied;
    outcome.skipped += result.skipped;
    outcome.failed += result.failed;
  }
  return outcome;
}

interface LocaleResult {
  item: SyncItemInput;
  translated: number;
  copied: number;
  skipped: number;
  failed: number;
}

async function translateIntoLocale(
  ctx: EngineContext,
  input: {
    resource: TranslatableResource;
    resourceType: ResourceType;
    title: string;
    locale: string;
    sourceLocale: string;
    ownership: readonly OwnershipRecord[];
    glossary: readonly GlossaryTerm[];
  },
): Promise<LocaleResult> {
  const settings =
    ctx.settings.get(input.locale) ?? defaultLanguageSettings(input.locale);
  const decisions = planResource({
    fields: input.resource.fields,
    translations: input.resource.translations.get(input.locale) ?? [],
    ownership: input.ownership,
    hash: hashValue,
    mode: ctx.mode,
    policy: settings.overwritePolicy,
    sourceLocale: input.sourceLocale,
    targetLocale: input.locale,
  });
  const summary = summarisePlan(decisions);
  const base = {
    resourceId: input.resource.resourceId,
    resourceType: input.resourceType,
    locale: input.locale,
    title: input.title,
  };
  const skippedCount = Object.values(summary.skipped).reduce((a, b) => a + b, 0);

  const toTranslate = decisions.filter(
    (d): d is Extract<FieldDecision, { kind: "translate" }> => d.kind === "translate",
  );
  const toCopy = decisions.filter(
    (d): d is Extract<FieldDecision, { kind: "copy_source" }> =>
      d.kind === "copy_source",
  );

  if (toTranslate.length === 0 && toCopy.length === 0) {
    return {
      item: {
        ...base,
        status: "skipped",
        fields: 0,
        detail: { skipped: summary.skipped },
      },
      translated: 0,
      copied: 0,
      skipped: skippedCount,
      failed: 0,
    };
  }

  // Fields Shopify gave no digest for cannot be written; they are rare
  // (an empty original) and the planner already drops empty sources.
  const writes: TranslationWrite[] = [];
  const records: OwnershipWrite[] = [];
  let translatedCount = 0;

  if (toTranslate.length > 0) {
    const answer = await translateFields(
      ctx.principal,
      {
        sourceLocale: input.sourceLocale,
        targetLocale: input.locale,
        resourceKind: RESOURCE_TYPE_LABEL[input.resourceType],
        fields: toTranslate.map((d) => d.field),
        glossary: input.glossary,
        storeName: ctx.storeName,
      },
      {
        syncId: ctx.syncId,
        resourceId: input.resource.resourceId,
        resourceType: input.resourceType,
      },
    );
    if (answer.kind === "failed") {
      getLogger().warn(
        {
          shop: ctx.principal.shopDomain,
          resourceId: input.resource.resourceId,
          locale: input.locale,
          reason: answer.message,
        },
        "Translation failed",
      );
      return {
        item: {
          ...base,
          status: "failed",
          fields: 0,
          error: answer.message,
          detail: { skipped: summary.skipped, attempted: toTranslate.length },
        },
        translated: 0,
        copied: 0,
        skipped: skippedCount,
        failed: toTranslate.length + toCopy.length,
      };
    }
    for (const decision of toTranslate) {
      const value = answer.values.get(decision.field.key);
      if (value === undefined || decision.field.digest === null) continue;
      writes.push({
        key: decision.field.key,
        locale: input.locale,
        value,
        digest: decision.field.digest,
      });
      records.push(ownershipFor(ctx, input, decision.field.key, value, decision.field.digest));
      translatedCount += 1;
    }
  }

  for (const decision of toCopy) {
    if (decision.field.digest === null) continue;
    writes.push({
      key: decision.field.key,
      locale: input.locale,
      value: decision.field.value,
      digest: decision.field.digest,
    });
    records.push(
      ownershipFor(ctx, input, decision.field.key, decision.field.value, decision.field.digest),
    );
  }

  const written = await registerTranslations(
    ctx.admin,
    input.resource.resourceId,
    writes,
  );
  if (written.kind === "rejected") {
    return {
      item: {
        ...base,
        status: "failed",
        fields: 0,
        error: `Shopify refused the translation: ${written.messages.join("; ")}`,
        detail: { skipped: summary.skipped, attempted: writes.length },
      },
      translated: 0,
      copied: 0,
      skipped: skippedCount,
      failed: writes.length,
    };
  }
  await recordOwnership(ctx.principal, records, new Date());

  const copiedCount = writes.length - translatedCount;
  return {
    item: {
      ...base,
      status: translatedCount > 0 ? "translated" : "copied",
      fields: writes.length,
      detail: {
        translated: translatedCount,
        copied: copiedCount,
        skipped: summary.skipped,
      },
    },
    translated: translatedCount,
    copied: copiedCount,
    skipped: skippedCount,
    failed: 0,
  };
}

function ownershipFor(
  ctx: EngineContext,
  input: { resource: TranslatableResource; resourceType: ResourceType; locale: string },
  key: string,
  value: string,
  digest: string,
): OwnershipWrite {
  return {
    resourceId: input.resource.resourceId,
    resourceType: input.resourceType,
    key,
    locale: input.locale,
    owner: "ai",
    valueHash: hashValue(value),
    sourceDigest: digest,
    syncId: ctx.syncId,
    writtenBy: ctx.requestedBy,
  };
}
