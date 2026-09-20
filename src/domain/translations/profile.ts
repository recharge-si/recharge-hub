import { z } from "zod";

import { renderStoreSample, type StoreSample } from "~/domain/translations/snapshot";
import { clip } from "~/domain/translations/text";
import type { ChatMessage } from "~/domain/translations/types";

/**
 * The store translation profile (docs/translations.md § Store profile):
 * what kind of store this is, inferred once from a sample of its own
 * content and then shown to the translation model with every request so a
 * one-word menu label is read the way a shopper of this store reads it.
 *
 * Pure: the prompt that asks for it, the strict parser that reads the
 * answer, and the compact rendering the translation prompt carries. Nothing
 * here knows which store it is talking about.
 */

/** Bumped whenever the profile prompt or shape changes; stored with each profile. */
export const PROFILE_PROMPT_VERSION = "profile-v1";

/** How a term functions in this store's vocabulary. Shared with terminology discovery. */
export const TERM_CLASSIFICATIONS = [
  "brand",
  "model",
  "product_family",
  "category",
  "discipline",
  "technical",
  "abbreviation",
  "material",
  "attribute",
  "generic",
] as const;

export type TermClassification = (typeof TERM_CLASSIFICATIONS)[number];

export const TERM_CLASSIFICATION_LABEL: Record<TermClassification, string> = {
  brand: "Brand",
  model: "Model or code",
  product_family: "Product family",
  category: "Category",
  discipline: "Discipline or sport",
  technical: "Technical term",
  abbreviation: "Abbreviation",
  material: "Material",
  attribute: "Attribute",
  generic: "Store vocabulary",
};

const shortText = z.string().trim().min(1).max(200);

const profileTermSchema = z.object({
  term: shortText,
  meaning: z.string().trim().max(300).optional().default(""),
  classification: z.enum(TERM_CLASSIFICATIONS).optional().default("technical"),
});

export const storeProfileSchema = z.object({
  storeDescription: z.string().trim().min(1).max(600),
  industries: z.array(shortText).max(12).default([]),
  audience: z.string().trim().max(300).optional().default(""),
  importantTerminology: z.array(profileTermSchema).max(80).default([]),
  likelyBrands: z.array(shortText).max(60).default([]),
  productFamilies: z.array(shortText).max(60).default([]),
  technicalVocabulary: z.array(shortText).max(80).default([]),
  commonAbbreviations: z
    .array(z.object({ abbreviation: shortText, meaning: z.string().trim().max(200).default("") }))
    .max(40)
    .default([]),
  localisationNotes: z.string().trim().max(600).optional().default(""),
});

export type StoreProfile = z.infer<typeof storeProfileSchema>;
export type ProfileTerm = z.infer<typeof profileTermSchema>;

export function buildProfileMessages(sample: StoreSample): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are a localisation lead preparing a briefing about an online store for professional translators who have never seen it.",
        "You are given the store's own data: its name, navigation, collections, vendors, product types, tags, options and a sample of product titles. Infer from this what kind of store it is, which industries and disciplines it serves, and which words carry a specialised meaning here.",
        "Focus on terminology that a dictionary would translate wrongly: sport and discipline names, product categories that are established loanwords in the trade, technical components, model families, materials and abbreviations. Include ordinary words only when this store uses them in a specialised sense (for example a common noun that names a discipline or a product category here).",
        "List brands only when the data shows them as vendors or in product names. Do not invent products, brands or claims. Do not include anything about customers or orders.",
        'Answer with one JSON object of exactly this shape: {"storeDescription": string (one or two sentences), "industries": string[], "audience": string, "importantTerminology": [{"term": string, "meaning": string, "classification": one of ' +
          TERM_CLASSIFICATIONS.map((c) => `"${c}"`).join(" | ") +
          '}], "likelyBrands": string[], "productFamilies": string[], "technicalVocabulary": string[], "commonAbbreviations": [{"abbreviation": string, "meaning": string}], "localisationNotes": string (how translators should treat this store\'s vocabulary in general)}.',
        "Keep the terms in the language of the store's content, spelt as the store spells them. Be concise: at most 60 terminology entries, 40 brands, 40 product families, 60 technical words, 30 abbreviations.",
      ].join("\n"),
    },
    { role: "user", content: renderStoreSample(sample) },
  ];
}

