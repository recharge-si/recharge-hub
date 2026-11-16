import { sameLanguage } from "~/domain/translations/locale";
import {
  containsExact,
  containsTerm,
  htmlSkeleton,
  isAllCaps,
  isCapitalised,
  looksLikeCode,
  missingFrom,
  normaliseTerm,
  numbersOf,
  placeholdersOf,
  richTextSkeleton,
  skeletonDifference,
  stripHtml,
  urlsOf,
  wordsOf,
} from "~/domain/translations/text";
import type { GlossaryTerm, SourceField } from "~/domain/translations/types";

/**
 * What a translation must not have done (docs/translations.md
 * § Validation). Deterministic checks between the source and the model's
 * answer, run before anything is written to Shopify: markup, placeholders,
 * numbers, codes, URLs and the merchant's own rules are the invariants a
 * translation never changes, and an answer identical to a source that
 * plainly needed translating is a translation that did not happen.
 *
 * A `hard` violation stops the write; the engine asks the model once more
 * with the violations spelt out and fails the item if they remain. A `soft`
 * one is recorded in the trace and lets the write proceed: it is a doubt,
 * not a defect.
 */

export type ViolationCode =
  | "missing"
  | "empty"
  | "placeholders"
  | "html_structure"
  | "rich_text_structure"
  | "urls"
  | "numbers"
  | "codes"
  | "protected_term"
  | "glossary_term"
  | "unchanged"
  | "length";

export interface Violation {
  key: string;
  code: ViolationCode;
  severity: "hard" | "soft";
  /** For the correction prompt: what exactly must hold. */
  message: string;
}

export interface ValidationRules {
  sourceLocale: string;
  targetLocale: string;
  glossary: readonly GlossaryTerm[];
  /**
   * Words and phrases that conventionally keep their form in this store:
   * brands, model codes, abbreviations, and strings memory has seen kept
   * as they were. Used only to judge whether "unchanged" is plausible.
   */
  formStableTerms: readonly string[];
  /**
   * Fields the model said are already written in the target language and
   * returned as they are (`already_in_target` in its reply). An unchanged
   * answer for one of these is accepted when the field is prose, not a
   * short label (§ Unchanged text).
   */
  alreadyInTarget?: ReadonlySet<string>;
}

/**
 * Bumped whenever a rule here changes what is accepted. Part of the key a
 * remembered failure is matched on, so a resource that failed under the
 * old rules is tried again by the next automatic sync (§ Failures).
 */
export const VALIDATION_VERSION = "validate-v2";

const HTML_TYPES: ReadonlySet<string> = new Set(["HTML", "MULTI_LINE_TEXT_FIELD_HTML"]);

export function validateTranslation(
  fields: readonly SourceField[],
  values: ReadonlyMap<string, string>,
  rules: ValidationRules,
): Violation[] {
  const violations: Violation[] = [];
  for (const field of fields) {
    const target = values.get(field.key);
    if (target === undefined) {
      violations.push({ key: field.key, code: "missing", severity: "hard", message: "The field was not answered." });
      continue;
    }
    if (target.trim() === "") {
      violations.push({ key: field.key, code: "empty", severity: "hard", message: "The translation is empty; the source is not." });
      continue;
    }
    violations.push(...checkField(field, target, rules));
  }
  return violations;
}

