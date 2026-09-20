import { compareCodepoints } from "~/domain/types";
import { containsTerm, normaliseTerm, stripHtml, wordsOf } from "~/domain/translations/text";
import type { GlossaryTerm, SourceField } from "~/domain/translations/types";

/**
 * Translation memory (docs/translations.md § Translation memory): what this
 * store has already said in a language, so it says it the same way again.
 *
 * Two uses, kept apart by the shape of the source string. A short string
 * that has been translated before — a menu label, an option value, a
 * product type, a collection title — is **reused** when reusing it is safe,
 * with no provider request at all. A short string that appears *inside* a
 * field is a **hint**: the model is shown the established translation and
 * told to keep to it. Long prose is never remembered; it is never the same
 * twice and remembering it would only cost storage.
 *
 * Pure. The adapter stores and fetches entries; this decides what is worth
 * remembering, which entry answers a field, and whether the answer may be
 * written without asking the model.
 */

export type MemoryOrigin = "ai" | "manual";

export interface MemoryEntry {
  id: string;
  sourceText: string;
  targetText: string;
  origin: MemoryOrigin;
  usageCount: number;
  /** Where it was last seen, for the "same kind of content" test. */
  resourceType: string | null;
}

/** The longest source string memory keeps. Anything longer is prose. */
export const MEMORABLE_MAX_CHARS = 200;
/** Fields this long or shorter may be answered from memory without the model. */
const REUSABLE_MAX_CHARS = 120;
/** A hint is a term or a short phrase, not a sentence. */
const HINT_MAX_WORDS = 5;

const PLAIN_TYPES: ReadonlySet<string> = new Set([
  "STRING",
  "SINGLE_LINE_TEXT_FIELD",
  "MULTI_LINE_TEXT_FIELD",
  "LIST_SINGLE_LINE_TEXT_FIELD",
]);

/** The lookup key of a source string: lower case, whitespace and dashes normalised. */
export function memoryKey(text: string): string {
  return normaliseTerm(stripHtml(text));
}

/**
 * Whether a field's source is the kind of string memory keeps: plain text,
 * short, with at least one letter. HTML and rich text never qualify — their
 * markup makes every occurrence unique.
 */
export function isMemorable(field: Pick<SourceField, "type" | "value">): boolean {
  if (!PLAIN_TYPES.has(field.type)) return false;
  const text = field.value.trim();
  return text.length > 0 && text.length <= MEMORABLE_MAX_CHARS && /\p{L}/u.test(text) && !/<[a-z][^>]*>/i.test(text);
}

export type ReuseVerdict = "reuse" | "hint" | "ignore";

/**
 * Whether an exact-match entry may be written as the field's translation
 * with no model in the loop. A person's translation always may: it is the
 * confirmed answer. The AI's own may when the string has been translated
 * the same way more than once, or for the same kind of content — a menu
 * label reused for a menu label. Otherwise it is offered to the model as
 * a hint and the model has the last word, with the field's context in view.
 *
 * A glossary rule that the remembered translation does not honour vetoes
 * reuse: the merchant's rule is newer than the memory.
 */
export function reuseVerdict(
  field: SourceField,
  entry: MemoryEntry,
  context: { resourceType: string; glossary: readonly GlossaryTerm[]; targetLocale: string },
): ReuseVerdict {
  if (!isMemorable(field) || field.value.trim().length > REUSABLE_MAX_CHARS) return "hint";
  if (entry.targetText.trim() === "") return "ignore";
  if (!honoursGlossary(field.value, entry.targetText, context.glossary, context.targetLocale)) return "ignore";
  if (entry.origin === "manual") return "reuse";
  if (entry.usageCount >= 2) return "reuse";
  if (entry.resourceType !== null && entry.resourceType === context.resourceType) return "reuse";
  return "hint";
}

function honoursGlossary(
  source: string,
  target: string,
  glossary: readonly GlossaryTerm[],
  targetLocale: string,
): boolean {
  for (const term of glossary) {
    if (!containsTerm(source, term.sourceTerm)) continue;
    if (term.kind === "protect" && !target.includes(term.sourceTerm)) return false;
    if (
      term.kind === "translate" &&
      term.targetTerm &&
      (term.targetLocale === null || term.targetLocale === targetLocale) &&
      !containsTerm(target, term.targetTerm)
    )
      return false;
  }
  return true;
}

export interface MemoryHint {
  id: string;
  sourceText: string;
  targetText: string;
  origin: MemoryOrigin;
}

/**
 * Entries whose source appears inside the fields as a term or short phrase,
 * for the prompt: a person's translations first, then the most used. An
 * entry equal to a whole field is excluded here because it was either
 * reused or is already the exact hint for that field.
 */
export function selectMemoryHints(
  fields: readonly SourceField[],
  entries: readonly MemoryEntry[],
  exclude: ReadonlySet<string>,
  cap = 30,
): MemoryHint[] {
  const texts = fields.map((field) => stripHtml(field.value));
  const hits: MemoryHint[] = [];
  for (const entry of entries) {
    if (exclude.has(entry.id)) continue;
    if (entry.targetText.trim() === "") continue;
    if (wordsOf(entry.sourceText).length > HINT_MAX_WORDS) continue;
    if (texts.some((text) => containsTerm(text, entry.sourceText)))
      hits.push({ id: entry.id, sourceText: entry.sourceText, targetText: entry.targetText, origin: entry.origin });
  }
  const rank = (origin: MemoryOrigin) => (origin === "ai" ? 1 : 0);
  return hits
    .sort((a, b) => {
      const byOrigin = rank(a.origin) - rank(b.origin);
      if (byOrigin !== 0) return byOrigin;
      const ua = entries.find((e) => e.id === a.id)?.usageCount ?? 0;
      const ub = entries.find((e) => e.id === b.id)?.usageCount ?? 0;
      return ub - ua || compareCodepoints(a.sourceText, b.sourceText);
    })
    .slice(0, cap);
}

/**
 * What a finished translation teaches memory: every memorable field, as
 * the pair that was written. The caller stores them with the origin — `ai`
 * from the engine, `manual` from the editor — and the repository's merge
 * rule keeps a person's answer over the machine's.
 */
export function memorablePairs(
  fields: readonly SourceField[],
  values: ReadonlyMap<string, string>,
): Array<{ key: string; sourceText: string; targetText: string }> {
  const pairs: Array<{ key: string; sourceText: string; targetText: string }> = [];
  for (const field of fields) {
    const target = values.get(field.key);
    if (target === undefined || !isMemorable(field)) continue;
    if (target.trim() === "" || target.length > MEMORABLE_MAX_CHARS * 2) continue;
    pairs.push({ key: field.key, sourceText: field.value.trim(), targetText: target.trim() });
  }
  return pairs;
}
