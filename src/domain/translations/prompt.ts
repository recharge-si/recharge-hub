import { z } from "zod";

import { renderResourceContext, type ResourceContext } from "~/domain/translations/context";
import type { MemoryHint } from "~/domain/translations/memory";
import { TERM_CLASSIFICATION_LABEL, type TermClassification } from "~/domain/translations/profile";
import type { ChatMessage, GlossaryTerm, SourceField } from "~/domain/translations/types";
import type { Violation } from "~/domain/translations/validate";

export type { ChatMessage } from "~/domain/translations/types";

/**
 * What the model is asked, and how its answer is read
 * (docs/translations.md § The prompt).
 *
 * Pure string construction. One request carries every field of one resource
 * for one target language, numbered, and the model answers with JSON keyed
 * by those numbers — so a title and its description are translated with
 * each other in view, and a reply that drops or invents a field is caught by
 * the parser rather than written to Shopify.
 *
 * The request is built in layers, each one narrower than the last: the
 * store (what kind of shop this is), the resource (where the text sits and
 * what sits next to it), the terminology (what the store's words mean and
 * how they have been translated before), then the fields. The system
 * message is the same for every request of a shop and language pair, so a
 * provider that caches prompt prefixes charges for it once.
 */

/** Bumped whenever the instructions change; recorded with every translation. */
export const TRANSLATION_PROMPT_VERSION = "translate-v2";

export interface TerminologyNote {
  term: string;
  classification: TermClassification;
  /** Where the store uses it: "menu label, product type, 48 product titles". */
  evidence: string | null;
}

export interface TranslationRequest {
  sourceLocale: string;
  targetLocale: string;
  /** What the resource is, for context: "Product", "Menu link". */
  resourceKind: string;
  resourceTitle: string | null;
  fields: readonly SourceField[];
  glossary: readonly GlossaryTerm[];
  /** The store's name, so it is never translated. */
  storeName: string | null;
  /** The store profile as `renderStoreContext` writes it; null before one exists. */
  storeContext: string | null;
  resourceContext: ResourceContext | null;
  /** The store's own terms that appear in these fields. */
  terminology: readonly TerminologyNote[];
  /** How this store has translated terms in these fields before. */
  memoryHints: readonly MemoryHint[];
}

const HTML_TYPES: ReadonlySet<string> = new Set(["HTML", "MULTI_LINE_TEXT_FIELD_HTML"]);

function systemMessage(request: TranslationRequest): string {
  const source = `${languageName(request.sourceLocale)} (${request.sourceLocale})`;
  const target = `${languageName(request.targetLocale)} (${request.targetLocale})`;
  const sections: string[] = [];

  sections.push(
    [
      `You are a professional e-commerce localisation specialist. You translate an online store's content from ${source} into ${target}, producing the copy a native ${languageName(request.targetLocale)} localisation team would publish for this store.`,
      "You are not a dictionary. Every string is part of a store: read it as a shopper of this store would, in the place it appears, and write what a shopper in the target market expects to read there.",
    ].join("\n"),
  );

  sections.push(
    [
      "READING THE CONTENT",
      "- Interpret every word from the context supplied: the store profile, the kind of resource, its title, the fields around it, neighbouring labels and the terminology notes. Context decides meaning; the dictionary does not.",
      "- When a word has both an everyday meaning and a specialised meaning in this store's industry, infer which is meant from that context. A one-word category, menu label or option value in a specialist store almost always carries the industry meaning.",
      "- Distinguish brands, model names, SKUs, sizes and technical designations from ordinary prose. Brands, model names and codes stay exactly as written.",
      "- Related fields of one resource (a title, its description, its SEO fields; an option and its values) describe one thing. Keep them consistent with each other.",
    ].join("\n"),
  );

  sections.push(
    [
      "CHOOSING WORDS",
      "- Use the terminology that shoppers and retailers of this industry actually use in the target market. Where the trade conventionally keeps an international or English term unchanged (a discipline, a product category, a component, a material), keep it; do not translate a technical term merely because a dictionary offers a word for it, and do not invent a coinage.",
      "- Where the target market has its own established term, use that term, spelt and capitalised as the market writes it.",
      "- Ordinary e-commerce language — 'All products', 'Used', 'Clothing', 'Add to cart', descriptions, benefits — is localised naturally and idiomatically. Never leave ordinary words in the source language.",
      "- Keep the register and tone of the source. Preserve capitalisation where it carries meaning (a brand, a code, a heading style); otherwise follow the target language's conventions.",
      "- Use the same translation for the same term throughout; the ESTABLISHED TRANSLATIONS given with a request are how this store already says things and must be followed exactly.",
      "- TERMINOLOGY OVERRIDES given with a request are the merchant's explicit rules and take precedence over everything else, including your own judgement and the established translations.",
    ].join("\n"),
  );

  sections.push(
    [
      "WHAT NEVER CHANGES",
      "- Facts: never invent product claims, features or benefits, and never alter specifications.",
      "- Numbers, sizes, quantities, units, prices, dates and model identifiers stay as they are (a decimal separator may follow the target language's convention; the digits may not change).",
      "- URLs, e-mail addresses, file names and handles are copied exactly.",
      "- Placeholders such as {{name}}, {0}, %s and ${var} are copied exactly, in place.",
      "- HTML: keep every tag, attribute, and the order and nesting of tags exactly as in the source; translate only the visible text and translatable attribute values such as alt and title. Never add or remove tags.",
      "- Rich text JSON: return the same document with only the \"value\" strings translated; every other key and value stays identical.",
      "- Do not add explanations, notes, quotation marks or alternatives. If a field is already correct in the target language, return it unchanged.",
    ].join("\n"),
  );

  if (request.storeName)
    sections.push(`STORE NAME\nThe store is called "${request.storeName}". The name is never translated.`);

  if (request.storeContext) sections.push(`STORE CONTEXT\n${request.storeContext}`);

  sections.push(
    'ANSWER FORMAT\nAnswer with a single JSON object of the form {"translations": {"1": "...", "2": "..."}} where each key is the field number given and each value is the translated field. Include every field exactly once and nothing else.',
  );
  return sections.join("\n\n");
}