function checkField(field: SourceField, target: string, rules: ValidationRules): Violation[] {
  const out: Violation[] = [];
  const source = field.value;
  const push = (code: ViolationCode, severity: Violation["severity"], message: string) =>
    out.push({ key: field.key, code, severity, message });

  const placeholders = missingFrom(placeholdersOf(source), placeholdersOf(target));
  const extraPlaceholders = missingFrom(placeholdersOf(target), placeholdersOf(source));
  if (placeholders.length > 0 || extraPlaceholders.length > 0)
    push(
      "placeholders",
      "hard",
      `Keep the placeholders exactly as in the source: ${[...new Set(placeholdersOf(source))].join(", ") || "none"}.`,
    );

  if (HTML_TYPES.has(field.type) || /<[a-z][^>]*>/i.test(source)) {
    const before = htmlSkeleton(source);
    const after = htmlSkeleton(target);
    if (before.join("") !== after.join(""))
      push(
        "html_structure",
        "hard",
        [
          "Keep every HTML tag of the source, in the same order and nesting, with the same href and src attributes; do not add, drop, merge or move elements. Translate only the visible text.",
          skeletonDifference(before, after),
        ]
          .filter(Boolean)
          .join(" "),
      );
  }

  if (field.type === "RICH_TEXT_FIELD") {
    const before = richTextSkeleton(source);
    const after = richTextSkeleton(target);
    if (before !== null && after === null)
      push("rich_text_structure", "hard", "Answer with the same rich text JSON document, translating only the \"value\" strings.");
    else if (before !== null && before !== after)
      push(
        "rich_text_structure",
        "hard",
        "Keep the rich text JSON structure identical: the same nodes, in the same order, with the same marks and links. Translate only the \"value\" strings.",
      );
  }

  const urls = missingFrom(urlsOf(source), urlsOf(target));
  if (urls.length > 0) push("urls", "hard", `Keep these URLs and addresses exactly: ${[...new Set(urls)].join(", ")}.`);

  const sourceText = stripHtml(source);
  const targetText = stripHtml(target);

  const numbers = missingFrom(numbersOf(sourceText), numbersOf(targetText));
  if (numbers.length > 0)
    push("numbers", "hard", `Keep every number from the source (a decimal separator may change, digits may not): ${[...new Set(numbers)].join(", ")}.`);

  // Codes are compared with separators and case removed, so "5.0m" written
  // as "5,0 m" in the target still counts as kept; "X-Wing" as "xwing" too.
  const targetKey = codeKey(targetText);
  const codes = wordsOf(sourceText).filter((word) => looksLikeCode(word) && !/^\p{N}+([.,]\p{N}+)?$/u.test(word));
  const missingCodes = [...new Set(codes)].filter((code) => !targetKey.includes(codeKey(code)));
  if (missingCodes.length > 0)
    push("codes", "hard", `Keep these model codes and identifiers exactly as written: ${missingCodes.join(", ")}.`);

  for (const term of rules.glossary) {
    if (term.kind === "protect") {
      if (containsTerm(sourceText, term.sourceTerm) && !containsExact(targetText, term.sourceTerm))
        push("protected_term", "hard", `"${term.sourceTerm}" must appear exactly as written; it is never translated.`);
      continue;
    }
    if (!term.targetTerm) continue;
    if (term.targetLocale !== null && term.targetLocale !== rules.targetLocale) continue;
    if (!containsTerm(sourceText, term.sourceTerm)) continue;
    if (containsTerm(targetText, term.targetTerm)) continue;
    // A rule inside a sentence may legitimately inflect in the target
    // language; a rule that is the whole field, or a short label, may not.
    const short = wordsOf(sourceText).length <= 3;
    push(
      "glossary_term",
      short ? "hard" : "soft",
      `Translate "${term.sourceTerm}" as "${term.targetTerm}" wherever it appears.`,
    );
  }

  out.push(...checkUnchanged(field, sourceText, targetText, rules));

  if (sourceText.length >= 40) {
    const ratio = targetText.length / sourceText.length;
    if (ratio < 0.25) push("length", "soft", "The translation is much shorter than the source; make sure nothing was left out.");
    else if (ratio > 4) push("length", "soft", "The translation is much longer than the source; make sure nothing was added.");
  }
  return out;
}

/**
 * An answer equal to its source (docs/translations.md § Unchanged text).
 * Legitimate for a brand, a code, an abbreviation, a term the store keeps
 * as it is, or a string of those things and numbers. Suspicious for a
 * phrase of ordinary words — "All Products" returned as "All Products" for
 * Slovenian is a translation that did not happen — and hard when the
 * phrase has two or more such words. A single ordinary word unchanged is a
 * doubt only: it may well be the target market's established form.
 */
