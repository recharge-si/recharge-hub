/**
 * What a merchant sees when a locale is named (docs/translations.md
 * § Languages): its English name, its own name for itself, and the country
 * whose flag stands beside it.
 *
 * A language is not a country. `de-AT` names Austria itself; bare `de` names
 * none, and the flag beside it is CLDR's likely region for the language —
 * the same "add likely subtags" rule the platform applies when it maximises
 * `de` to `de-Latn-DE`. A language whose likely region is not a country
 * (Esperanto → the world) gets no flag. Nothing here is hand-typed: the
 * names come from `Intl.DisplayNames`, the regions from `Intl.Locale`, both
 * from the ICU data the runtime ships. Shopify's own English name wins when
 * it gave one, because that is the name every other admin page uses.
 *
 * Pure: the runtime's ICU data is the only input besides the arguments.
 */

export interface LanguageInfo {
  /** The locale exactly as Shopify writes it: "de", "pt-BR", "zh-TW". */
  locale: string;
  /** ISO 639 language subtag: "de". */
  languageCode: string;
  /** ISO 15924 script subtag when the locale carries one: "Hant". */
  scriptCode: string | null;
  /** ISO 3166-1 alpha-2 region the flag stands for, or null for none. */
  regionCode: string | null;
  /** "Austria"; null when there is no region. */
  regionName: string | null;
  /** The region in the language itself: "Österreich". Search only. */
  nativeRegionName: string | null;
  /**
   * Whether the region is part of the locale itself (`de-AT`) rather than
   * CLDR's likely region for a bare language (`de` → Germany).
   */
  regionFromLocale: boolean;
  /** English: "German (Austria)". */
  name: string;
  /** The language's own name for itself: "Deutsch". Null when ICU has none. */
  nativeName: string | null;
}

const TWO_LETTER_REGION = /^[A-Z]{2}$/;

let englishLanguages: Intl.DisplayNames | null = null;
let englishRegions: Intl.DisplayNames | null = null;
const nativeNames = new Map<string, Intl.DisplayNames | null>();
const nativeRegions = new Map<string, Intl.DisplayNames | null>();

function englishLanguageNames(): Intl.DisplayNames {
  // "German (Austria)", the way Shopify names its locales, rather than
  // ICU's dialect form "Austrian German".
  englishLanguages ??= new Intl.DisplayNames(["en"], {
    type: "language",
    languageDisplay: "standard",
    fallback: "none",
  });
  return englishLanguages;
}

function englishRegionNames(): Intl.DisplayNames {
  englishRegions ??= new Intl.DisplayNames(["en"], {
    type: "region",
    fallback: "none",
  });
  return englishRegions;
}

function displayNamesIn(
  cache: Map<string, Intl.DisplayNames | null>,
  locale: string,
  type: "language" | "region",
): Intl.DisplayNames | null {
  const cached = cache.get(locale);
  if (cached !== undefined) return cached;
  let names: Intl.DisplayNames | null;
  try {
    names = new Intl.DisplayNames([locale], { type, fallback: "none" });
  } catch {
    names = null;
  }
  cache.set(locale, names);
  return names;
}

function safeOf(names: Intl.DisplayNames | null, code: string): string | null {
  if (!names) return null;
  try {
    return names.of(code) ?? null;
  } catch {
    return null;
  }
}

/**
 * Describes one locale. `name` is Shopify's English name when the caller
 * has it; otherwise ICU's. A tag ICU cannot parse is described as itself.
 */
