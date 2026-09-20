import { z } from "zod";

import { getEnv } from "~/adapters/config/env.server";
import { recordUsage } from "~/adapters/db/repositories/translations.server";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  buildDetectionMessages,
  parseDetectionReply,
  type Detection,
  type DetectionContext,
} from "~/domain/translations/detection";
import { estimateCostMicros, PRICING_VERSION } from "~/domain/translations/pricing";
import {
  PROFILE_PROMPT_VERSION,
  buildProfileMessages,
  parseProfileReply,
  type StoreProfile,
} from "~/domain/translations/profile";
import {
  TRANSLATION_PROMPT_VERSION,
  buildCorrectionMessages,
  buildTranslationMessages,
  parseTranslationReply,
  type ChatMessage,
  type TranslationRequest,
} from "~/domain/translations/prompt";
import type { StoreSample } from "~/domain/translations/snapshot";
import type { Violation } from "~/domain/translations/validate";
import type { Principal } from "~/domain/types";

/**
 * The one translation provider (docs/translations.md § The provider).
 *
 * Every request to OpenAI this app makes goes through `callModel` below and
 * nowhere else, which is what makes the usage ledger complete: each attempt
 * that reaches the provider — a success, a failure that still reports usage,
 * a retry — is one `ai_usage` row, priced under the current table. A
 * translation the planner skipped, or one answered from translation memory,
 * never gets here and so never counts.
 *
 * The key is read from the environment on each call and never leaves this
 * module: not returned, not stored, not logged. A deployment without one is
 * a deployment where `isConfigured()` is false and the pages say so.
 */

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const TIMEOUT_MS = 120_000;
/** Attempts per request, counting the first. Each one that answers is recorded. */
const ATTEMPTS = 3;

export function isConfigured(): boolean {
  const key = getEnv().OPENAI_API_KEY;
  return typeof key === "string" && key.trim() !== "";
}

export function translationModel(): string {
  return getEnv().OPENAI_TRANSLATION_MODEL;
}

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative(),
      prompt_tokens_details: z
        .object({ cached_tokens: z.number().int().nonnegative().optional() })
        .passthrough()
        .optional(),
    })
    .optional(),
});

const usageEnvelopeSchema = z
  .object({ usage: responseSchema.shape.usage })
  .passthrough();

const errorSchema = z.object({
  error: z
    .object({
      message: z.string().optional(),
      type: z.string().optional(),
      code: z.string().nullable().optional(),
    })
    .passthrough()
    .optional(),
});

export interface UsageContext {
  syncId: string | null;
  resourceId: string | null;
  resourceType: string | null;
  sourceLocale: string;
  targetLocale: string;
  purpose: "translate" | "detect" | "profile";
  promptVersion: string | null;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class ProviderNotConfiguredError extends Error {
  constructor() {
    super("AI translation is not configured on this server: OPENAI_API_KEY is not set.");
  }
}

interface ModelAnswer {
  text: string;
  model: string;
}

/**
 * One logical request: up to `ATTEMPTS` HTTP calls, each recorded. A 429 or a
 * 5xx is retried with a growing pause; anything else fails at once. The
 * usage row is written before the result is returned, so a crash after the
 * provider answered still leaves the tokens on the ledger.
 */
async function callModel(
  principal: Principal,
  messages: ChatMessage[],
  context: UsageContext,
  options: { maxOutputTokens: number; temperature?: number },
): Promise<ModelAnswer> {
  const env = getEnv();
  const key = env.OPENAI_API_KEY;
  if (!key || key.trim() === "") throw new ProviderNotConfiguredError();
  const model = env.OPENAI_TRANSLATION_MODEL;
  const log = getLogger();

  let lastError: ProviderError | null = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let status = 0;
    let body: unknown = null;
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages,
          response_format: { type: "json_object" },
          temperature: options.temperature ?? 0.2,
          max_completion_tokens: options.maxOutputTokens,
        }),
        signal: controller.signal,
      });
      status = response.status;
      body = await response.json().catch(() => null);
    } catch (error) {
      clearTimeout(timer);
      // Network failure or timeout: nothing reached us, so there is no usage
      // to record, but the attempt is still noted with zero tokens so the
      // ledger shows that a request was made.
      const message =
        error instanceof Error && error.name === "AbortError"
          ? "The provider did not answer in time."
          : "The provider could not be reached.";
      await record(principal, context, model, undefined, "failed", message);
      lastError = new ProviderError(message, true);
      await pause(attempt);
      continue;
    }
    clearTimeout(timer);

    // Usage may ride on an error reply too, and then it still counts.
    const envelope = usageEnvelopeSchema.safeParse(body);
    const usageValue = envelope.success ? envelope.data.usage : undefined;

    if (status >= 200 && status < 300) {
      const parsed = responseSchema.safeParse(body);
      if (!parsed.success) {
        await record(principal, context, model, usageValue, "failed", "Unreadable reply.");
        throw new ProviderError("The provider's reply could not be read.", false);
      }
      const choice = parsed.data.choices[0];
      const text = choice?.message.content ?? "";
      await record(principal, context, model, parsed.data.usage, "ok", null);
      if (choice?.finish_reason === "length")
        throw new ProviderError(
          "The translation was cut short: the text is too long for one request.",
          false,
        );
      return { text, model };
    }

    const problem = errorSchema.safeParse(body);
    const message =
      (problem.success ? problem.data.error?.message : undefined) ??
      `The provider answered ${status}.`;
    await record(principal, context, model, usageValue, "failed", message);

    const retryable = status === 429 || status >= 500;
    lastError = new ProviderError(message, retryable);
    if (!retryable) break;
    log.warn({ status, attempt, purpose: context.purpose }, "Provider request retried");
    await pause(attempt);
  }
  throw lastError ?? new ProviderError("The provider did not answer.", true);
}

