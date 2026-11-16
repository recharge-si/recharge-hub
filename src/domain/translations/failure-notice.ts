import { describeLanguage } from "~/domain/translations/languages";

/**
 * The Needs attention row for content that could not be translated
 * (docs/translations.md § Failures).
 *
 * One row per resource, not per sync: collected webhook syncs run all day,
 * and a row per sync saying "1 fields could not be translated" was
 * thousands of rows that named nothing. The row names the resource, the
 * languages and the reason, is updated while the resource keeps failing,
 * and is closed by the translation job once it translates.
 */

export interface FailedTranslation {
  locale: string;
  error?: string | null;
}

export function translationFailureKey(resourceId: string): string {
  return `translation-resource:${resourceId}`;
}

function languageName(locale: string): string {
  return describeLanguage(locale).name;
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * `“Duotone Rebel” could not be translated into Slovenian and German: The
 * reply left out title.` Languages that failed for different reasons each
 * get their own sentence.
 */
export function translationFailureMessage(
  title: string,
  failures: readonly FailedTranslation[],
): string {
  const byReason = new Map<string, string[]>();
  for (const failure of failures) {
    const reason = failure.error?.trim() || "No reason was recorded.";
    byReason.set(reason, [
      ...(byReason.get(reason) ?? []),
      languageName(failure.locale),
    ]);
  }
  const reasons = [...byReason.entries()].map(([reason, names]) => {
    const text = /[.!?]$/.test(reason) ? reason : `${reason}.`;
    return byReason.size === 1 ? text : `${list(names)}: ${text}`;
  });
  const languages = list([
    ...new Set(failures.map((f) => languageName(f.locale))),
  ]);
  return `“${title}” could not be translated into ${languages}. ${reasons.join(" ")}`;
}
