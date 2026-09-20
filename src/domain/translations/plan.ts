import {
  NEVER_AUTO_TRANSLATED_KEYS,
  type ExistingTranslation,
  type FieldState,
  type OverwritePolicy,
  type OwnershipRecord,
  type SourceField,
  type SyncMode,
} from "~/domain/translations/types";

/**
 * Deciding what to do with each field of one resource in one language
 * (docs/translations.md § Ownership and overwrite).
 *
 * Pure. The caller reads Shopify's translatable content and existing
 * translations, and this app's own ownership records, and this says which
 * fields go to the AI and why the rest do not. The rule that matters most:
 * a translation a person wrote or touched is never sent for rewriting
 * unless the language's policy is `overwrite_all`.
 */

export type SkipReason =
  | "empty_source"
  | "not_translatable"
  | "identifier"
  | "up_to_date"
  | "protected_existing"
  | "protected_manual"
  | "same_language";

export type FieldDecision =
  | { kind: "translate"; field: SourceField; state: FieldState }
  | { kind: "copy_source"; field: SourceField }
  | { kind: "skip"; field: SourceField; reason: SkipReason; state: FieldState };

export interface PlanInput {
  fields: readonly SourceField[];
  translations: readonly ExistingTranslation[];
  ownership: readonly OwnershipRecord[];
  /** Hash of a value, injected so the domain does not pick an algorithm. */
  hash: (value: string) => string;
  mode: SyncMode;
  policy: OverwritePolicy;
  sourceLocale: string;
  targetLocale: string;
}

/** Content types Shopify marks translatable but that hold no prose. */
const UNTRANSLATABLE_TYPES: ReadonlySet<string> = new Set([
  "URI",
  "URL",
  "JSON",
  "JSON_STRING",
  "FILE_REFERENCE",
  "LIST_FILE_REFERENCE",
  "INTEGER",
  "DECIMAL",
  "DATE",
  "DATE_TIME",
  "BOOLEAN",
  "COLOR",
  "RATING",
  "WEIGHT",
  "VOLUME",
  "DIMENSION",
  "MONEY",
  "LINK",
  "LIST_LINK",
]);

/**
 * Whether a field is text the engine translates at all. Coverage counts by
 * the same test, so what a sync will do and what the numbers say agree.
 */
export function isTranslatableField(field: SourceField): boolean {
  return (
    field.value.trim() !== "" &&
    !UNTRANSLATABLE_TYPES.has(field.type) &&
    !NEVER_AUTO_TRANSLATED_KEYS.has(field.key)
  );
}

/**
 * Who a translation belongs to, from this app's record of it. Deciding
 * manual-versus-AI is the one subtle line: an AI-owned record whose hash no
 * longer matches Shopify's value means a person changed it after the AI
 * wrote it, and it is theirs now. No record at all means Shopify held it
 * before this app did, which is human work as far as the engine is concerned.
 */
export function ownerOf(
  translation: ExistingTranslation | undefined,
  record: OwnershipRecord | undefined,
  hash: (value: string) => string,
): "missing" | "ai" | "manual" | "existing" {
  if (!translation || translation.value === "") return "missing";
  if (!record) return "existing";
  if (record.owner === "manual") return "manual";
  return hash(translation.value) === record.valueHash ? "ai" : "manual";
}

/**
 * The merchant-facing state of a field: outdated first, because that is the
 * condition that asks for action, then who owns it.
 */
export function classifyField(
  translation: ExistingTranslation | undefined,
  record: OwnershipRecord | undefined,
  hash: (value: string) => string,
): FieldState {
  const owner = ownerOf(translation, record, hash);
  if (owner === "missing") return "missing";
  if (translation?.outdated) return "outdated";
  return owner;
}

/**
 * Whether the current translation may be rewritten under the policy, given
 * who owns it. `existing` (a translation this app never wrote) counts as
 * human work; nothing but `overwrite_all` touches it.
 */
export function mayOverwrite(
  state: FieldState,
  policy: OverwritePolicy,
): boolean {
  switch (policy) {
    case "overwrite_all":
      return true;
    case "update_ai_managed":
      return state === "ai";
    case "protect_existing":
      return false;
  }
}

export function planResource(input: PlanInput): FieldDecision[] {
  const byKey = new Map(input.translations.map((t) => [t.key, t]));
  const records = new Map(
    input.ownership
      .filter((record) => record.locale === input.targetLocale)
      .map((record) => [record.key, record]),
  );

  return input.fields.map((field): FieldDecision => {
    const translation = byKey.get(field.key);
    const state = classifyField(translation, records.get(field.key), input.hash);

    if (field.value.trim() === "")
      return { kind: "skip", field, reason: "empty_source", state };
    if (UNTRANSLATABLE_TYPES.has(field.type))
      return { kind: "skip", field, reason: "not_translatable", state };
    if (NEVER_AUTO_TRANSLATED_KEYS.has(field.key))
      return { kind: "skip", field, reason: "identifier", state };

    // The resource is written in the target language: its own text is the
    // translation, and no AI is involved. Only fills a gap or refreshes an
    // outdated copy; a person's version of the same field stands.
    if (input.sourceLocale === input.targetLocale) {
      if (state === "missing" || state === "outdated" || state === "ai")
        return translation?.value === field.value && state !== "outdated"
          ? { kind: "skip", field, reason: "up_to_date", state }
          : { kind: "copy_source", field };
      return { kind: "skip", field, reason: "same_language", state };
    }

    if (state === "missing") return { kind: "translate", field, state };

    // Something is there. Whether the mode asks for it to be revisited:
    const wanted =
      input.mode === "force" ||
      (input.mode === "missing_outdated" && state === "outdated");
    if (!wanted) return { kind: "skip", field, reason: "up_to_date", state };

    // ...and whether the policy allows it. An outdated translation that a
    // person wrote is still theirs; the merchant is told rather than
    // overruled.
    const owner = ownerOf(translation, records.get(field.key), input.hash);
    if (owner !== "missing" && mayOverwrite(owner, input.policy))
      return { kind: "translate", field, state };
    return {
      kind: "skip",
      field,
      reason: owner === "ai" ? "protected_existing" : "protected_manual",
      state,
    };
  });
}

export interface PlanSummary {
  translate: number;
  copy: number;
  skipped: Partial<Record<SkipReason, number>>;
}

export function summarisePlan(decisions: readonly FieldDecision[]): PlanSummary {
  const summary: PlanSummary = { translate: 0, copy: 0, skipped: {} };
  for (const decision of decisions) {
    if (decision.kind === "translate") summary.translate += 1;
    else if (decision.kind === "copy_source") summary.copy += 1;
    else summary.skipped[decision.reason] = (summary.skipped[decision.reason] ?? 0) + 1;
  }
  return summary;
}

export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  empty_source: "nothing to translate",
  not_translatable: "not text",
  identifier: "URL handle, left as is",
  up_to_date: "already translated",
  protected_existing: "existing translation protected",
  protected_manual: "edited by a person, protected",
  same_language: "written in this language",
};
