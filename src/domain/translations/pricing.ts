/**
 * What a model costs, in one place (docs/translations.md § AI usage).
 *
 * Provider pricing changes, and an estimate computed under one table must
 * stay explainable after the table moves: every usage row records the
 * `PRICING_VERSION` it was priced under together with the result, so a later
 * table changes nothing already recorded and a report can say which version
 * a number came from. Nothing else in the app carries a price.
 *
 * Prices are USD per one million tokens, held as integer micro-USD so the
 * arithmetic is exact. The provider does not report billed cost through the
 * API, so every figure derived here is an **estimate** and is labelled one.
 */

export const PRICING_VERSION = "2026-09";

export interface ModelPricing {
  /** Micro-USD per input token. */
  inputPerToken: number;
  /** Micro-USD per cached input token, when the provider reports them. */
  cachedInputPerToken: number;
  /** Micro-USD per output token. */
  outputPerToken: number;
}

/** USD per million tokens → micro-USD per token. */
function perMillion(usd: number): number {
  return usd; // 1 USD / 1e6 tokens = 1 micro-USD per token.
}

/**
 * Keyed by the model name as sent to the provider. A dated snapshot such as
 * `gpt-4.1-mini-2025-04-14` is priced as its family by prefix match.
 */
const TABLE: Record<string, ModelPricing> = {
  "gpt-5": {
    inputPerToken: perMillion(1.25),
    cachedInputPerToken: perMillion(0.125),
    outputPerToken: perMillion(10),
  },
  "gpt-5-mini": {
    inputPerToken: perMillion(0.25),
    cachedInputPerToken: perMillion(0.025),
    outputPerToken: perMillion(2),
  },
  "gpt-5-nano": {
    inputPerToken: perMillion(0.05),
    cachedInputPerToken: perMillion(0.005),
    outputPerToken: perMillion(0.4),
  },
  "gpt-4.1": {
    inputPerToken: perMillion(2),
    cachedInputPerToken: perMillion(0.5),
    outputPerToken: perMillion(8),
  },
  "gpt-4.1-mini": {
    inputPerToken: perMillion(0.4),
    cachedInputPerToken: perMillion(0.1),
    outputPerToken: perMillion(1.6),
  },
  "gpt-4.1-nano": {
    inputPerToken: perMillion(0.1),
    cachedInputPerToken: perMillion(0.025),
    outputPerToken: perMillion(0.4),
  },
  "gpt-4o": {
    inputPerToken: perMillion(2.5),
    cachedInputPerToken: perMillion(1.25),
    outputPerToken: perMillion(10),
  },
  "gpt-4o-mini": {
    inputPerToken: perMillion(0.15),
    cachedInputPerToken: perMillion(0.075),
    outputPerToken: perMillion(0.6),
  },
};

export function pricingFor(model: string): ModelPricing | null {
  const exact = TABLE[model];
  if (exact) return exact;
  // Longest family prefix wins, so "gpt-4.1-mini-2025..." is not priced as "gpt-4.1".
  const family = Object.keys(TABLE)
    .filter((name) => model.startsWith(`${name}-`))
    .sort((a, b) => b.length - a.length)[0];
  return family ? (TABLE[family] ?? null) : null;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * Estimated cost in micro-USD, or null for a model the table does not know.
 * Cached input tokens are a subset of input tokens, priced at their own rate.
 */
export function estimateCostMicros(
  model: string,
  usage: TokenUsage,
): number | null {
  const pricing = pricingFor(model);
  if (!pricing) return null;
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  return Math.round(
    uncached * pricing.inputPerToken +
      cached * pricing.cachedInputPerToken +
      usage.outputTokens * pricing.outputPerToken,
  );
}

/** Micro-USD as a dollar string, "$18.42"; sub-cent amounts keep four places. */
export function formatMicrosUsd(micros: number | bigint | null): string {
  if (micros === null) return "—";
  const value = Number(micros) / 1_000_000;
  if (value !== 0 && Math.abs(value) < 0.01)
    return `$${value.toFixed(4)}`;
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
