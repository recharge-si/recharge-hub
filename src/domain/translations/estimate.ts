import { estimateCostMicros, pricingFor } from "~/domain/translations/pricing";
import type { SyncMode } from "~/domain/translations/types";

/**
 * What a translation run will roughly cost before it starts
 * (docs/translations.md § Translate store).
 *
 * Built from the coverage cache: per language and resource type, how many
 * fields are missing or outdated and how many characters of source text sit
 * behind them. Tokens are estimated from characters — about four characters
 * a token for Latin-script prose, fewer for HTML and for languages with
 * diacritics, so the ratio is deliberately conservative — plus the fixed
 * overhead of the instructions each request carries. The provider reports
 * the real figures afterwards; this only has to be the right order of
 * magnitude.
 */

/** Characters of source text per input token, conservatively. */
const CHARS_PER_TOKEN = 3.5;
/** Instructions, glossary and JSON scaffolding sent with every request. */
const REQUEST_OVERHEAD_TOKENS = 350;
/** A translation comes back about as long as it went in, plus JSON quoting. */
const OUTPUT_RATIO = 1.15;
/** Characters in a field nothing has been measured for: a short title or two. */
const DEFAULT_FIELD_CHARS = 120;

export interface CoverageRow {
  locale: string;
  resourceType: string;
  resources: number;
  fields: number;
  translated: number;
  outdated: number;
  missing: number;
  missingChars: number;
  outdatedChars: number;
}

export interface Estimate {
  resources: number;
  fields: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Micro-USD, or null when the model is not priced. */
  costMicros: number | null;
  model: string;
  priced: boolean;
  perLocale: Array<{
    locale: string;
    fields: number;
    costMicros: number | null;
  }>;
  /** When the coverage these figures come from was read; null if never. */
  coverageAt: string | null;
}

export function estimateRun(input: {
  rows: readonly CoverageRow[];
  locales: readonly string[];
  resourceTypes: readonly string[];
  mode: SyncMode;
  model: string;
  coverageAt: string | null;
}): Estimate {
  const perLocale: Estimate["perLocale"] = [];
  let resources = 0;
  let fields = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const locale of input.locales) {
    let localeFields = 0;
    let localeInput = 0;
    let localeOutput = 0;
    for (const row of input.rows) {
      if (row.locale !== locale) continue;
      if (!input.resourceTypes.includes(row.resourceType)) continue;
      const { count, chars } = fieldsForMode(row, input.mode);
      if (count === 0) continue;
      // One request per resource per language is the engine's unit; a
      // resource with several fields shares the overhead.
      const requests = Math.min(count, row.resources) || 1;
      const textTokens = Math.ceil(chars / CHARS_PER_TOKEN);
      localeFields += count;
      localeInput += textTokens + requests * REQUEST_OVERHEAD_TOKENS;
      localeOutput += Math.ceil(textTokens * OUTPUT_RATIO);
      resources += Math.min(count, row.resources);
    }
    fields += localeFields;
    inputTokens += localeInput;
    outputTokens += localeOutput;
    perLocale.push({
      locale,
      fields: localeFields,
      costMicros: estimateCostMicros(input.model, {
        inputTokens: localeInput,
        cachedInputTokens: 0,
        outputTokens: localeOutput,
      }),
    });
  }

  return {
    resources,
    fields,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costMicros: estimateCostMicros(input.model, {
      inputTokens,
      cachedInputTokens: 0,
      outputTokens,
    }),
    model: input.model,
    priced: pricingFor(input.model) !== null,
    perLocale,
    coverageAt: input.coverageAt,
  };
}

function fieldsForMode(
  row: CoverageRow,
  mode: SyncMode,
): { count: number; chars: number } {
  switch (mode) {
    case "missing":
      return { count: row.missing, chars: row.missingChars };
    case "missing_outdated":
      return {
        count: row.missing + row.outdated,
        chars: row.missingChars + row.outdatedChars,
      };
    case "force":
      // Every field, at the average length of the ones we measured.
      return {
        count: row.fields,
        chars: Math.round(row.fields * averageFieldChars(row)),
      };
  }
}

/**
 * What a language the store does not have yet would cover: every field of
 * every resource, none of it translated.
 *
 * Coverage is counted per target locale, but the source side — how many
 * resources of each type, how many translatable fields each has — is the
 * same whichever locale is being counted. So the rows of any counted locale
 * describe the new one, with every field missing. The characters behind
 * those fields are only measured for fields the counted locale is missing
 * or has outdated, so the new language's fields are given the average
 * measured length, the way `force` mode prices a full run. The rows go
 * through `estimateRun` in `missing` mode like any other.
 */
export function coverageForNewLocale(
  rows: readonly CoverageRow[],
  locale: string,
): CoverageRow[] {
  const byType = new Map<string, CoverageRow>();
  for (const row of rows) {
    if (row.locale === locale) continue;
    const known = byType.get(row.resourceType);
    // The locale that measured the most characters knows the source best.
    if (
      !known ||
      row.fields > known.fields ||
      (row.fields === known.fields &&
        row.missingChars + row.outdatedChars >
          known.missingChars + known.outdatedChars)
    )
      byType.set(row.resourceType, row);
  }
  return [...byType.values()]
    .map((row) => ({
      ...row,
      locale,
      translated: 0,
      outdated: 0,
      missing: row.fields,
      missingChars: Math.round(row.fields * averageFieldChars(row)),
      outdatedChars: 0,
    }))
    .sort((a, b) => (a.resourceType < b.resourceType ? -1 : 1));
}

/** The measured length of a field in this row, or a guess when none was. */
function averageFieldChars(row: CoverageRow): number {
  const measured = row.missing + row.outdated;
  return measured > 0
    ? (row.missingChars + row.outdatedChars) / measured
    : DEFAULT_FIELD_CHARS;
}

/** Coverage as a whole-number percentage, or null with nothing to count. */
export function coveragePercent(
  rows: readonly Pick<CoverageRow, "fields" | "translated">[],
): number | null {
  let fields = 0;
  let translated = 0;
  for (const row of rows) {
    fields += row.fields;
    translated += row.translated;
  }
  if (fields === 0) return null;
  return Math.floor((translated / fields) * 100);
}

/** "6.8M", "12,842", "980". */
export function formatCount(value: number): string {
  if (value >= 10_000_000) return `${(value / 1_000_000).toFixed(0)}M`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 100_000) return `${(value / 1_000).toFixed(0)}K`;
  return value.toLocaleString("en");
}
