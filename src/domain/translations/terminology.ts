import { compareCodepoints } from "~/domain/types";
import type { StoreProfile, TermClassification } from "~/domain/translations/profile";
import { flattenMenu, type StoreSnapshot } from "~/domain/translations/snapshot";
import {
  isAllCaps,
  isCapitalised,
  looksLikeCode,
  normaliseTerm,
  stripHtml,
  wordsOf,
} from "~/domain/translations/text";
import type { SourceField } from "~/domain/translations/types";

/**
 * Automatic terminology (docs/translations.md § Automatic terminology): the
 * words that carry weight in *this* store, found in the store's own data
 * and classified by how they are used there — a vendor is a brand, a
 * product type is a product family, a menu label is a category, a token
 * that recurs across product titles is a term of the trade.
 *
 * Nothing here is a list of words for any industry. "Wing" is a category in
 * a store whose menu says so and whose products repeat it; in a store of
 * aircraft parts the same code classifies it from that store's data. The
 * output is evidence for the translation model, not a rule to protect: a
 * term is shown with what it is here, and the model chooses the target
 * market's established form for that thing.
 */

export interface TermCandidate {
  /** The most common spelling seen. */
  term: string;
  normalised: string;
  classification: TermClassification;
  /** 0..1; how sure the classification is, from the kind and weight of evidence. */
  confidence: number;
  /** Where it was seen and how often: `{ vendor: 12, productTitle: 80, menu: 1 }`. */
  evidence: Record<string, number>;
  occurrences: number;
}

/** A stored term as the engine reads it back. */
export interface StoredTerm {
  id: string;
  term: string;
  normalised: string;
  classification: TermClassification;
  confidence: number;
  evidence: Record<string, number>;
}

const CONFIDENCE = {
  vendorSeveral: 0.99,
  vendorOne: 0.97,
  productType: 0.9,
  menuLabel: 0.92,
  collectionTitle: 0.9,
  profileTerm: 0.8,
  profileList: 0.75,
  tag: 0.7,
  optionName: 0.8,
  optionValue: 0.6,
  titleToken: 0.55,
} as const;

/** How many products a title token must recur in before it counts as vocabulary. */
const MIN_TITLE_DOCUMENTS = 3;
/** A token in more than this share of titles is filler for the store, not a term. */
const MAX_TITLE_SHARE = 0.6;
/** Caps the stored vocabulary; the least supported candidates fall off. */
export const MAX_TERMS = 600;

function saturate(base: number, count: number, perCount: number, cap: number): number {
  return Math.min(cap, base + count * perCount);
}

class Candidates {
  private readonly byKey = new Map<string, TermCandidate & { spellings: Map<string, number> }>();

  add(term: string, classification: TermClassification, confidence: number, source: string, count = 1): void {
    const display = term.trim();
    const key = normaliseTerm(display);
    // A bare number or a size ("5.0", "12,5") is a value, not a term.
    if (key === "" || key.length < 2 || /^\p{N}+([.,]\p{N}+)*$/u.test(key)) return;
    const existing = this.byKey.get(key);
    if (!existing) {
      this.byKey.set(key, {
        term: display,
        normalised: key,
        classification,
        confidence,
        evidence: { [source]: count },
        occurrences: count,
        spellings: new Map([[display, count]]),
      });
      return;
    }
    existing.evidence[source] = (existing.evidence[source] ?? 0) + count;
    existing.occurrences += count;
    existing.spellings.set(display, (existing.spellings.get(display) ?? 0) + count);
    // Corroboration: a second kind of evidence lifts confidence; the most
    // confident classification names the term.
    if (confidence > existing.confidence) {
      existing.classification = classification;
      existing.confidence = confidence;
    }
    existing.confidence = Math.min(0.99, existing.confidence + 0.02);
  }

  has(term: string): boolean {
    return this.byKey.has(normaliseTerm(term));
  }

  list(): TermCandidate[] {
    return [...this.byKey.values()]
      .map((entry) => {
        let best = entry.term;
        let bestCount = -1;
        for (const [spelling, count] of entry.spellings) {
          if (count > bestCount || (count === bestCount && compareCodepoints(spelling, best) < 0)) {
            best = spelling;
            bestCount = count;
          }
        }
        return {
          term: best,
          normalised: entry.normalised,
          classification: entry.classification,
          confidence: Math.round(entry.confidence * 100) / 100,
          evidence: entry.evidence,
          occurrences: entry.occurrences,
        };
      })
      .sort(
        (a, b) =>
          b.confidence - a.confidence ||
          b.occurrences - a.occurrences ||
          compareCodepoints(a.normalised, b.normalised),
      )
      .slice(0, MAX_TERMS);
  }
}

