import { describe, expect, it } from "vitest";

import {
  buildStoreSample,
  renderStoreSample,
  representativeTitles,
  sampleVocabulary,
  vocabularyOverlap,
} from "~/domain/translations/snapshot";
import {
  discoverTerminology,
  relevantTerms,
  type TermCandidate,
} from "~/domain/translations/terminology";
import type { SourceField } from "~/domain/translations/types";
import {
  aviationStore,
  kitchenStore,
  toyStore,
  watersportsStore,
} from "../fixtures/translations/snapshots";

/**
 * Automatic terminology (docs/translations.md § Automatic terminology): the
 * words that matter in a store are found in the store's own data, and the
 * same word is classified by what it is *here*. No list of any industry's
 * words exists in the code; these tests would fail if one did the work.
 */

function byTerm(terms: readonly TermCandidate[]): Map<string, TermCandidate> {
  return new Map(terms.map((term) => [term.normalised, term]));
}

function field(value: string, key = "title"): SourceField {
  return { key, value, digest: "d", type: "STRING" };
}

describe("terminology discovery", () => {
  it("reads the watersports store's disciplines as categories with high confidence", () => {
    const terms = byTerm(discoverTerminology(watersportsStore(), null));
    for (const word of ["wing", "foil", "sup", "kite", "windsurf"]) {
      const term = terms.get(word);
      expect(term, word).toBeDefined();
      expect(term!.classification, word).toBe("category");
      expect(term!.confidence, word).toBeGreaterThanOrEqual(0.9);
      // Corroborated by more than one kind of evidence.
      expect(Object.keys(term!.evidence).length, word).toBeGreaterThanOrEqual(2);
    }
  });

  it("knows the vendors as brands and the recurring codes as models", () => {
    const terms = byTerm(discoverTerminology(watersportsStore(), null));
    expect(terms.get("duotone")?.classification).toBe("brand");
    expect(terms.get("duotone")?.confidence).toBeGreaterThanOrEqual(0.99);
    expect(terms.get("f-one")?.classification).toBe("brand");
    expect(terms.get("recharge watersports")?.classification).toBe("brand");
    // "RDM" recurs across mast titles: an abbreviation of the trade.
    expect(terms.get("rdm")?.classification).toBe("abbreviation");
    // "Freeride" recurs in titles and tags: a term of the trade, not filler.
    expect(["technical", "attribute"]).toContain(terms.get("freeride")?.classification);
    expect(terms.get("freeride")!.confidence).toBeGreaterThan(0.6);
  });

  it("does not treat title filler or bare numbers as terms", () => {
    const terms = byTerm(discoverTerminology(watersportsStore(), null));
    expect(terms.has("the")).toBe(false);
    expect(terms.has("1800")).toBe(false);
    expect(terms.has("5.0")).toBe(false);
  });

  it("classifies the same word by the store it is in", () => {
    const water = byTerm(discoverTerminology(watersportsStore(), null));
    const aviation = byTerm(discoverTerminology(aviationStore(), null));
    const kitchen = byTerm(discoverTerminology(kitchenStore(), null));
    const toys = byTerm(discoverTerminology(toyStore(), null));

    // "Wing" is a category in both the watersports and the aviation store —
    // each from its own menu and collection — and absent from the kitchen.
    expect(water.get("wing")?.evidence).toMatchObject({ menu: 1, collection: 1 });
    expect(aviation.get("wing")?.evidence).toMatchObject({ menu: 1, collection: 1 });
    expect(kitchen.has("wing")).toBe(false);

    // "Foil" is a watersports category; the kitchen knows "Foil & Film" and
    // "Aluminium Foil", never the bare discipline.
    expect(water.get("foil")?.classification).toBe("category");
    expect(kitchen.has("foil & film")).toBe(true);
    expect(kitchen.get("aluminium foil")?.classification).toBe("technical");

    // A kite is a toy in the toy store's vocabulary, with its own evidence.
    expect(toys.get("kites")?.classification).toBe("category");
    expect(toys.has("windsurf")).toBe(false);
    expect(aviation.has("sup")).toBe(false);
  });

  it("merges the profile's reading of the store with the deterministic evidence", () => {
    const withProfile = byTerm(
      discoverTerminology(watersportsStore(), {
        storeDescription: "Specialist watersports retailer.",
        industries: ["windsurfing", "wing foiling"],
        audience: "",
        importantTerminology: [
          { term: "Wing", meaning: "wing foiling discipline", classification: "discipline" },
          { term: "Boom", meaning: "windsurf component", classification: "technical" },
        ],
        likelyBrands: ["Duotone", "Neil Pryde"],
        productFamilies: [],
        technicalVocabulary: ["camber"],
        commonAbbreviations: [{ abbreviation: "SDM", meaning: "standard diameter mast" }],
        localisationNotes: "",
      }),
    );
    // Corroboration lifts a term the data already knew.
    const without = byTerm(discoverTerminology(watersportsStore(), null));
    expect(withProfile.get("wing")!.confidence).toBeGreaterThanOrEqual(without.get("wing")!.confidence);
    expect(withProfile.get("wing")!.evidence.profile).toBe(1);
    expect(withProfile.get("wing")!.occurrences).toBe(without.get("wing")!.occurrences + 1);
    // A term only the profile named arrives with the profile's confidence.
    expect(withProfile.get("boom")).toMatchObject({ classification: "technical", confidence: 0.8 });
    expect(withProfile.get("neil pryde")).toMatchObject({ classification: "brand" });
    expect(withProfile.get("sdm")).toMatchObject({ classification: "abbreviation" });
  });

  it("is deterministic", () => {
    const a = discoverTerminology(watersportsStore(), null);
    const b = discoverTerminology(watersportsStore(), null);
    expect(a).toEqual(b);
  });
});

