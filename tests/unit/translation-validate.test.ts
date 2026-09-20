import { describe, expect, it } from "vitest";

import type { GlossaryTerm, SourceField } from "~/domain/translations/types";
import {
  hardViolations,
  validateTranslation,
  type ValidationRules,
} from "~/domain/translations/validate";

/**
 * Deterministic validation (docs/translations.md § Validation): what a
 * translation must not have changed, and when "unchanged" is a translation
 * that did not happen.
 */

function field(key: string, value: string, type = "STRING"): SourceField {
  return { key, value, digest: `d-${key}`, type };
}

const rules: ValidationRules = {
  sourceLocale: "en",
  targetLocale: "sl",
  glossary: [],
  formStableTerms: ["Duotone", "SUP", "Wing", "RDM", "F-One"],
};

function check(fields: SourceField[], answers: Record<string, string>, extra: Partial<ValidationRules> = {}) {
  return validateTranslation(fields, new Map(Object.entries(answers)), { ...rules, ...extra });
}

function codes(violations: ReturnType<typeof validateTranslation>): string[] {
  return violations.map((v) => `${v.key}:${v.code}:${v.severity}`);
}

describe("validateTranslation", () => {
  it("passes a clean translation", () => {
    expect(
      check(
        [
          field("title", "Duotone Wing Unit 4.0 D/LAB"),
          field("body_html", '<p>The <strong>Unit</strong> is a 4.0 m² wing. <a href="https://example.com/x">Specs</a></p>', "HTML"),
        ],
        {
          title: "Duotone Wing Unit 4.0 D/LAB",
          body_html: '<p><strong>Unit</strong> je wing s površino 4,0 m². <a href="https://example.com/x">Specifikacije</a></p>',
        },
      ),
    ).toEqual([]);
  });

  it("fails a missing or empty answer", () => {
    expect(codes(check([field("title", "Boom")], {}))).toEqual(["title:missing:hard"]);
    expect(codes(check([field("title", "Boom")], { title: "  " }))).toEqual(["title:empty:hard"]);
  });

  it("keeps placeholders, URLs, numbers and codes", () => {
    const v = check(
      [
        field("a", "Hello {{name}}, your order {0} ships in %d days"),
        field("b", "See https://shop.example/help or write to help@example.com"),
        field("c", "Mast 430 cm, 75% carbon, weighs 1.9 kg"),
        field("d", "Model RS:X and the X-Wing 5.0m kit"),
      ],
      {
        a: "Pozdravljeni {{ime}}, naročilo {0} pošljemo v %d dneh",
        b: "Glejte https://shop.example/pomoc ali pišite na help@example.com",
        c: "Jambor 430 cm, 75 % karbon, teža 1,9 kg",
        d: "Model RSX in komplet X Wing 5,0 m",
      },
    );
    expect(codes(v)).toEqual(["a:placeholders:hard", "b:urls:hard"]);
    // c: "1.9" → "1,9" is a separator change, allowed. d: codes are compared
    // without separators and case, so "RS:X" → "RSX" and "5.0m" → "5,0 m" pass.
    const missingNumber = check([field("c", "Mast 430 cm")], { c: "Jambor 460 cm" });
    expect(codes(missingNumber)).toEqual(["c:numbers:hard"]);
    const missingCode = check([field("d", "Gravity FCT-1800 V2")], { d: "Gravity FCT-1800" });
    expect(codes(missingCode)).toEqual(["d:numbers:hard", "d:codes:hard"]);
    // Ordinals, multipliers and units are not codes: only their digits must survive.
    expect(check([field("e", "The 1st board, 2x lighter, ready in 24h")], { e: "Prva deska (1.), 2-krat lažja, pripravljena v 24 urah" })).toEqual([]);
  });

  it("keeps HTML and rich text structure", () => {
    const html = check([field("b", '<p>A <a href="/x">link</a></p>', "HTML")], {
      b: '<p>Povezava <a href="/y">tukaj</a></p>',
    });
    expect(codes(html)).toEqual(["b:html_structure:hard"]);
    const dropped = check([field("b", "<p>One</p><p>Two</p>", "HTML")], { b: "<p>Ena Dva</p>" });
    expect(codes(dropped)).toEqual(["b:html_structure:hard"]);

    const doc = JSON.stringify({
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "Hello", bold: true }] }],
    });
    const good = JSON.stringify({
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "Pozdravljeni", bold: true }] }],
    });
    const bad = JSON.stringify({
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "Pozdravljeni" }] }],
    });
    expect(check([field("r", doc, "RICH_TEXT_FIELD")], { r: good })).toEqual([]);
    expect(codes(check([field("r", doc, "RICH_TEXT_FIELD")], { r: bad }))).toEqual(["r:rich_text_structure:hard"]);
    expect(codes(hardViolations(check([field("r", doc, "RICH_TEXT_FIELD")], { r: "Pozdravljeni" })))).toEqual([
      "r:rich_text_structure:hard",
    ]);
  });

  it("enforces the merchant's glossary: protected exactly, translate-as in short fields", () => {
    const glossary: GlossaryTerm[] = [
      { kind: "protect", targetLocale: null, sourceTerm: "Patrik", targetTerm: null },
      { kind: "translate", targetLocale: "sl", sourceTerm: "Foil", targetTerm: "Hidrokrilo" },
      { kind: "translate", targetLocale: "de", sourceTerm: "Foil", targetTerm: "Tragflügel" },
    ];
    expect(codes(check([field("t", "Patrik Boards")], { t: "Patrikove deske" }, { glossary }))).toEqual([
      "t:protected_term:hard",
    ]);
    expect(codes(hardViolations(check([field("t", "Foil")], { t: "Foil" }, { glossary })))).toEqual([
      "t:glossary_term:hard",
    ]);
    expect(check([field("t", "Foil")], { t: "Hidrokrilo" }, { glossary })).toEqual([]);
    // Inside a sentence the term may inflect: a doubt, not a defect.
    const prose = check(
      [field("b", "This foil is the lightest front wing we have made for the whole range of boards.")],
      { b: "Sprednje krilo tega hidrokrila je najlažje, ki smo ga naredili za celo paleto desk." },
      { glossary },
    );
    expect(codes(prose)).toEqual(["b:glossary_term:soft"]);
    // The German rule is not applied to Slovenian.
    expect(check([field("t", "Foil")], { t: "Hidrokrilo" }, { glossary })).toEqual([]);
  });

  it("tells a legitimate unchanged term from a translation that did not happen", () => {
    // Established terms of the store come back as they are: fine.
    expect(check([field("t", "Wing")], { t: "Wing" })).toEqual([]);
    expect(check([field("t", "SUP")], { t: "SUP" })).toEqual([]);
    expect(check([field("t", "Duotone")], { t: "Duotone" })).toEqual([]);
    expect(check([field("t", "Duotone Wing 4.0")], { t: "Duotone Wing 4.0" })).toEqual([]);
    // A single ordinary word unchanged is a doubt: it may be the market's form.
    expect(codes(check([field("t", "Clothing")], { t: "Clothing" }))).toEqual(["t:unchanged:soft"]);
    // Two ordinary words unchanged is a translation that did not happen.
    expect(codes(check([field("t", "All Products")], { t: "All Products" }))).toEqual(["t:unchanged:hard"]);
    expect(codes(check([field("t", "Neoprene Suits")], { t: "neoprene suits" }))).toEqual(["t:unchanged:hard"]);
    // A stable term plus one ordinary word: a doubt only.
    expect(codes(check([field("t", "Wing Accessories")], { t: "Wing Accessories" }))).toEqual(["t:unchanged:soft"]);
    // Between variants of one language nothing needs to change.
    expect(check([field("t", "All Products")], { t: "All Products" }, { sourceLocale: "en", targetLocale: "en-GB" })).toEqual([]);
  });

  it("doubts a translation far shorter or longer than its source", () => {
    const long = "A long description of the product that goes on for a while and says many things about it.";
    expect(codes(check([field("b", long)], { b: "Kratko." }))).toEqual(["b:length:soft"]);
    expect(hardViolations(check([field("b", long)], { b: "Kratko." }))).toEqual([]);
  });
});
