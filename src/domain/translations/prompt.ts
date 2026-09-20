import { z } from "zod";

import type { GlossaryTerm, SourceField } from "~/domain/translations/types";

/**
 * What the model is asked, and how its answer is read
 * (docs/translations.md § The provider).
 *
 * Pure string construction. One request carries every field of one resource
 * for one target language, numbered, and the model answers with JSON keyed by
 * those numbers — so a long description and its title are translated with
 * each other in view, and a reply that drops or invents a field is caught by
 * the parser rather than written to Shopify.
 */

export interface TranslationRequest {
  sourceLocale: string;
  targetLocale: string;
  /** What the resource is, for context: "Product", "Blog article". */
  resourceKind: string;
  fields: readonly SourceField[];
  glossary: readonly GlossaryTerm[];
  /** The store's name, so it is never translated. */
  storeName: string | null;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

const HTML_TYPES: ReadonlySet<string> = new Set(["HTML", "MULTI_LINE_TEXT_FIELD_HTML"]);

export function buildTranslationMessages(
  request: TranslationRequest,
): ChatMessage[] {
  const protect = request.glossary
    .filter((term) => term.kind === "protect")
    .map((term) => term.sourceTerm);
  const translateAs = request.glossary.filter(
    (term) =>
      term.kind === "translate" &&
      term.targetTerm &&
      (term.targetLocale === null || term.targetLocale === request.targetLocale),
  );

  const rules = [
    `You translate e-commerce store content from ${languageName(request.sourceLocale)} (${request.sourceLocale}) to ${languageName(request.targetLocale)} (${request.targetLocale}).`,
    "Translate faithfully and idiomatically for shoppers in the target language. Keep the register and tone of the source.",
    "Preserve every placeholder, number, SKU, product code, measurement, URL and email address exactly.",
    "Where the source is HTML, keep the HTML structure, tags and attributes exactly as they are and translate only the visible text. Never add or remove tags.",
    "Where the source is a rich text JSON document, keep the JSON structure and translate only the text values.",
    "Do not add explanations, notes or quotation marks around the translation.",
    "If a field is already in the target language, return it unchanged.",
  ];
  if (request.storeName)
    rules.push(`The store is called "${request.storeName}". Never translate its name.`);
  if (protect.length > 0)
    rules.push(
      `Never translate these terms; keep them exactly as written: ${protect.map((term) => `"${term}"`).join(", ")}.`,
    );
  if (translateAs.length > 0)
    rules.push(
      `Use this glossary wherever the source term appears: ${translateAs
        .map((term) => `"${term.sourceTerm}" → "${term.targetTerm}"`)
        .join("; ")}.`,
    );
  rules.push(
    'Answer with a single JSON object of the form {"translations": {"1": "...", "2": "..."}} where each key is the field number given and each value is the translated text. Include every field exactly once.',
  );

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

  return [
    { role: "system", content: rules.join("\n") },
    {
      role: "user",
      content: `Resource type: ${request.resourceKind}\n\n${body}`,
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

/** Asking which language a sample of text is written in. */
export function buildDetectionMessages(sample: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        'Identify the language of the text. Answer with a single JSON object {"locale": "<ISO 639-1 code, lowercase, e.g. "sl">", "confidence": <0 to 1>}. If the text mixes languages, answer with the dominant one.',
    },
    { role: "user", content: sample.slice(0, 2000) },
  ];
}

const detectionSchema = z.object({
  locale: z.string().min(2).max(10),
  confidence: z.number().min(0).max(1).optional(),
});

export function parseDetectionReply(
  text: string,
): { locale: string; confidence: number | null } | null {
  try {
    const parsed = detectionSchema.safeParse(JSON.parse(stripCodeFence(text)));
    if (!parsed.success) return null;
    return {
      locale: parsed.data.locale.toLowerCase(),
      confidence: parsed.data.confidence ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * English names for the locales a store is likely to use, so the model is told
 * "Slovenian" rather than "sl". Anything else is passed as its code, which
 * the model understands too.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  de: "German",
  fr: "French",
  it: "Italian",
  es: "Spanish",
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
