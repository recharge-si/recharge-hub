import { describe, expect, it } from "vitest";

import {
  coverageForNewLocale,
  estimateRun,
  type CoverageRow,
} from "~/domain/translations/estimate";
import {
  describeLanguage,
  normalizeSearch,
  searchLanguages,
} from "~/domain/translations/languages";

/**
 * How a locale is named and found on the translations screens
 * (docs/translations.md § Languages): the flag follows the region, the
 * region follows the locale or CLDR's likely subtags, and nothing is
 * invented where neither says.
 */
describe("describeLanguage", () => {
  it("takes the region from the locale when it carries one", () => {
    const austria = describeLanguage("de-AT", "German (Austria)");
    expect(austria).toMatchObject({
      languageCode: "de",
      regionCode: "AT",
      regionName: "Austria",
      regionFromLocale: true,
      name: "German (Austria)",
      nativeName: "Deutsch",
    });
    expect(describeLanguage("pt-BR").regionCode).toBe("BR");
    expect(describeLanguage("pt-PT").regionCode).toBe("PT");
    expect(describeLanguage("en-GB").regionCode).toBe("GB");
    expect(describeLanguage("fr-CA").regionCode).toBe("CA");
    expect(describeLanguage("zh-TW").regionCode).toBe("TW");
    expect(describeLanguage("zh-CN").regionCode).toBe("CN");
  });

  it("falls back to the likely region for a bare language", () => {
    expect(describeLanguage("de")).toMatchObject({
      regionCode: "DE",
      regionName: "Germany",
      regionFromLocale: false,
    });
    expect(describeLanguage("sl").regionCode).toBe("SI");
    expect(describeLanguage("sv").regionCode).toBe("SE");
    expect(describeLanguage("ja").regionCode).toBe("JP");
  });

  it("gives no region where none is defensible", () => {
    expect(describeLanguage("eo")).toMatchObject({
      regionCode: null,
      regionName: null,
      nativeName: "Esperanto",
    });
    expect(describeLanguage("es-419").regionCode).toBeNull();
  });

  it("names the language in its own script", () => {
    expect(describeLanguage("sr").nativeName).toBe("српски");
    expect(describeLanguage("sr-Latn").nativeName).toBe("srpski");
    expect(describeLanguage("fr").nativeName).toBe("français");
    expect(describeLanguage("sl").nativeName).toBe("slovenščina");
  });

  it("prefers the name given over ICU's", () => {
    expect(describeLanguage("zh-TW", "Chinese (Traditional)").name).toBe(
      "Chinese (Traditional)",
    );
    expect(describeLanguage("zh-TW").name).toBe("Chinese (Taiwan)");
  });

  it("describes a tag it cannot parse as itself", () => {
    expect(describeLanguage("not a tag")).toMatchObject({
      locale: "not a tag",
      regionCode: null,
      nativeName: null,
      name: "not a tag",
    });
  });
});