async function record(
  principal: Principal,
  context: UsageContext,
  model: string,
  usage: z.infer<typeof responseSchema>["usage"] | undefined,
  result: "ok" | "failed",
  errorMessage: string | null,
): Promise<void> {
  const inputTokens = usage?.prompt_tokens ?? 0;
  const cachedInputTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  const cost = estimateCostMicros(model, {
    inputTokens,
    cachedInputTokens,
    outputTokens,
  });
  await recordUsage(principal, {
    ...context,
    model,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: usage?.total_tokens ?? inputTokens + outputTokens,
    result,
    errorMessage,
    pricingVersion: cost === null ? null : PRICING_VERSION,
    estimatedCostMicros: cost,
  });
}

function pause(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
}

/** The provider's failure as a value, for the outcomes below. */
function asFailure(error: unknown): { kind: "failed"; message: string; retryable: boolean } {
  if (error instanceof ProviderNotConfiguredError)
    return { kind: "failed", message: error.message, retryable: false };
  if (error instanceof ProviderError)
    return { kind: "failed", message: error.message, retryable: error.retryable };
  throw error;
}

export type TranslateOutcome =
  | { kind: "ok"; values: Map<string, string>; model: string; text: string }
  | { kind: "failed"; message: string; retryable: boolean };

export type TranslationUsageContext = Omit<
  UsageContext,
  "purpose" | "sourceLocale" | "targetLocale" | "promptVersion"
>;

function outputBudget(request: TranslationRequest): number {
  const sourceChars = request.fields.reduce((sum, f) => sum + f.value.length, 0);
  // Room for the translation to run longer than the source, plus the JSON.
  return Math.min(32_000, Math.max(512, Math.ceil((sourceChars / 2.5) * 1.5) + 200));
}

/**
 * Translates every field of one resource into one language. A reply that
 * does not cover exactly the fields asked for is a failure, not a partial
 * success — see `parseTranslationReply`. The raw text is returned too, so a
 * correction can show the model its own previous answer.
 */
export async function translateFields(
  principal: Principal,
  request: TranslationRequest,
  context: TranslationUsageContext,
): Promise<TranslateOutcome> {
  return answerTranslation(principal, buildTranslationMessages(request), request, context);
}

/**
 * The second try after validation failed: the same request, the previous
 * answer, and the invariants it broke, spelt out.
 */
export async function correctFields(
  principal: Principal,
  request: TranslationRequest,
  previousAnswer: string,
  violations: readonly Violation[],
  context: TranslationUsageContext,
): Promise<TranslateOutcome> {
  return answerTranslation(
    principal,
    buildCorrectionMessages(request, previousAnswer, violations),
    request,
    context,
  );
}

async function answerTranslation(
  principal: Principal,
  messages: ChatMessage[],
  request: TranslationRequest,
  context: TranslationUsageContext,
): Promise<TranslateOutcome> {
  try {
    const answer = await callModel(
      principal,
      messages,
      {
        ...context,
        purpose: "translate",
        promptVersion: TRANSLATION_PROMPT_VERSION,
        sourceLocale: request.sourceLocale,
        targetLocale: request.targetLocale,
      },
      { maxOutputTokens: outputBudget(request) },
    );
    const parsed = parseTranslationReply(answer.text, request.fields);
    if (!parsed.ok) return { kind: "failed", message: parsed.reason, retryable: false };
    return { kind: "ok", values: parsed.values, model: answer.model, text: answer.text };
  } catch (error) {
    return asFailure(error);
  }
}

export type DetectOutcome =
  | ({ kind: "ok" } & Detection)
  | { kind: "failed"; message: string };

/** Which language a sample is written in — a suggestion for a person to confirm. */
export async function detectLanguage(
  principal: Principal,
  sample: string,
  context: { resourceId: string; resourceType: string } & DetectionContext,
): Promise<DetectOutcome> {
  try {
    const answer = await callModel(
      principal,
      buildDetectionMessages(sample, context),
      {
        syncId: null,
        resourceId: context.resourceId,
        resourceType: context.resourceType,
        sourceLocale: context.storeLocale,
        targetLocale: context.storeLocale,
        purpose: "detect",
        promptVersion: null,
      },
      { maxOutputTokens: 60 },
    );
    const parsed = parseDetectionReply(answer.text, sample);
    if (!parsed) return { kind: "failed", message: "The language could not be told." };
    return { kind: "ok", ...parsed };
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError || error instanceof ProviderError)
      return { kind: "failed", message: error.message };
    throw error;
  }
}

export type ProfileOutcome =
  | { kind: "ok"; profile: StoreProfile; model: string }
  | { kind: "failed"; message: string; retryable: boolean };

/**
 * What kind of store this is, from a sample of its content: one request
 * per shop, repeated only when the store has changed or a person asks.
 */
export async function generateStoreProfile(
  principal: Principal,
  sample: StoreSample,
): Promise<ProfileOutcome> {
  try {
    const answer = await callModel(
      principal,
      buildProfileMessages(sample),
      {
        syncId: null,
        resourceId: null,
        resourceType: null,
        sourceLocale: sample.primaryLocale,
        targetLocale: sample.primaryLocale,
        purpose: "profile",
        promptVersion: PROFILE_PROMPT_VERSION,
      },
      { maxOutputTokens: 6_000, temperature: 0.1 },
    );
    const parsed = parseProfileReply(answer.text);
    if (!parsed.ok) return { kind: "failed", message: parsed.reason, retryable: false };
    return { kind: "ok", profile: parsed.profile, model: answer.model };
  } catch (error) {
    return asFailure(error);
  }
}