export type ParsedProfile = { ok: true; profile: StoreProfile } | { ok: false; reason: string };

export function parseProfileReply(text: string): ParsedProfile {
  let json: unknown;
  try {
    json = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return { ok: false, reason: "The profile reply was not JSON." };
  }
  const parsed = storeProfileSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "The profile reply did not have the expected shape." };
  return { ok: true, profile: dedupe(parsed.data) };
}

function dedupe(profile: StoreProfile): StoreProfile {
  const uniq = (values: string[]) => {
    const seen = new Set<string>();
    return values.filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const seenTerms = new Set<string>();
  return {
    ...profile,
    industries: uniq(profile.industries),
    likelyBrands: uniq(profile.likelyBrands),
    productFamilies: uniq(profile.productFamilies),
    technicalVocabulary: uniq(profile.technicalVocabulary),
    importantTerminology: profile.importantTerminology.filter((entry) => {
      const key = entry.term.toLowerCase();
      if (seenTerms.has(key)) return false;
      seenTerms.add(key);
      return true;
    }),
  };
}

/** "Watersports · Windsurfing · Wing foiling · SUP", for a status line. */
export function profileSummary(profile: StoreProfile): string {
  return profile.industries.slice(0, 5).join(" · ") || clip(profile.storeDescription, 80);
}

/** Limits on what the translation prompt carries; the whole block stays a few hundred tokens. */
const CONTEXT_LIMITS = { brands: 30, families: 30, abbreviations: 25, terminology: 40, technical: 40 } as const;

/**
 * The profile as the translation model reads it with every request: the
 * store in a sentence, its industries, and the vocabulary that matters. The
 * same text for every request of a shop, so the provider can cache it.
 */
export function renderStoreContext(profile: StoreProfile, storeName: string | null): string {
  const lines: string[] = [];
  lines.push(`${storeName ? `"${storeName}" — ` : ""}${profile.storeDescription}`);
  if (profile.industries.length > 0) lines.push(`Industries: ${profile.industries.join(", ")}.`);
  if (profile.audience) lines.push(`Audience: ${profile.audience}`);
  if (profile.likelyBrands.length > 0)
    lines.push(`Brands sold here (never translated): ${profile.likelyBrands.slice(0, CONTEXT_LIMITS.brands).join(", ")}.`);
  if (profile.productFamilies.length > 0)
    lines.push(`Product families: ${profile.productFamilies.slice(0, CONTEXT_LIMITS.families).join(", ")}.`);
  if (profile.commonAbbreviations.length > 0)
    lines.push(
      `Abbreviations: ${profile.commonAbbreviations
        .slice(0, CONTEXT_LIMITS.abbreviations)
        .map((entry) => (entry.meaning ? `${entry.abbreviation} = ${entry.meaning}` : entry.abbreviation))
        .join("; ")}.`,
    );
  if (profile.importantTerminology.length > 0) {
    lines.push("Terminology with a specialised meaning in this store:");
    for (const entry of profile.importantTerminology.slice(0, CONTEXT_LIMITS.terminology)) {
      const label = TERM_CLASSIFICATION_LABEL[entry.classification].toLowerCase();
      lines.push(`- ${entry.term} (${label})${entry.meaning ? `: ${entry.meaning}` : ""}`);
    }
  }
  if (profile.technicalVocabulary.length > 0)
    lines.push(`Other technical vocabulary: ${profile.technicalVocabulary.slice(0, CONTEXT_LIMITS.technical).join(", ")}.`);
  if (profile.localisationNotes) lines.push(`Localisation notes: ${profile.localisationNotes}`);
  return lines.join("\n");
}
