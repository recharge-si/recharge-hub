import type { CoverageRow } from "~/domain/translations/estimate";
import { isTranslatableField } from "~/domain/translations/plan";
import type {
  ExistingTranslation,
  SourceField,
} from "~/domain/translations/types";

/**
 * Counting how translated a store is (docs/translations.md § Coverage).
 *
 * Pure accumulation over what one pass of Shopify's translatable resources
 * reports. A field counts when it is text the engine would translate — the
 * same test the planner applies, so coverage and the estimate agree with
 * what a sync will actually do. Per locale and resource type: how many
 * fields there are, how many are translated, outdated or missing, and how
 * many characters of source sit behind the missing and outdated ones.
 */

export type CoverageAccumulator = Map<string, CoverageRow>;

function keyOf(locale: string, resourceType: string): string {
  return `${locale}\u0000${resourceType}`;
}

export function newCoverage(): CoverageAccumulator {
  return new Map();
}

export function accumulateResource(
  acc: CoverageAccumulator,
  input: {
    resourceType: string;
    fields: readonly SourceField[];
    translations: ReadonlyMap<string, readonly ExistingTranslation[]>;
    locales: readonly string[];
  },
): void {
  const eligible = input.fields.filter(isTranslatableField);
  for (const locale of input.locales) {
    const key = keyOf(locale, input.resourceType);
    const row = acc.get(key) ?? {
      locale,
      resourceType: input.resourceType,
      resources: 0,
      fields: 0,
      translated: 0,
      outdated: 0,
      missing: 0,
      missingChars: 0,
      outdatedChars: 0,
    };
    row.resources += 1;
    const existing = new Map(
      (input.translations.get(locale) ?? []).map((t) => [t.key, t]),
    );
    for (const field of eligible) {
      row.fields += 1;
      const translation = existing.get(field.key);
      if (!translation || translation.value === "") {
        row.missing += 1;
        row.missingChars += field.value.length;
      } else if (translation.outdated) {
        row.outdated += 1;
        row.outdatedChars += field.value.length;
      } else {
        row.translated += 1;
      }
    }
    acc.set(key, row);
  }
}

export function coverageRows(acc: CoverageAccumulator): CoverageRow[] {
  return [...acc.values()].sort((a, b) =>
    a.locale === b.locale
      ? a.resourceType < b.resourceType
        ? -1
        : 1
      : a.locale < b.locale
        ? -1
        : 1,
  );
}

/** One locale's rows folded into totals. */
export function totalsFor(
  rows: readonly CoverageRow[],
  locale: string,
  resourceTypes: readonly string[] | null = null,
): Omit<CoverageRow, "locale" | "resourceType"> {
  const total = {
    resources: 0,
    fields: 0,
    translated: 0,
    outdated: 0,
    missing: 0,
    missingChars: 0,
    outdatedChars: 0,
  };
  for (const row of rows) {
    if (row.locale !== locale) continue;
    if (resourceTypes && !resourceTypes.includes(row.resourceType)) continue;
    total.resources += row.resources;
    total.fields += row.fields;
    total.translated += row.translated;
    total.outdated += row.outdated;
    total.missing += row.missing;
    total.missingChars += row.missingChars;
    total.outdatedChars += row.outdatedChars;
  }
  return total;
}
