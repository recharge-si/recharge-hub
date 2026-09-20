import { describe, expect, it } from "vitest";

import { renderResourceContext } from "~/domain/translations/context";
import {
  buildDetectionMessages,
  confidenceCap,
  describeConfidence,
  detectionSample,
  parseDetectionReply,
} from "~/domain/translations/detection";
import { languageOf, localeChain, sameLanguage } from "~/domain/translations/locale";
import { planResource } from "~/domain/translations/plan";
import {
  TRANSLATION_PROMPT_VERSION,
  buildCorrectionMessages,
  buildTranslationMessages,
  type TranslationRequest,
} from "~/domain/translations/prompt";
import {
  parseProfileReply,
  profileSummary,
  renderStoreContext,
  type StoreProfile,
} from "~/domain/translations/profile";
import { resolveSourceLocale } from "~/domain/translations/source";
import { discoverTerminology, relevantTerms } from "~/domain/translations/terminology";
import type { SourceField } from "~/domain/translations/types";
import { validateTranslation } from "~/domain/translations/validate";
import { WATERSPORTS_MENU, watersportsStore } from "../fixtures/translations/snapshots";

/**
 * The source locale, language detection, resource context and the prompt
 * (docs/translations.md § Source language, § Resource context, § The
 * prompt): what the model is told, and that it is told the truth.
 */

function field(key: string, value: string, type = "STRING"): SourceField {
  return { key, value, digest: `d-${key}`, type };
}

describe("resolveSourceLocale", () => {
  it("prefers a person's override, then Shopify's content locale, then the primary", () => {
    expect(resolveSourceLocale({ primaryLocale: "sl", shopifyContentLocale: "sl", override: "en", detected: null })).toEqual({
      locale: "en",
      reason: "override",
      disputedBy: null,
    });
    expect(resolveSourceLocale({ primaryLocale: "sl", shopifyContentLocale: "en", override: null, detected: null })).toEqual({
      locale: "en",
      reason: "shopify_content",
      disputedBy: null,
    });
    expect(resolveSourceLocale({ primaryLocale: "sl", shopifyContentLocale: "sl", override: null, detected: null })).toEqual({
      locale: "sl",
      reason: "primary",
      disputedBy: null,
    });
    expect(resolveSourceLocale({ primaryLocale: "sl", shopifyContentLocale: null, override: "", detected: null }).locale).toBe("sl");
  });

  it("carries a disagreeing detection without acting on it", () => {
    const resolved = resolveSourceLocale({ primaryLocale: "sl", shopifyContentLocale: "sl", override: null, detected: "en" });
    expect(resolved).toEqual({ locale: "sl", reason: "primary", disputedBy: "en" });
    expect(resolveSourceLocale({ primaryLocale: "sl", shopifyContentLocale: null, override: "en", detected: "en-GB" }).disputedBy).toBeNull();
  });

  it("never lets the prompt say a language is translated into itself", () => {
    // A resource written in the target language is copied by the planner
    // and never reaches the prompt.
    const source = resolveSourceLocale({ primaryLocale: "en", shopifyContentLocale: null, override: "sl", detected: null });
    const decisions = planResource({
      fields: [field("title", "Rabljeno")],
      translations: [],
      ownership: [],
      hash: (v) => v,
      mode: "missing",
      policy: "update_ai_managed",
      sourceLocale: source.locale,
      targetLocale: "sl",
    });
    expect(decisions[0]?.kind).toBe("copy_source");
    const messages = buildTranslationMessages(request({ sourceLocale: "en", targetLocale: "sl" }));
    expect(messages[0]?.content).toContain("from English (en) into Slovenian (sl)");
    expect(messages[0]?.content).not.toContain("Slovenian (sl) into Slovenian");
  });
});

describe("locales", () => {
  it("falls back from a regional locale to its language", () => {
    expect(localeChain("de-AT")).toEqual(["de-AT", "de"]);
    expect(localeChain("zh-Hant-TW")).toEqual(["zh-Hant-TW", "zh-Hant", "zh"]);
    expect(localeChain("sl")).toEqual(["sl"]);
    expect(languageOf("pt-BR")).toBe("pt");
    expect(sameLanguage("pt-BR", "pt-PT")).toBe(true);
    expect(sameLanguage("sl", "hr")).toBe(false);
  });
});