export function describeLanguage(
  locale: string,
  name?: string | null,
): LanguageInfo {
  let tag: Intl.Locale | null = null;
  try {
    tag = new Intl.Locale(locale);
  } catch {
    tag = null;
  }
  if (!tag) {
    return {
      locale,
      languageCode: locale.split("-")[0]?.toLowerCase() ?? locale,
      scriptCode: null,
      regionCode: null,
      regionName: null,
      nativeRegionName: null,
      regionFromLocale: false,
      name: name ?? locale,
      nativeName: null,
    };
  }

  const languageCode = tag.language;
  const scriptCode = tag.script ?? null;
  let regionCode = tag.region ?? null;
  let regionFromLocale = regionCode !== null;
  if (!regionCode) {
    try {
      regionCode = tag.maximize().region ?? null;
    } catch {
      regionCode = null;
    }
  }
  if (regionCode && !TWO_LETTER_REGION.test(regionCode)) regionCode = null;
  const regionName = regionCode
    ? safeOf(englishRegionNames(), regionCode)
    : null;
  // A region ICU cannot name is not one a merchant would recognise either.
  if (regionCode && !regionName) regionCode = null;
  if (!regionCode) regionFromLocale = false;

  // The language's own name, in the script the locale uses — `sr-Latn`
  // reads "srpski", `sr` reads "српски" — without the region ICU would
  // append for a regional tag.
  const nativeName = safeOf(
    displayNamesIn(nativeNames, locale, "language"),
    languageCode,
  );
  const nativeRegionName = regionCode
    ? safeOf(displayNamesIn(nativeRegions, locale, "region"), regionCode)
    : null;

  return {
    locale,
    languageCode,
    scriptCode,
    regionCode,
    regionName,
    nativeRegionName,
    regionFromLocale,
    name: name ?? safeOf(englishLanguageNames(), locale) ?? locale,
    nativeName,
  };
}

/**
 * Lower-cased, diacritics dropped, whitespace collapsed: "Français" and
 * "francais" are the same search.
 */
export function normalizeSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** The strings one language can be found by, normalised once. */
interface SearchEntry<T> {
  item: T;
  index: number;
  locale: string;
  language: string;
  region: string;
  fullTag: string;
  names: string[];
  words: string[];
}

function searchEntry<T extends LanguageInfo>(
  item: T,
  index: number,
): SearchEntry<T> {
  const locale = normalizeSearch(item.locale);
  const language = normalizeSearch(item.languageCode);
  const region = item.regionCode ? normalizeSearch(item.regionCode) : "";
  const names = [
    item.name,
    item.nativeName ?? "",
    item.regionName ?? "",
    item.nativeRegionName ?? "",
  ]
    .filter(Boolean)
    .map(normalizeSearch);
  return {
    item,
    index,
    locale,
    language,
    region,
    fullTag: region ? `${language}-${region}` : locale,
    names,
    words: names.flatMap((text) => text.split(/[\s(),/-]+/)).filter(Boolean),
  };
}

/** How well one entry answers one term; lower is better, null is not at all. */
function termRank<T>(entry: SearchEntry<T>, term: string): number | null {
  // A code typed exactly is the one thing the merchant means.
  if (
    term === entry.locale ||
    term === entry.language ||
    term === entry.fullTag
  )
    return 0;
  if (entry.names.some((text) => text.startsWith(term))) return 1;
  if (
    entry.locale.startsWith(term) ||
    entry.fullTag.startsWith(term) ||
    term === entry.region ||
    entry.words.some((word) => word.startsWith(term))
  )
    return 2;
  if (
    entry.names.some((text) => text.includes(term)) ||
    entry.fullTag.includes(term)
  )
    return 3;
  return null;
}

/**
 * The languages that answer a query, best first: an exact code, then a name
 * that starts with it, then a word or code that does, then anything that
 * contains it. Every word of a query must match somewhere ("chinese trad").
 * Ties keep the order given. An empty query returns everything.
 */
export function searchLanguages<T extends LanguageInfo>(
  items: readonly T[],
  query: string,
): T[] {
  const terms = normalizeSearch(query).split(" ").filter(Boolean);
  if (terms.length === 0) return [...items];
  const ranked: Array<{ item: T; rank: number; index: number }> = [];
  items.forEach((item, index) => {
    const entry = searchEntry(item, index);
    let rank = 0;
    for (const term of terms) {
      const found = termRank(entry, term);
      if (found === null) return;
      rank = Math.max(rank, found);
    }
    ranked.push({ item, rank, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map((row) => row.item);
}