function userMessage(request: TranslationRequest): string {
  const sections: string[] = [];

  sections.push(
    `RESOURCE CONTEXT\n${renderResourceContext(request.resourceContext ?? { kind: "none" }, {
      kind: request.resourceKind,
      title: request.resourceTitle,
    })}`,
  );

  const protect = request.glossary.filter((term) => term.kind === "protect").map((term) => term.sourceTerm);
  const translateAs = request.glossary.filter(
    (term) =>
      term.kind === "translate" &&
      term.targetTerm &&
      (term.targetLocale === null || term.targetLocale === request.targetLocale),
  );
  if (protect.length > 0 || translateAs.length > 0) {
    const lines = ["TERMINOLOGY OVERRIDES (merchant rules; absolute precedence)"];
    if (protect.length > 0) lines.push(`Never translate, keep exactly as written: ${protect.map((t) => `"${t}"`).join(", ")}.`);
    for (const term of translateAs) lines.push(`"${term.sourceTerm}" → "${term.targetTerm}"`);
    sections.push(lines.join("\n"));
  }

  if (request.memoryHints.length > 0) {
    const lines = ["ESTABLISHED TRANSLATIONS (this store already says it this way; use exactly)"];
    for (const hint of request.memoryHints)
      lines.push(`"${hint.sourceText}" → "${hint.targetText}"${hint.origin === "ai" ? "" : " (confirmed by the merchant)"}`);
    sections.push(lines.join("\n"));
  }

  if (request.terminology.length > 0) {
    const lines = [
      "STORE TERMINOLOGY (how these words are used in this store; choose the target market's established form for each)",
    ];
    for (const note of request.terminology) {
      const label = TERM_CLASSIFICATION_LABEL[note.classification].toLowerCase();
      lines.push(`- ${note.term}: ${label}${note.evidence ? ` (${note.evidence})` : ""}`);
    }
    sections.push(lines.join("\n"));
  }

  const body = request.fields
    .map((field, index) => {
      const kind = HTML_TYPES.has(field.type)
        ? "HTML"
        : field.type === "RICH_TEXT_FIELD"
          ? "rich text JSON"
          : "text";
      return `Field ${index + 1} (${field.key}, ${kind}):\n${field.value}`;
    })
    .join("\n\n---\n\n");
  sections.push(`FIELDS\n${body}`);

  return sections.join("\n\n");
}

export function buildTranslationMessages(request: TranslationRequest): ChatMessage[] {
  return [
    { role: "system", content: systemMessage(request) },
    { role: "user", content: userMessage(request) },
  ];
}