describe("language detection", () => {
  it("caps confidence by how much text there was", () => {
    expect(confidenceCap("Foil")).toBe(0.45);
    expect(confidenceCap("SUP")).toBe(0.2);
    expect(confidenceCap("Neoprene Suits")).toBe(0.6);
    expect(confidenceCap("The lightest front wing we have ever made")).toBe(0.8);
    expect(confidenceCap("A".repeat(3))).toBe(0.2);
    expect(confidenceCap(Array.from({ length: 30 }, () => "beseda").join(" "))).toBe(1);
  });

  it("reads the reply, calibrates it and says so in words", () => {
    const short = parseDetectionReply('{"locale":"en","confidence":0.99}', "Foil");
    expect(short).toEqual({ locale: "en", confidence: 0.45, reportedConfidence: 0.99, shortSample: true });
    const none = parseDetectionReply('{"locale":"sl"}', "Foil");
    expect(none?.confidence).toBe(0.45);
    const long = parseDetectionReply('{"locale":"sl","confidence":0.7}', Array.from({ length: 30 }, () => "beseda").join(" "));
    expect(long).toMatchObject({ confidence: 0.7, shortSample: false });
    expect(describeConfidence(0.45)).toBe("possibly");
    expect(describeConfidence(0.2)).toBe("hard to tell from so little text");
    expect(describeConfidence(0.9)).toBe("very likely");
  });

  it("gives the model the store's language and the neighbouring text", () => {
    const sample = detectionSample([{ value: "<p>Foil</p>" }]);
    expect(sample).toBe("Foil");
    const messages = buildDetectionMessages(sample, {
      storeLocale: "en",
      candidateLocales: ["en", "sl", "de"],
      neighbourText: ["Windsurf", "Wing", "SUP"],
    });
    const system = messages[0]?.content ?? "";
    expect(system).toContain("content language is English (en)");
    expect(system).toContain("Slovenian (sl)");
    expect(system).toContain('"Windsurf", "Wing", "SUP"');
    expect(system).toContain("low confidence");
    expect(messages[1]?.content).toBe("TEXT:\nFoil");
  });
});

describe("renderResourceContext", () => {
  it("places a menu link among its siblings", () => {
    const text = renderResourceContext(
      {
        kind: "menu_item",
        menuTitle: "Main menu",
        parents: [],
        siblings: WATERSPORTS_MENU,
        children: ["Wings", "Boards"],
        linksTo: "collection",
      },
      { kind: "Menu link", title: "Wing" },
    );
    expect(text).toContain("Resource type: Menu link");
    expect(text).toContain("Title: Wing");
    expect(text).toContain("Menu: Main menu");
    expect(text).toContain("Parent: none (top level)");
    expect(text).toContain("Items at this level, in order: All Products · Windsurf · Wing · Foil · SUP · Kite");
    expect(text).toContain("Sub-items of this item: Wings · Boards");
    expect(text).toContain("Links to: a collection");
  });

  it("describes a product, an option value, a collection, an article and a metafield", () => {
    expect(
      renderResourceContext(
        {
          kind: "product",
          vendor: "Duotone",
          productType: "Wing",
          tags: ["wing", "wingfoil"],
          collections: ["Wing", "New"],
          options: [{ name: "Size", values: ["3.0", "4.0"] }],
        },
        { kind: "Product", title: "Duotone Unit" },
      ),
    ).toBe(
      [
        "Resource type: Product",
        "Title: Duotone Unit",
        "Vendor: Duotone",
        "Product type: Wing",
        "In collections: Wing · New",
        "Tags: wing · wingfoil",
        "Options: Size (3.0 · 4.0)",
      ].join("\n"),
    );
    expect(
      renderResourceContext(
        { kind: "product_option_value", productTitle: "Duotone Unit", optionName: "Size", siblingValues: ["3.0", "4.0"] },
        { kind: "Option value", title: "5.0" },
      ),
    ).toContain("Option: Size");
    expect(
      renderResourceContext(
        { kind: "collection", productsCount: 24, sampleProducts: ["Duotone Unit", "F-One Strike"] },
        { kind: "Collection", title: "Wing" },
      ),
    ).toContain("Some of its products: Duotone Unit · F-One Strike");
    expect(renderResourceContext({ kind: "article", blogTitle: "Spot guide" }, { kind: "Article", title: "Bol" })).toContain(
      "Blog: Spot guide",
    );
    expect(
      renderResourceContext(
        {
          kind: "metafield",
          ownerTitle: "Duotone Unit",
          ownerKind: "product",
          namespace: "specs",
          key: "material",
          definitionName: "Material",
          definitionDescription: "The canopy material.",
        },
        { kind: "Metafield", title: null },
      ),
    ).toContain('Belongs to: product "Duotone Unit"\nField: Material\nField description: The canopy material.');
    expect(renderResourceContext({ kind: "none" }, { kind: "Page", title: "About us" })).toBe(
      "Resource type: Page\nTitle: About us",
    );
  });
});