describe("relevant terms", () => {
  const terms = discoverTerminology(watersportsStore(), null).map((term, index) => ({
    ...term,
    id: `t${index}`,
  }));

  it("finds the terms in a field, a whole-field match first", () => {
    const relevant = relevantTerms([field("Wing")], terms);
    expect(relevant[0]?.normalised).toBe("wing");
    const inTitle = relevantTerms([field("Duotone Wing Unit 4.0 D/LAB with Carbon Mast")], terms);
    const names = inTitle.map((term) => term.normalised);
    expect(names).toContain("duotone");
    expect(names).toContain("wing");
    expect(names).toContain("carbon mast");
  });

  it("finds nothing for text the store has no words for, and respects the cap", () => {
    expect(relevantTerms([field("Free shipping on every order")], terms)).toEqual([]);
    const many = relevantTerms(
      [field(terms.slice(0, 60).map((term) => term.term).join(" "))],
      terms,
      10,
    );
    expect(many.length).toBeLessThanOrEqual(10);
  });
});

describe("store sample", () => {
  it("is bounded, representative and deterministic", () => {
    const snapshot = watersportsStore();
    const sample = buildStoreSample(snapshot);
    expect(sample.menus[0]?.labels).toEqual([
      "All Products",
      "Windsurf",
      "Wing",
      "Foil",
      "SUP",
      "Kite",
      "Neoprene Suits",
      "Clothing",
      "Other",
      "Used",
    ]);
    // Vendors by product count, ties in codepoint order.
    expect(sample.vendors.slice(0, 2)).toEqual([
      { value: "F-One", count: 24 },
      { value: "Severne", count: 24 },
    ]);
    expect(sample.productTypes.map((type) => type.value)).toContain("Windsurf");
    expect(sample.productTitles.length).toBeLessThanOrEqual(120);
    expect(buildStoreSample(snapshot)).toEqual(sample);

    // Round-robin across product types: the first titles come from
    // different types, not from the biggest one alone.
    const titles = representativeTitles(snapshot.products, 6);
    expect(new Set(titles).size).toBe(6);
    const text = renderStoreSample(sample);
    expect(text).toContain('Navigation menu "Main menu"');
    expect(text).toContain("Vendors:");
    expect(text).not.toMatch(/customer|order|price/i);
  });

  it("measures how much a store has changed by its vocabulary", () => {
    const before = sampleVocabulary(buildStoreSample(watersportsStore()));
    expect(vocabularyOverlap(before, before)).toBe(1);
    expect(vocabularyOverlap(before, sampleVocabulary(buildStoreSample(kitchenStore())))).toBeLessThan(0.1);
    const grown = watersportsStore();
    grown.collections.push({ id: "gid://shopify/Collection/999", title: "Sale", description: null, productsCount: 3 });
    expect(vocabularyOverlap(before, sampleVocabulary(buildStoreSample(grown)))).toBeGreaterThan(0.9);
  });
});
