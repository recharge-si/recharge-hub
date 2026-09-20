import type { ReactNode } from "react";

import type { LanguageInfo } from "~/domain/translations/languages";
import { LocaleFlag } from "~/web/components/locale-flag";

/**
 * One language, named the same way on every translations screen: its flag,
 * its English name, its own name for itself when that differs, and its
 * locale in the trailing column (docs/translations.md § Languages).
 *
 * The flag is decoration and the locale is the fact: a merchant reads
 * "German (Austria) · Deutsch" and a screen reader reads the same, with
 * "de-AT" after it. `trailing` is for whatever the row needs beside the
 * locale — a badge, a tick — so a list of these keeps one right edge.
 */
export type LanguageLabelInfo = Pick<
  LanguageInfo,
  "locale" | "name" | "nativeName" | "regionCode" | "regionName"
>;

export function LanguageLabel({
  language,
  size = "base",
  trailing = null,
  detail = null,
}: {
  language: LanguageLabelInfo;
  size?: "base" | "large";
  /** Beside the locale, at the trailing edge. */
  trailing?: ReactNode;
  /** A second line under the name, replacing the native name. */
  detail?: string | null;
}) {
  const native =
    language.nativeName && language.nativeName !== language.name
      ? language.nativeName
      : null;
  return (
    <s-grid
      gridTemplateColumns="auto 1fr auto"
      gap="small-200"
      alignItems="center"
    >
      <LocaleFlag
        regionCode={language.regionCode}
        regionName={language.regionName}
        size={size === "large" ? "large" : "base"}
      />
      {size === "large" ? (
        <s-stack direction="block" gap="none">
          <s-heading>{language.name}</s-heading>
          {(detail ?? native) ? (
            <s-text color="subdued">{detail ?? native}</s-text>
          ) : null}
        </s-stack>
      ) : (
        <s-stack direction="inline" gap="small-300" alignItems="baseline">
          <s-text>{language.name}</s-text>
          {(detail ?? native) ? (
            <s-text color="subdued">{detail ?? native}</s-text>
          ) : null}
        </s-stack>
      )}
      <s-stack direction="inline" gap="small-300" alignItems="center">
        <s-text color="subdued">{language.locale}</s-text>
        {trailing}
      </s-stack>
    </s-grid>
  );
}
