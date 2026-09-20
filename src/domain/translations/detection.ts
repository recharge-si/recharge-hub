import { z } from "zod";

import { languageName } from "~/domain/translations/prompt";
import { clip, stripHtml, wordsOf } from "~/domain/translations/text";
import type { ChatMessage } from "~/domain/translations/types";

/**
 * Which language a resource is written in (docs/translations.md § Source
 * language). A suggestion, never a decision: the answer is recorded next to
 * the resource and a person makes it the source or does not.
 *
 * Short e-commerce strings are the hard case. "Foil" identifies no language
 * on its own, and a model asked will still answer with a number that looks
 * like certainty. So the request carries what the model can lean on — the
 * store's own language and the text around the resource — and the answer's
 * confidence is capped by how much text there was to judge from, so a
 * three-letter label is never reported as 0.99 certain.
 */

export interface DetectionContext {
  /** The store's primary locale: what short labels are most likely written in. */
  storeLocale: string;
  /** Locales the store has, which the answer is most likely among. */
  candidateLocales: readonly string[];
  /** Text near the resource — sibling labels, the parent's title — in the same store. */
  neighbourText: readonly string[];
}

export function detectionSample(fields: ReadonlyArray<{ value: string }>, max = 2000): string {
  return fields
    .map((field) => stripHtml(field.value))
    .filter((text) => text !== "")
    .join("\n")
    .slice(0, max);
}

export function buildDetectionMessages(sample: string, context: DetectionContext): ChatMessage[] {
  const lines = [
    "Identify the language the TEXT below is written in.",
    `The text comes from an online store whose content language is ${languageName(context.storeLocale)} (${context.storeLocale}); short labels and product names are usually in that language unless the words are clearly from another.`,
  ];
  if (context.candidateLocales.length > 0)
    lines.push(
      `The store's languages are: ${context.candidateLocales.map((locale) => `${languageName(locale)} (${locale})`).join(", ")}. Prefer one of these when the text is compatible with it.`,
    );
  if (context.neighbourText.length > 0)
    lines.push(
      `Text next to it in the same store, for context only (do not identify its language): ${context.neighbourText
        .slice(0, 12)
        .map((text) => `"${clip(stripHtml(text), 60)}"`)
        .join(", ")}.`,
    );
  lines.push(
    "Brand names, model codes and international loanwords carry no language information; judge from the ordinary words. If the text mixes languages, answer with the dominant one.",
    'Answer with a single JSON object {"locale": "<ISO 639-1 code, lowercase, e.g. "sl">", "confidence": <0 to 1>}. Give a low confidence when the text is too short or too generic to tell.',
  );
  return [
    { role: "system", content: lines.join("\n") },
    { role: "user", content: `TEXT:\n${sample.slice(0, 2000)}` },
  ];
}

const detectionSchema = z.object({
  locale: z.string().min(2).max(10),
  confidence: z.number().min(0).max(1).optional(),
});

export interface Detection {
  locale: string;
  /** Calibrated: never above what the length of the sample can support. */
  confidence: number | null;
  /** The model's own figure, before the cap. */
  reportedConfidence: number | null;
  /** True when the sample was too short to trust and the cap applied. */
  shortSample: boolean;
}

/**
 * How sure a detection may be, from the sample alone. Below four letters
 * nothing is knowable; a one-word label supports little; a sentence or two
 * supports most of what the model says; a paragraph, all of it.
 */
export function confidenceCap(sample: string): number {
  const text = stripHtml(sample);
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const words = wordsOf(text).filter((word) => /\p{L}/u.test(word)).length;
  if (letters < 4) return 0.2;
  if (words <= 1) return 0.45;
  if (words <= 3) return 0.6;
  if (words <= 8) return 0.8;
  if (words <= 20) return 0.92;
  return 1;
}

export function parseDetectionReply(text: string, sample: string): Detection | null {
  let json: unknown;
  try {
    json = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
  const parsed = detectionSchema.safeParse(json);
  if (!parsed.success) return null;
  const reported = parsed.data.confidence ?? null;
  const cap = confidenceCap(sample);
  const confidence = reported === null ? (cap < 1 ? cap : null) : Math.min(reported, cap);
  return {
    locale: parsed.data.locale.toLowerCase(),
    confidence: confidence === null ? null : Math.round(confidence * 100) / 100,
    reportedConfidence: reported,
    shortSample: cap < 0.8,
  };
}

/** "likely", "possibly", "hard to tell": a word for a number nobody should read as precise. */
export function describeConfidence(confidence: number | null): string {
  if (confidence === null) return "unknown confidence";
  if (confidence >= 0.85) return "very likely";
  if (confidence >= 0.6) return "likely";
  if (confidence >= 0.4) return "possibly";
  return "hard to tell from so little text";
}