/** The classification a profile's list implies for the words in it. */
const PROFILE_LISTS: Array<{ key: "likelyBrands" | "productFamilies" | "technicalVocabulary"; classification: TermClassification }> = [
  { key: "likelyBrands", classification: "brand" },
  { key: "productFamilies", classification: "product_family" },
  { key: "technicalVocabulary", classification: "technical" },
];

/**
 * Every term the store's data supports, classified and weighted. The
 * profile, when there is one, adds the model's reading of the same data;
 * the deterministic evidence and the model's agree on most terms and the
 * agreement is what lifts them to near-certainty.
 */
export function discoverTerminology(snapshot: StoreSnapshot, profile: StoreProfile | null): TermCandidate[] {
  const candidates = new Candidates();

  if (snapshot.shopName) candidates.add(snapshot.shopName, "brand", CONFIDENCE.vendorSeveral, "shop");

  const vendorCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  const tagCounts = new Map<string, { value: string; count: number }>();
  const optionValueCounts = new Map<string, { value: string; count: number }>();
  const optionNames = new Map<string, { value: string; count: number }>();
  for (const product of snapshot.products) {
    if (product.vendor?.trim()) vendorCounts.set(product.vendor.trim(), (vendorCounts.get(product.vendor.trim()) ?? 0) + 1);
    if (product.productType?.trim())
      typeCounts.set(product.productType.trim(), (typeCounts.get(product.productType.trim()) ?? 0) + 1);
    for (const tag of new Set(product.tags.map((t) => t.trim()).filter((t) => t !== ""))) {
      const entry = tagCounts.get(normaliseTerm(tag)) ?? { value: tag, count: 0 };
      entry.count += 1;
      tagCounts.set(normaliseTerm(tag), entry);
    }
    for (const option of product.options) {
      const nameKey = normaliseTerm(option.name);
      if (nameKey !== "") {
        const entry = optionNames.get(nameKey) ?? { value: option.name.trim(), count: 0 };
        entry.count += 1;
        optionNames.set(nameKey, entry);
      }
      for (const value of new Set(option.values.map((v) => v.trim()).filter((v) => v !== ""))) {
        const entry = optionValueCounts.get(normaliseTerm(value)) ?? { value, count: 0 };
        entry.count += 1;
        optionValueCounts.set(normaliseTerm(value), entry);
      }
    }
  }

  for (const [vendor, count] of vendorCounts)
    candidates.add(vendor, "brand", count > 1 ? CONFIDENCE.vendorSeveral : CONFIDENCE.vendorOne, "vendor", count);
  for (const [type, count] of typeCounts)
    candidates.add(type, "product_family", saturate(CONFIDENCE.productType, count, 0.0005, 0.98), "productType", count);

  for (const menu of snapshot.menus) {
    for (const item of flattenMenu(menu.items)) {
      const key = normaliseTerm(item.title);
      const corroborated = typeCounts.has(item.title) || tagCounts.has(key);
      candidates.add(item.title, "category", CONFIDENCE.menuLabel + (corroborated ? 0.04 : 0), "menu");
    }
  }
  for (const collection of snapshot.collections) {
    if (collection.title.trim() === "") continue;
    const lift = Math.min(0.05, (collection.productsCount ?? 0) / 500);
    candidates.add(collection.title, "category", CONFIDENCE.collectionTitle + lift, "collection");
  }
  for (const tag of tagCounts.values()) {
    if (tag.count < 2) continue;
    candidates.add(tag.value, "attribute", saturate(CONFIDENCE.tag, tag.count, 0.002, 0.9), "tag", tag.count);
  }
  for (const option of optionNames.values())
    candidates.add(option.value, "generic", CONFIDENCE.optionName, "optionName", option.count);
  for (const value of optionValueCounts.values()) {
    if (value.count < 3) continue;
    candidates.add(value.value, "attribute", saturate(CONFIDENCE.optionValue, value.count, 0.005, 0.85), "optionValue", value.count);
  }

  addTitleTokens(snapshot, candidates, optionValueCounts);

  if (profile) {
    for (const entry of profile.importantTerminology)
      candidates.add(entry.term, entry.classification, CONFIDENCE.profileTerm, "profile");
    for (const list of PROFILE_LISTS)
      for (const term of profile[list.key]) candidates.add(term, list.classification, CONFIDENCE.profileList, "profile");
    for (const abbreviation of profile.commonAbbreviations)
      candidates.add(abbreviation.abbreviation, "abbreviation", CONFIDENCE.profileTerm, "profile");
  }

  return candidates.list();
}

/**
 * Tokens that recur across product titles. Capitalised words and all-caps
 * tokens are the ones a title singles out; a word that is nearly every
 * title's is filler. Bigrams of consecutive capitalised words catch
 * two-word families ("Wing Foil", "Carbon Mast").
 */