const PROFILE: StoreProfile = {
  storeDescription: "A specialist watersports retailer selling windsurf, wing foil, SUP and kite equipment.",
  industries: ["watersports", "windsurfing", "wing foiling", "SUP", "kitesurfing"],
  audience: "Riders of every level on the Adriatic coast.",
  importantTerminology: [
    { term: "Wing", meaning: "the wing foiling discipline and its hand-held wings", classification: "discipline" },
    { term: "Foil", meaning: "hydrofoil equipment", classification: "product_family" },
    { term: "SUP", meaning: "stand-up paddleboarding", classification: "abbreviation" },
  ],
  likelyBrands: ["Duotone", "Fanatic", "Severne", "Starboard", "F-One", "ION"],
  productFamilies: ["Wings", "Foil boards", "Sails", "Masts", "Neoprene suits"],
  technicalVocabulary: ["freeride", "wave", "camber", "RDM"],
  commonAbbreviations: [{ abbreviation: "SUP", meaning: "stand-up paddleboard" }, { abbreviation: "RDM", meaning: "reduced diameter mast" }],
  localisationNotes: "Discipline names are used as international terms by Slovenian riders.",
};

function request(partial: Partial<TranslationRequest>): TranslationRequest {
  return {
    sourceLocale: "en",
    targetLocale: "sl",
    resourceKind: "Menu link",
    resourceTitle: "Wing",
    fields: [field("title", "Wing")],
    glossary: [],
    storeName: "Recharge Watersports",
    storeContext: null,
    resourceContext: null,
    terminology: [],
    memoryHints: [],
    ...partial,
  };
}

describe("the translation prompt", () => {
  it("instructs a localisation specialist, not a dictionary, and names no industry of its own", () => {
    const messages = buildTranslationMessages(request({ storeName: null }));
    const system = messages[0]?.content ?? "";
    expect(system).toContain("professional e-commerce localisation specialist");
    expect(system).toContain("You are not a dictionary");
    expect(system).toContain("everyday meaning and a specialised meaning");
    expect(system).toContain("do not translate a technical term merely because a dictionary offers a word for it");
    expect(system).toContain("Never leave ordinary words in the source language");
    expect(system).toContain("TERMINOLOGY OVERRIDES given with a request are the merchant's explicit rules and take precedence");
    expect(system).toContain("never invent product claims");
    expect(system).toContain("Placeholders such as {{name}}");
    expect(system).toContain("URLs, e-mail addresses");
    // Nothing about any particular industry is built in.
    expect(system).not.toMatch(/windsurf|wing|foil|kite|watersport/i);
    expect(TRANSLATION_PROMPT_VERSION).toMatch(/^translate-v\d+$/);
  });

  it("carries the store, the resource, the overrides, the memory and the terminology, in that order of authority", () => {
    const terms = discoverTerminology(watersportsStore(), PROFILE).map((term, index) => ({ ...term, id: `t${index}` }));
    const fields = [field("title", "Wing")];
    const relevant = relevantTerms(fields, terms);
    const messages = buildTranslationMessages(
      request({
        fields,
        storeContext: renderStoreContext(PROFILE, "Recharge Watersports"),
        resourceContext: {
          kind: "menu_item",
          menuTitle: "Main menu",
          parents: [],
          siblings: WATERSPORTS_MENU,
          children: [],
          linksTo: "collection",
        },
        glossary: [{ kind: "translate", targetLocale: "sl", sourceTerm: "Foil", targetTerm: "Hidrokrilo" }],
        memoryHints: [{ id: "m", sourceText: "Used", targetText: "Rabljeno", origin: "manual" }],
        terminology: relevant.map((term) => ({ term: term.term, classification: term.classification, evidence: "menu label, collection title" })),
      }),
    );
    const system = messages[0]?.content ?? "";
    const user = messages[1]?.content ?? "";
    expect(system).toContain("STORE CONTEXT");
    expect(system).toContain("Industries: watersports, windsurfing, wing foiling, SUP, kitesurfing.");
    expect(system).toContain("Brands sold here (never translated): Duotone");
    expect(system).toContain("- Wing (discipline or sport): the wing foiling discipline");
    expect(user).toContain("RESOURCE CONTEXT\nResource type: Menu link\nTitle: Wing\nMenu: Main menu");
    expect(user).toContain("Items at this level, in order: All Products · Windsurf · Wing · Foil · SUP · Kite · Neoprene Suits · Clothing · Other · Used");
    expect(user.indexOf("TERMINOLOGY OVERRIDES")).toBeLessThan(user.indexOf("ESTABLISHED TRANSLATIONS"));
    expect(user.indexOf("ESTABLISHED TRANSLATIONS")).toBeLessThan(user.indexOf("STORE TERMINOLOGY"));
    expect(user.indexOf("STORE TERMINOLOGY")).toBeLessThan(user.indexOf("FIELDS"));
    expect(user).toContain('"Foil" → "Hidrokrilo"');
    expect(user).toContain('"Used" → "Rabljeno" (confirmed by the merchant)');
    expect(user).toContain("- Wing: category (menu label, collection title)");
    expect(user).toContain("Field 1 (title, text):\nWing");
  });

  it("the correction request names each broken invariant against its field", () => {
    const req = request({ fields: [field("title", "All Products"), field("label", "Duotone")] });
    const messages = buildCorrectionMessages(req, '{"translations":{"1":"All Products","2":"Duotone"}}', [
      { key: "title", code: "unchanged", severity: "hard", message: '"All Products" came back unchanged.' },
    ]);
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[3]?.content).toContain("Field 1:\n  - \"All Products\" came back unchanged.");
    expect(messages[3]?.content).not.toContain("Field 2:");
  });
});

