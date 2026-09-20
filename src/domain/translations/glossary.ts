import type { GlossaryTerm } from "~/domain/translations/types";

/**
 * When two glossary rules cannot both hold (docs/translations.md § Glossary).
 *
 * The prompt sends every rule that applies to a language, so two rules about
 * the same term in the same language would hand the model an instruction and
 * its contradiction. A term is the same term whatever its case or the space
 * around it — the model reads "Boom" and "boom" as one word, so the glossary
 * must too.
 *
 * - A protected term applies to every language, so it clashes with any other
 *   rule for that term.
 * - A translate-as rule for every language clashes with one for any single
 *   language, and one for a language with another for the same language.
 * - Two translate-as rules for different languages coexist: that is what the
 *   language on a rule is for.
 */
export interface GlossaryConflict {
  existing: GlossaryTerm;
  reason: "protected" | "translated" | "same_language";
}

export function sameTerm(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}

export function glossaryConflict(
  existing: readonly GlossaryTerm[],
  candidate: GlossaryTerm,
): GlossaryConflict | null {
  for (const term of existing) {
    if (!sameTerm(term.sourceTerm, candidate.sourceTerm)) continue;
    if (term.kind === "protect") return { existing: term, reason: "protected" };
    if (candidate.kind === "protect")
      return { existing: term, reason: "translated" };
    if (
      term.targetLocale === null ||
      candidate.targetLocale === null ||
      term.targetLocale === candidate.targetLocale
    )
      return { existing: term, reason: "same_language" };
  }
  return null;
}
