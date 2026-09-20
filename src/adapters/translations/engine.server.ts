import { createHash } from "node:crypto";

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { correctFields, translateFields, type TranslateOutcome } from "~/adapters/ai/openai.server";
import type { StoredMemory } from "~/adapters/db/repositories/translation-intelligence.server";
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
import type { Intelligence } from "~/adapters/translations/intelligence.server";
import {
  memorablePairs,
  memoryKey,
  reuseVerdict,
  selectMemoryHints,
  type MemoryHint,
} from "~/domain/translations/memory";
import {
  planResource,
  summarisePlan,
  type FieldDecision,
} from "~/domain/translations/plan";
import {
  TRANSLATION_PROMPT_VERSION,
  type TerminologyNote,
  type TranslationRequest,
} from "~/domain/translations/prompt";
import { resolveSourceLocale, type SourceResolution } from "~/domain/translations/source";
import {
  FORM_STABLE_CLASSIFICATIONS,
  relevantTerms,
  type StoredTerm,
} from "~/domain/translations/terminology";
import { normaliseTerm } from "~/domain/translations/text";
import {
  RESOURCE_TYPE_LABEL,
  defaultLanguageSettings,
  type GlossaryTerm,
  type LanguageSettings,
  type OwnershipRecord,
  type ResourceType,
  type SourceField,
  type SyncMode,
  type TranslationTrace,
} from "~/domain/translations/types";
import {
  describeViolations,
  hardViolations,
  validateTranslation,
  type Violation,
} from "~/domain/translations/validate";
import type { Principal } from "~/domain/types";

/**
 * Translating one resource into its target languages
 * (docs/translations.md § The engine).
 *
 * The one path every sync takes, page by page, and the editor's "translate
 * this" takes for a single resource. Per target language: decide the
 * source locale, plan the fields (`domain/translations/plan`), answer what
 * translation memory can answer, ask the provider once for the rest with
 * the store, the resource and the terminology in view, check the answer
 * against the invariants a translation never breaks (and ask once more if
 * it broke one), write to Shopify with the source digests, record what was
 * written so the next pass knows it was this app's, and let memory learn
 * what was said. Nothing is kept from the resource itself once the pass is
 * over except the short strings memory keeps.
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
  intelligence: Intelligence;
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
  const source = resolveSourceLocale({
    primaryLocale: ctx.primaryLocale,
    shopifyContentLocale: resource.sourceLocale,
    override: input.override?.sourceLocale ?? null,
    detected: input.override?.detectedLocale ?? null,
  });
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
          source,
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

interface LocaleInput {
  resource: TranslatableResource;
  resourceType: ResourceType;
  title: string;
  locale: string;
  source: SourceResolution;
  ownership: readonly OwnershipRecord[];
  glossary: readonly GlossaryTerm[];
}

async function translateIntoLocale(ctx: EngineContext, input: LocaleInput): Promise<LocaleResult> {
  const settings =
    ctx.settings.get(input.locale) ?? defaultLanguageSettings(input.locale);
  const decisions = planResource({
    fields: input.resource.fields,
    translations: input.resource.translations.get(input.locale) ?? [],
    ownership: input.ownership,
    hash: hashValue,
    mode: ctx.mode,
    policy: settings.overwritePolicy,
    sourceLocale: input.source.locale,
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
  let trace: TranslationTrace | null = null;
  let learned: Array<{ sourceText: string; targetText: string }> = [];

  if (toTranslate.length > 0) {
    const answer = await answerFields(ctx, input, toTranslate.map((d) => d.field));
    trace = answer.trace;
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
          trace: answer.trace,
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
    learned = answer.learned;
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
        trace,
      },
      translated: 0,
      copied: 0,
      skipped: skippedCount,
      failed: writes.length,
    };
  }
  await recordOwnership(ctx.principal, records, new Date());
  if (learned.length > 0)
    await ctx.intelligence.remember(
      {
        sourceLocale: input.source.locale,
        targetLocale: input.locale,
        resourceType: input.resourceType,
        resourceId: input.resource.resourceId,
        pairs: learned,
      },
      "ai",
    );

  const copiedCount = writes.length - translatedCount;
  return {
    item: {
      ...base,
      status: translatedCount > 0 ? "translated" : "copied",
      fields: writes.length,
      detail: {
        translated: translatedCount,
        copied: copiedCount,
        reused: trace?.reusedKeys.length ?? 0,
        skipped: summary.skipped,
      },
      trace,
    },
    translated: translatedCount,
    copied: copiedCount,
    skipped: skippedCount,
    failed: 0,
  };
}

type FieldsAnswer =
  | {
      kind: "ok";
      values: Map<string, string>;
      trace: TranslationTrace;
      /** Pairs the model produced (never the reused ones), for memory. */
      learned: Array<{ sourceText: string; targetText: string }>;
    }
  | { kind: "failed"; message: string; trace: TranslationTrace };

/** Provider requests per item: the translation and at most one correction. */
const MAX_ATTEMPTS = 2;

/**
 * The fields of one resource in one language: memory first, then one
 * provider request for the rest, validated, corrected once if it broke an
 * invariant, and refused if it still does.
 */
