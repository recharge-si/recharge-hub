import { describe, expect, it } from "vitest";

import { glossaryConflict, sameTerm } from "~/domain/translations/glossary";
import type { GlossaryTerm } from "~/domain/translations/types";
import { glossaryPrefill, glossaryUrl } from "~/web/lib/translations";

/**
 * Which glossary rules may coexist (docs/translations.md § Glossary): the
 * prompt sends every rule for a language, so two about one term in one
 * language would contradict each other.
 */
const protect = (sourceTerm: string): GlossaryTerm => ({
  kind: "protect",
  sourceTerm,
  targetTerm: null,
  targetLocale: null,
});

const translate = (
  sourceTerm: string,
  targetTerm: string,
  targetLocale: string | null,
): GlossaryTerm => ({
  kind: "translate",
  sourceTerm,
  targetTerm,
  targetLocale,
});

describe("sameTerm", () => {
  it("ignores case and surrounding space", () => {
    expect(sameTerm("Boom", " boom ")).toBe(true);
    expect(sameTerm("Boom", "Booms")).toBe(false);
  });
});

describe("glossaryConflict", () => {
  it("lets different terms and different languages coexist", () => {
    const existing = [
      protect("Patrik"),
      translate("Boom", "Gabelbaum", "de"),
      translate("Mast", "Mât", "fr"),
    ];
    expect(glossaryConflict(existing, translate("Boom", "Boma", "sl"))).toBe(
      null,
    );
    expect(glossaryConflict(existing, protect("Duotone"))).toBe(null);
    expect(glossaryConflict([], translate("Boom", "Gabelbaum", null))).toBe(
      null,
    );
  });

  it("refuses any rule for a protected term", () => {
    const existing = [protect("Patrik")];
    expect(glossaryConflict(existing, protect("patrik"))).toMatchObject({
      reason: "protected",
    });
    expect(
      glossaryConflict(existing, translate("PATRIK", "Patrick", "de")),
    ).toMatchObject({ reason: "protected", existing: existing[0] });
  });

  it("refuses protecting a term that is translated somewhere", () => {
    const existing = [translate("Boom", "Gabelbaum", "de")];
    expect(glossaryConflict(existing, protect("Boom"))).toMatchObject({
      reason: "translated",
      existing: existing[0],
    });
  });

  it("refuses a second translation for the same language", () => {
    const existing = [translate("Boom", "Gabelbaum", "de")];
    expect(
      glossaryConflict(existing, translate("boom", "Baum", "de")),
    ).toMatchObject({ reason: "same_language" });
  });

  it("treats a rule for every language as a rule for each language", () => {
    const everywhere = [translate("Boom", "Boom", null)];
    expect(
      glossaryConflict(everywhere, translate("Boom", "Gabelbaum", "de")),
    ).toMatchObject({ reason: "same_language" });
    const german = [translate("Boom", "Gabelbaum", "de")];
    expect(
      glossaryConflict(german, translate("Boom", "Boom", null)),
    ).toMatchObject({ reason: "same_language" });
  });

  it("does not see a rule as conflicting with itself once excluded", () => {
    const rule = translate("Boom", "Gabelbaum", "de");
    const others = [rule].filter((row) => row !== rule);
    expect(glossaryConflict(others, { ...rule, targetTerm: "Baum" })).toBe(
      null,
    );
  });
});

describe("opening the overrides dialog from Store context", () => {
  it("round-trips a term, its translation and its language through the address", () => {
    const url = glossaryUrl({ sourceTerm: "Foil", targetTerm: "Hidrokrilo", targetLocale: "sl" });
    expect(url).toBe("/app/translations/glossary?term=Foil&translation=Hidrokrilo&locale=sl");
    expect(glossaryPrefill(new URL(`https://x.test${url}`).searchParams)).toEqual({
      sourceTerm: "Foil",
      targetTerm: "Hidrokrilo",
      targetLocale: "sl",
    });
    expect(glossaryUrl({ sourceTerm: "Wing" })).toBe("/app/translations/glossary?term=Wing");
  });

  it("opens nothing without a term, and drops a locale that is not one", () => {
    expect(glossaryPrefill(new URLSearchParams(""))).toBeNull();
    expect(glossaryPrefill(new URLSearchParams("translation=x&locale=sl"))).toBeNull();
    expect(glossaryPrefill(new URLSearchParams("term=Foil&locale=not%20a%20locale"))).toEqual({
      sourceTerm: "Foil",
      targetTerm: "",
      targetLocale: "",
    });
  });
});
