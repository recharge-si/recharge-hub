/**
 * Locales versus languages (docs/translations.md § Target-locale
 * terminology). Localisation is locale-specific: `de-AT` and `de-CH` may
 * settle on different words for the same thing. Everything learnt is keyed
 * by the exact locale Shopify uses, and falls back to the bare language
 * when the exact locale has nothing to say.
 */

/** "de" for "de-AT"; "pt" for "pt-BR"; "zh" for "zh-Hant-TW". */
export function languageOf(locale: string): string {
  return locale.split("-")[0]?.toLowerCase() ?? locale.toLowerCase();
}

/**
 * The locales to consult for one target, most specific first:
 * `["de-AT", "de"]`. A bare language is its own only entry.
 */
export function localeChain(locale: string): string[] {
  const parts = locale.split("-");
  const chain: string[] = [];
  for (let end = parts.length; end >= 1; end -= 1) chain.push(parts.slice(0, end).join("-"));
  return chain;
}

/** Whether two locales are the same language, whatever their regions. */
export function sameLanguage(a: string, b: string): boolean {
  return languageOf(a) === languageOf(b);
}