async function answerFields(
  ctx: EngineContext,
  input: LocaleInput,
  fields: readonly SourceField[],
): Promise<FieldsAnswer> {
  const intelligence = ctx.intelligence;
  const [terms, memory, context] = await Promise.all([
    intelligence.termsFor(input.source.locale),
    intelligence.memoryFor(input.source.locale, input.locale, fields),
    intelligence.contexts.contextFor(input.resource.resourceId, input.resourceType, input.title),
  ]);
  const relevant = relevantTerms(fields, terms);
  const trace: TranslationTrace = {
    promptVersion: TRANSLATION_PROMPT_VERSION,
    profileVersion: intelligence.profileVersion,
    sourceLocale: input.source.locale,
    sourceReason: input.source.reason,
    sourceDisputedBy: input.source.disputedBy,
    targetLocale: input.locale,
    contextKind: context.kind,
    model: null,
    attempts: 0,
    reusedKeys: [],
    memoryHitIds: [],
    glossaryHits: input.glossary.filter((term) =>
      fields.some((field) => normaliseTerm(field.value).includes(normaliseTerm(term.sourceTerm))),
    ).length,
    termIds: relevant.map((term) => term.id).slice(0, 40),
    validation: [],
  };

  // What memory answers outright, and what it can only suggest.
  const values = new Map<string, string>();
  const exactHints: MemoryHint[] = [];
  const usedIds = new Set<string>();
  const byKey = new Map(memory.map((entry) => [entry.sourceKey, entry]));
  const remaining: SourceField[] = [];
  for (const field of fields) {
    const entry = byKey.get(memoryKey(field.value));
    if (!entry) {
      remaining.push(field);
      continue;
    }
    const verdict = reuseVerdict(field, entry, {
      resourceType: input.resourceType,
      glossary: input.glossary,
      targetLocale: input.locale,
    });
    if (verdict === "reuse") {
      values.set(field.key, entry.targetText);
      trace.reusedKeys.push(field.key);
      usedIds.add(entry.id);
      continue;
    }
    if (verdict === "hint") {
      exactHints.push({ id: entry.id, sourceText: entry.sourceText, targetText: entry.targetText, origin: entry.origin });
      usedIds.add(entry.id);
    }
    remaining.push(field);
  }

  if (remaining.length === 0) {
    trace.memoryHitIds = [...usedIds].slice(0, 40);
    return { kind: "ok", values, trace, learned: [] };
  }

  const hints = [...exactHints, ...selectMemoryHints(remaining, memory, usedIds)];
  for (const hint of hints) usedIds.add(hint.id);
  trace.memoryHitIds = [...usedIds].slice(0, 40);

  const request: TranslationRequest = {
    sourceLocale: input.source.locale,
    targetLocale: input.locale,
    resourceKind: RESOURCE_TYPE_LABEL[input.resourceType],
    resourceTitle: input.title,
    fields: remaining,
    glossary: input.glossary,
    storeName: ctx.storeName,
    storeContext: intelligence.storeContext,
    resourceContext: context,
    terminology: relevant.map(terminologyNote),
    memoryHints: hints,
  };
  const rules = {
    sourceLocale: input.source.locale,
    targetLocale: input.locale,
    glossary: input.glossary,
    formStableTerms: formStableTerms(relevant, memory, ctx.storeName),
  };
  const usage = {
    syncId: ctx.syncId,
    resourceId: input.resource.resourceId,
    resourceType: input.resourceType,
  };

  let answer: TranslateOutcome = await translateFields(ctx.principal, request, usage);
  trace.attempts = 1;
  let violations: Violation[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (answer.kind === "failed") return { kind: "failed", message: answer.message, trace };
    trace.model = answer.model;
    violations = validateTranslation(remaining, answer.values, rules);
    trace.validation.push({
      attempt,
      violations: violations.map((v) => ({ key: v.key, code: v.code, severity: v.severity })),
    });
    const hard = hardViolations(violations);
    if (hard.length === 0) break;
    if (attempt === MAX_ATTEMPTS)
      return {
        kind: "failed",
        message: `The translation broke a rule and could not be corrected: ${describeViolations(hard)}.`,
        trace,
      };
    answer = await correctFields(ctx.principal, request, answer.text, hard, usage);
    trace.attempts += 1;
  }
  if (answer.kind === "failed") return { kind: "failed", message: answer.message, trace };

  for (const [key, value] of answer.values) values.set(key, value);
  return {
    kind: "ok",
    values,
    trace,
    learned: memorablePairs(remaining, answer.values).map((pair) => ({
      sourceText: pair.sourceText,
      targetText: pair.targetText,
    })),
  };
}

function terminologyNote(term: StoredTerm): TerminologyNote {
  const sources: Record<string, string> = {
    vendor: "vendor",
    productType: "product type",
    menu: "menu label",
    collection: "collection title",
    tag: "tag",
    optionName: "option name",
    optionValue: "option value",
    productTitle: "product titles",
    profile: "store profile",
    shop: "store name",
  };
  const evidence = Object.entries(term.evidence)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([source, count]) =>
      source === "productTitle" ? `${count} product titles` : sources[source] ?? source,
    );
  return {
    term: term.term,
    classification: term.classification,
    evidence: evidence.length > 0 ? evidence.join(", ") : null,
  };
}

/**
 * What may legitimately come back unchanged: brands, codes and
 * abbreviations among the relevant terms, strings memory has seen kept as
 * they were by a person or more than once, and the store's name. A single
 * machine answer is not enough to make a word stable, or one doubtful
 * answer would license the next.
 */
function formStableTerms(
  terms: readonly StoredTerm[],
  memory: readonly StoredMemory[],
  storeName: string | null,
): string[] {
  const stable = new Set<string>();
  for (const term of terms) if (FORM_STABLE_CLASSIFICATIONS.has(term.classification)) stable.add(term.term);
  for (const entry of memory) {
    const kept = normaliseTerm(entry.sourceText) === normaliseTerm(entry.targetText);
    if (kept && (entry.origin === "manual" || entry.usageCount >= 2)) stable.add(entry.sourceText);
  }
  if (storeName) stable.add(storeName);
  return [...stable];
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