describe("searchLanguages", () => {
  const list = [
    "de",
    "de-AT",
    "de-CH",
    "fr",
    "fr-CA",
    "it",
    "sl",
    "pt-BR",
    "zh-CN",
    "zh-TW",
    "sr",
  ].map((locale) =>
    describeLanguage(
      locale,
      locale === "zh-CN"
        ? "Chinese (Simplified)"
        : locale === "zh-TW"
          ? "Chinese (Traditional)"
          : null,
    ),
  );
  const locales = (query: string) =>
    searchLanguages(list, query).map((language) => language.locale);

  it("returns everything, in order, for an empty query", () => {
    expect(locales("")).toEqual(list.map((language) => language.locale));
    expect(locales("   ")).toEqual(list.map((language) => language.locale));
  });

  it("finds by English name, native name, code, locale and country", () => {
    expect(locales("German")).toEqual(["de", "de-AT", "de-CH"]);
    expect(locales("Deutsch")).toEqual(["de", "de-AT", "de-CH"]);
    expect(locales("de")).toEqual(["de", "de-AT", "de-CH"]);
    expect(locales("de-CH")).toEqual(["de-CH"]);
    expect(locales("de-DE")).toEqual(["de"]);
    expect(locales("Switzerland")).toEqual(["de-CH"]);
    expect(locales("Schweiz")).toEqual(["de-CH"]);
    expect(locales("Brazil")).toEqual(["pt-BR"]);
  });

  it("ignores case and accents", () => {
    expect(locales("FRANCAIS")).toEqual(["fr", "fr-CA"]);
    expect(locales("slovenscina")).toEqual(["sl"]);
    expect(normalizeSearch("  Slovenščina ")).toBe("slovenscina");
  });

  it("ranks the exact code above names that merely start the same", () => {
    // "it" is Italian's code and the start of nothing else here.
    expect(locales("it")[0]).toBe("it");
    // "sl" is Slovenian's code; nothing else starts with it.
    expect(locales("sl")).toEqual(["sl"]);
  });

  it("matches every word of a longer query", () => {
    expect(locales("chinese trad")).toEqual(["zh-TW"]);
    expect(locales("chinese")).toEqual(["zh-CN", "zh-TW"]);
    expect(locales("german austria")).toEqual(["de-AT"]);
  });

  it("finds nothing for what is not there", () => {
    expect(locales("klingon")).toEqual([]);
  });
});

/**
 * The scope of a language the store does not have yet is the source side
 * of any language it does, with every field missing.
 */
describe("coverageForNewLocale", () => {
  const row = (
    locale: string,
    resourceType: string,
    partial: Partial<CoverageRow> = {},
  ): CoverageRow => ({
    locale,
    resourceType,
    resources: 10,
    fields: 40,
    translated: 30,
    outdated: 2,
    missing: 8,
    missingChars: 800,
    outdatedChars: 200,
    ...partial,
  });

  it("copies the source side and marks every field missing", () => {
    const rows = coverageForNewLocale(
      [
        row("de", "PRODUCT"),
        row("de", "COLLECTION", {
          fields: 6,
          resources: 3,
          missing: 6,
          outdated: 0,
          missingChars: 300,
          outdatedChars: 0,
        }),
      ],
      "it",
    );
    expect(rows.map((r) => r.resourceType)).toEqual(["COLLECTION", "PRODUCT"]);
    const product = rows.find((r) => r.resourceType === "PRODUCT");
    expect(product).toMatchObject({
      locale: "it",
      resources: 10,
      fields: 40,
      translated: 0,
      outdated: 0,
      missing: 40,
      // 1,000 characters measured over 10 fields → 100 a field → 4,000.
      missingChars: 4000,
      outdatedChars: 0,
    });
  });

  it("ignores the new locale's own stale rows and prefers the fullest count", () => {
    const rows = coverageForNewLocale(
      [
        row("it", "PRODUCT", { fields: 5 }),
        row("de", "PRODUCT", { fields: 40 }),
        row("fr", "PRODUCT", { fields: 44, resources: 11 }),
      ],
      "it",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fields: 44, resources: 11, missing: 44 });
  });

  it("gives a field a length when none was measured", () => {
    const rows = coverageForNewLocale(
      [
        row("de", "PAGE", {
          fields: 2,
          missing: 0,
          outdated: 0,
          missingChars: 0,
          outdatedChars: 0,
          translated: 2,
        }),
      ],
      "it",
    );
    expect(rows[0]?.missingChars).toBe(240);
  });

  it("estimates like any other run once synthesised", () => {
    const rows = coverageForNewLocale([row("de", "PRODUCT")], "it");
    const estimate = estimateRun({
      rows,
      locales: ["it"],
      resourceTypes: ["PRODUCT"],
      mode: "missing",
      model: "gpt-4.1-mini",
      coverageAt: "2026-09-20T00:00:00.000Z",
    });
    expect(estimate.fields).toBe(40);
    expect(estimate.resources).toBe(10);
    expect(estimate.inputTokens).toBeGreaterThan(0);
  });
});