function addTitleTokens(
  snapshot: StoreSnapshot,
  candidates: Candidates,
  optionValues: ReadonlyMap<string, { value: string; count: number }>,
): void {
  const titles = snapshot.products.map((p) => stripHtml(p.title)).filter((t) => t !== "");
  if (titles.length === 0) return;
  const documents = new Map<string, { value: string; count: number }>();
  for (const title of titles) {
    const words = wordsOf(title);
    const seen = new Set<string>();
    const note = (token: string) => {
      const key = normaliseTerm(token);
      if (key === "" || seen.has(key)) return;
      seen.add(key);
      const entry = documents.get(key) ?? { value: token, count: 0 };
      entry.count += 1;
      documents.set(key, entry);
    };
    words.forEach((word, index) => {
      if (!isNotable(word)) return;
      note(word);
      const next = words[index + 1];
      if (next && isNotable(next) && !looksLikeCode(word) && !looksLikeCode(next)) note(`${word} ${next}`);
    });
  }
  for (const [key, entry] of documents) {
    if (entry.count < MIN_TITLE_DOCUMENTS) continue;
    if (entry.count / titles.length > MAX_TITLE_SHARE) continue;
    if (candidates.has(key)) {
      // Already a vendor, type, label or tag: the titles corroborate it.
      candidates.add(entry.value, "generic", 0, "productTitle", entry.count);
      continue;
    }
    if (optionValues.has(key)) {
      candidates.add(entry.value, "attribute", saturate(CONFIDENCE.optionValue, entry.count, 0.01, 0.85), "productTitle", entry.count);
      continue;
    }
    const token = entry.value;
    if (!token.includes(" ") && looksLikeCode(token))
      candidates.add(token, "model", saturate(0.85, entry.count, 0.005, 0.98), "productTitle", entry.count);
    else if (!token.includes(" ") && isAllCaps(token) && token.length <= 5)
      candidates.add(token, "abbreviation", saturate(0.8, entry.count, 0.01, 0.96), "productTitle", entry.count);
    else candidates.add(token, "technical", saturate(CONFIDENCE.titleToken, entry.count, 0.025, 0.96), "productTitle", entry.count);
  }
}

/** A title word worth counting: capitalised or a code, and not a two-letter filler word. */
function isNotable(word: string): boolean {
  if (/^\p{N}+([.,]\p{N}+)?$/u.test(word)) return false;
  if (looksLikeCode(word)) return true;
  if (isAllCaps(word)) return word.length >= 2;
  if (!isCapitalised(word)) return false;
  return word.length >= 4;
}

/**
 * The stored terms that appear in a set of fields, most relevant first: a
 * field that *is* the term (a menu label, an option value) outranks a term
 * mentioned inside a description, and within each rank confidence decides.
 * Capped, because the point is a compact block, not the whole vocabulary.
 */
export function relevantTerms<T extends Pick<StoredTerm, "normalised" | "confidence">>(
  fields: readonly SourceField[],
  terms: readonly T[],
  cap = 40,
): T[] {
  if (terms.length === 0 || fields.length === 0) return [];
  const byKey = new Map<string, T>();
  for (const term of terms) byKey.set(term.normalised, term);
  const wholeField = new Set<string>();
  const mentioned = new Set<string>();
  for (const field of fields) {
    const text = stripHtml(field.value);
    const whole = normaliseTerm(text);
    if (byKey.has(whole)) wholeField.add(whole);
    const words = wordsOf(text);
    for (let i = 0; i < words.length; i += 1) {
      for (let n = 1; n <= 3 && i + n <= words.length; n += 1) {
        const key = normaliseTerm(words.slice(i, i + n).join(" "));
        if (byKey.has(key) && !wholeField.has(key)) mentioned.add(key);
      }
    }
  }
  const rank = (key: string) => (wholeField.has(key) ? 0 : 1);
  return [...new Set([...wholeField, ...mentioned])]
    .map((key) => byKey.get(key)!)
    .sort(
      (a, b) =>
        rank(a.normalised) - rank(b.normalised) ||
        b.confidence - a.confidence ||
        compareCodepoints(a.normalised, b.normalised),
    )
    .slice(0, cap);
}

/**
 * Classifications whose members conventionally keep their form across
 * languages — a brand, a model code, an abbreviation. Used by validation to
 * judge an unchanged translation, never to forbid a change: a target market
 * may still have its own established form, and the model decides that.
 */
export const FORM_STABLE_CLASSIFICATIONS: ReadonlySet<TermClassification> = new Set([
  "brand",
  "model",
  "abbreviation",
]);