function checkUnchanged(field: SourceField, sourceText: string, targetText: string, rules: ValidationRules): Violation[] {
  if (normaliseTerm(sourceText) !== normaliseTerm(targetText)) return [];
  if (sourceText.trim() === "") return [];
  // Between regional variants of one language most strings are unchanged.
  if (sameLanguage(rules.sourceLocale, rules.targetLocale)) return [];
  const words = wordsOf(sourceText);
  const letterWords = words.filter((word) => /\p{L}/u.test(word) && !looksLikeCode(word));
  if (letterWords.length === 0) return [];

  const stable = new Set(rules.formStableTerms.map(normaliseTerm));
  // In a heading written all in capitals ("ALL NEW BOARDS") capitals say
  // nothing about a word; "HD SDM C75" is a string of abbreviations.
  const shouting =
    sourceText === sourceText.toUpperCase() && letterWords.some((word) => /\p{L}{6,}/u.test(word));
  const isStable = (word: string) => stable.has(normaliseTerm(word)) || stableByShape(word, shouting);
  if (stable.has(normaliseTerm(sourceText))) return [];
  const ordinary = letterWords.filter((word) => !isStable(word));
  if (ordinary.length === 0) return [];
  // Two consecutive words forming a stable term ("Wing Foil") count as stable.
  const uncovered = ordinary.filter((word, index, all) => {
    const prev = all[index - 1];
    const next = all[index + 1];
    return !(prev && stable.has(normaliseTerm(`${prev} ${word}`))) && !(next && stable.has(normaliseTerm(`${word} ${next}`)));
  });
  if (uncovered.length === 0) return [];
  // One capitalised word beside a code in a string of established terms is
  // a model name ("Duotone Wing Unit 4.0"), not a word that went untranslated.
  const anchored = words.some(looksLikeCode);
  // The model said this text is already in the target language: a store
  // whose default-language field holds copy written in the target language
  // (a Slovenian description in an English store). Accepted for prose,
  // where the claim is a statement about the text rather than a lazy echo;
  // a short label like "All Products" is still held to the rule.
  if (rules.alreadyInTarget?.has(field.key) && letterWords.length >= MIN_PROSE_WORDS)
    return [
      {
        key: field.key,
        code: "unchanged",
        severity: "soft",
        message: "Kept as it was: the model reported the text is already in the target language.",
      },
    ];
  if (uncovered.length === 1 && anchored && letterWords.length > 1 && isCapitalised(uncovered[0]!)) return [];
  if (uncovered.length === 1 && letterWords.length === 1)
    return [
      {
        key: field.key,
        code: "unchanged",
        severity: "soft",
        message: `"${sourceText}" came back unchanged; acceptable only if that is the established term in the target market.`,
      },
    ];
  return [
    {
      key: field.key,
      code: "unchanged",
      severity: uncovered.length >= 2 ? "hard" : "soft",
      message: `"${sourceText}" came back unchanged. It contains ordinary words (${uncovered.slice(0, 4).join(", ")}) that must be translated; keep only brands, codes and established terms as they are.`,
    },
  ];
}

/** Below this many words a field is a label, and "already in the target language" is not taken on trust. */
const MIN_PROSE_WORDS = 4;

/**
 * Unit symbols shared across languages (SI and the trade's usual ones),
 * which a specification table keeps whatever language it is in.
 */
const UNIT_SYMBOLS: ReadonlySet<string> = new Set([
  "mm", "cm", "dm", "m", "km", "m2", "m²", "m3", "m³", "cm2", "cm²", "cm3", "cm³", "g", "kg", "t", "l", "ml", "cl",
  "dl", "h", "min", "s", "ms", "w", "kw", "v", "mah", "ah", "wh", "kwh", "psi", "bar", "kn", "kts", "lb", "lbs",
  "oz", "ft",
]);

/**
 * A word whose shape says it is a name or a symbol, not prose: a short
 * all-caps abbreviation (`RPM`, `SL`, `HD`, `SDM`), a word with a capital
 * after a lower-case letter (`iWindsurf`, `FreeRide`), a unit symbol.
 * Capitals count only when the text is not written all in capitals.
 */
function stableByShape(word: string, shouting: boolean): boolean {
  if (!shouting && isAllCaps(word) && word.length <= 5) return true;
  if (/\p{Ll}\p{Lu}/u.test(word)) return true;
  return UNIT_SYMBOLS.has(word.toLowerCase());
}

function codeKey(value: string): string {
  return value.toLowerCase().replace(/[\s.,:;/\-·_]/g, "");
}

export function hardViolations(violations: readonly Violation[]): Violation[] {
  return violations.filter((violation) => violation.severity === "hard");
}

/** One line per violation, for a log or a sync item. */
export function describeViolations(violations: readonly Violation[]): string {
  return violations.map((violation) => `${violation.key}: ${violation.code}`).join(", ");
}