/**
 * The second request when validation found what the first answer broke:
 * the same context, the previous answer, and each violated invariant named
 * so the model fixes that and nothing else.
 */
export function buildCorrectionMessages(
  request: TranslationRequest,
  previousAnswer: string,
  violations: readonly Violation[],
): ChatMessage[] {
  const byField = new Map<number, string[]>();
  request.fields.forEach((field, index) => {
    const messages = violations.filter((v) => v.key === field.key).map((v) => v.message);
    if (messages.length > 0) byField.set(index + 1, messages);
  });
  const problems = [...byField.entries()]
    .map(([number, messages]) => `Field ${number}:\n${messages.map((m) => `  - ${m}`).join("\n")}`)
    .join("\n");
  return [
    { role: "system", content: systemMessage(request) },
    { role: "user", content: userMessage(request) },
    { role: "assistant", content: previousAnswer },
    {
      role: "user",
      content: `Your answer broke these rules. Correct only what is listed, keep everything else as you had it, and answer again with the complete JSON object for every field.\n\n${problems}`,
    },
  ];
}

const replySchema = z.object({
  translations: z.record(z.string(), z.string()),
});

export type ParsedReply =
  | { ok: true; values: Map<string, string> }
  | { ok: false; reason: string };

/**
 * The model's JSON, matched back to field keys by number. Any field the
 * reply left out, or any number it invented, fails the whole reply: a
 * partial answer written to Shopify would leave a resource half translated
 * with no record of which half.
 */
export function parseTranslationReply(
  text: string,
  fields: readonly SourceField[],
): ParsedReply {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(text));
  } catch {
    return { ok: false, reason: "The reply was not JSON." };
  }
  const parsed = replySchema.safeParse(json);
  if (!parsed.success)
    return { ok: false, reason: "The reply did not have the expected shape." };

  const values = new Map<string, string>();
  const missing: string[] = [];
  fields.forEach((field, index) => {
    const value = parsed.data.translations[String(index + 1)];
    if (value === undefined) missing.push(field.key);
    else values.set(field.key, value);
  });
  if (missing.length > 0)
    return {
      ok: false,
      reason: `The reply left out ${missing.join(", ")}.`,
    };
  const extra = Object.keys(parsed.data.translations).filter(
    (key) => !/^\d+$/.test(key) || Number(key) < 1 || Number(key) > fields.length,
  );
  if (extra.length > 0)
    return { ok: false, reason: "The reply answered fields that were not asked." };
  return { ok: true, values };
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

/**
 * English names for the locales a store is likely to use, so the model is told
 * "Slovenian" rather than "sl". Anything else is passed as its code, which
 * the model understands too.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  "en-GB": "British English",
  "en-US": "American English",
  de: "German",
  "de-AT": "Austrian German",
  "de-CH": "Swiss German",
  fr: "French",
  "fr-CA": "Canadian French",
  it: "Italian",
  es: "Spanish",
  "es-MX": "Mexican Spanish",
  pt: "Portuguese",
  "pt-BR": "Brazilian Portuguese",
  "pt-PT": "European Portuguese",
  nl: "Dutch",
  sl: "Slovenian",
  hr: "Croatian",
  sr: "Serbian",
  bs: "Bosnian",
  hu: "Hungarian",
  cs: "Czech",
  sk: "Slovak",
  pl: "Polish",
  ro: "Romanian",
  bg: "Bulgarian",
  el: "Greek",
  tr: "Turkish",
  sv: "Swedish",
  da: "Danish",
  nb: "Norwegian (Bokmål)",
  fi: "Finnish",
  et: "Estonian",
  lv: "Latvian",
  lt: "Lithuanian",
  uk: "Ukrainian",
  ru: "Russian",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  ar: "Arabic",
  he: "Hebrew",
  hi: "Hindi",
  th: "Thai",
  vi: "Vietnamese",
  id: "Indonesian",
  ms: "Malay",
  mk: "Macedonian",
  sq: "Albanian",
  ga: "Irish",
  is: "Icelandic",
  ca: "Catalan",
};

export function languageName(locale: string): string {
  return (
    LANGUAGE_NAMES[locale] ??
    LANGUAGE_NAMES[locale.split("-")[0] ?? locale] ??
    locale
  );
}