describe("the watersports navigation", () => {
  /**
   * The behaviour the engine is for: given this store, these labels and the
   * context the engine builds, the expected Slovenian passes every check
   * and the dictionary rendering does not survive. The expected values are
   * the test's, never the code's.
   */
  const expected: Record<string, string> = {
    "All Products": "Vsi izdelki",
    Windsurf: "Windsurf",
    Wing: "Wing",
    Foil: "Foil",
    SUP: "SUP",
    Kite: "Kite",
    "Neoprene Suits": "Neoprenske obleke",
    Clothing: "Oblačila",
    Other: "Drugo",
    Used: "Rabljeno",
  };
  const terms = discoverTerminology(watersportsStore(), PROFILE).map((term, index) => ({ ...term, id: `t${index}` }));

  it("gives every label the context that disambiguates it, and accepts the domain-aware answer", () => {
    for (const label of WATERSPORTS_MENU) {
      const fields = [field("title", label)];
      const relevant = relevantTerms(fields, terms);
      const req = request({
        fields,
        resourceTitle: label,
        storeContext: renderStoreContext(PROFILE, "Recharge Watersports"),
        resourceContext: { kind: "menu_item", menuTitle: "Main menu", parents: [], siblings: WATERSPORTS_MENU, children: [], linksTo: "collection" },
        terminology: relevant.map((term) => ({ term: term.term, classification: term.classification, evidence: null })),
      });
      const user = buildTranslationMessages(req)[1]?.content ?? "";
      // Every label is read beside its siblings, never alone.
      expect(user).toContain("Windsurf · Wing · Foil · SUP · Kite");
      // The disciplines arrive with what they are in this store.
      if (["Windsurf", "Wing", "Foil", "SUP", "Kite"].includes(label)) expect(user).toContain(`- ${label}: category`);

      const stable = [
        ...relevant.filter((t) => ["brand", "model", "abbreviation"].includes(t.classification)).map((t) => t.term),
        "Recharge Watersports",
      ];
      const violations = validateTranslation(fields, new Map([["title", expected[label]!]]), {
        sourceLocale: "en",
        targetLocale: "sl",
        glossary: [],
        formStableTerms: stable,
      });
      // The disciplines kept as they are pass with at most a soft doubt; the
      // ordinary labels translated pass clean.
      expect(violations.filter((v) => v.severity === "hard"), label).toEqual([]);
    }
  });

  it("refuses the answer where ordinary labels were left in English", () => {
    const violations = validateTranslation([field("title", "All Products")], new Map([["title", "All Products"]]), {
      sourceLocale: "en",
      targetLocale: "sl",
      glossary: [],
      formStableTerms: [],
    });
    expect(violations.map((v) => `${v.code}:${v.severity}`)).toEqual(["unchanged:hard"]);
  });

  it("the profile reply is read strictly and summarised", () => {
    const parsed = parseProfileReply(JSON.stringify(PROFILE));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(profileSummary(parsed.profile)).toBe("watersports · windsurfing · wing foiling · SUP · kitesurfing");
      expect(renderStoreContext(parsed.profile, null)).toContain("Abbreviations: SUP = stand-up paddleboard; RDM = reduced diameter mast.");
    }
    expect(parseProfileReply("not json").ok).toBe(false);
    expect(parseProfileReply('{"industries":["x"]}').ok).toBe(false);
  });
});
