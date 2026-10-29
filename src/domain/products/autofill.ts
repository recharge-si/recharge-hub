import { z } from "zod";

import {
  inputKey,
  isEmptyInput,
  metafieldValue,
  type AssignableType,
  type AttributeField,
  type AttributeInput,
  type AttributeInputs,
  type FieldEdit,
} from "~/domain/products/attribute-values";

/**
 * AI autofill (docs/attributes.md § AI autofill): a categorizer suggests a
 * product's type and values for that type's empty attributes; a person
 * reviews the suggestions and applies the ones they keep.
 *
 * Pure. This file decides what the categorizer is asked (only fields a
 * person could fill on the product page, and only empty ones, so a
 * suggestion never overwrites anything), and turns what it answers into
 * suggestions held to the same checks as a person's entry: a choice must be
 * one of the options, a number must be a number. Anything else it says is
 * dropped, not repaired.
 */

/** What the categorizer reads about a product. */
export interface AutofillProduct {
  productId: string;
  title: string;
  vendor: string;
  productType: string;
  category: string | null;
  tags: string[];
  /** Plain text, clipped. */
  description: string;
  options: string[];
  variants: Array<{
    variantId: string;
    title: string;
    sku: string | null;
    options: Array<{ name: string; value: string }>;
  }>;
}

/** Longest description sent; the start of a product text carries the facts. */
export const DESCRIPTION_LIMIT = 4000;

export function plainText(html: string, limit = DESCRIPTION_LIMIT): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|li|div|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim()
    .slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* Asking                                                                     */
/* -------------------------------------------------------------------------- */

export type AutofillFormat =
  | "text"
  | "integer"
  | "decimal"
  | "boolean"
  | "date"
  | "choice"
  | "choices"
  | "measurement";

/** One attribute the categorizer is asked to fill. */
export interface AutofillAttribute {
  id: string;
  name: string;
  description: string;
  format: AutofillFormat;
  /** For a number or measurement, the unit the value is in. */
  unit: string;
  /** For a choice: the only values allowed, by code. */
  options: Array<{ code: string; label: string }>;
  /** `variant`: one value per variant, keyed by variant id. */
  level: "product" | "variant";
  required: boolean;
}

function formatOf(edit: FieldEdit): AutofillFormat | null {
  switch (edit.kind) {
    case "blocked":
      return null;
    case "multiline":
      return "text";
    default:
      return edit.kind;
  }
}

/**
 * The attributes worth asking about: writable, and empty — for a variant
 * attribute, empty on at least one variant.
 */
export function attributesToFill(
  fields: readonly AttributeField[],
  inputs: AttributeInputs,
  variantIds: readonly string[],
): AutofillAttribute[] {
  const asked: AutofillAttribute[] = [];
  for (const field of fields) {
    const format = formatOf(field.edit);
    if (format === null || field.edit.kind === "blocked") continue;
    const keys =
      field.scope === "variant"
        ? variantIds.map((id) => inputKey(field.attributeId, id))
        : [inputKey(field.attributeId, null)];
    if (keys.length === 0 || !keys.some((key) => isEmptyInput(inputs[key])))
      continue;
    asked.push({
      id: field.attributeId,
      name: field.name,
      description: field.description,
      format,
      unit: field.edit.unit,
      options: field.edit.options,
      level: field.scope,
      required: field.required,
    });
  }
  return asked;
}

/* -------------------------------------------------------------------------- */
/* Answers                                                                    */
/* -------------------------------------------------------------------------- */

const answerValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number()])),
]);

export const valuesAnswerSchema = z.object({
  values: z
    .array(
      z.object({
        attributeId: z.string(),
        variantId: z.string().nullable().optional(),
        value: answerValue.nullable(),
      }),
    )
    .max(2000),
});

export type ValuesAnswer = z.infer<typeof valuesAnswerSchema>;

/** A type the categorizer named is used only if it is one the plan offers. */
export function chosenType(
  typeId: string | null,
  types: readonly AssignableType[],
): AssignableType | null {
  return types.find((type) => type.id === typeId) ?? null;
}

/** One suggested value, ready to show and to apply. */
export interface AutofillValue {
  /** The form's input key: attribute, or attribute@variant. */
  key: string;
  attributeId: string;
  variantId: string | null;
  name: string;
  input: AttributeInput;
  /** As a person reads it: labels for choices, the unit beside a number. */
  display: string;
}

const norm = (text: string) => text.trim().toLowerCase();

/** A code, or a label the categorizer wrote instead, as the option's code. */
function optionCode(
  options: ReadonlyArray<{ code: string; label: string }>,
  raw: string,
): string | null {
  const wanted = norm(raw);
  return (
    options.find((o) => norm(o.code) === wanted)?.code ??
    options.find((o) => norm(o.label) === wanted)?.code ??
    null
  );
}

/** "5.0-5.5", "430 to 460", "5..6": two numbers, which is a range and not a value. */
const RANGE = /\d\s*(?:[-–—]|to\b|\.\.)\s*\d/i;

function inputFor(
  edit: FieldEdit,
  raw: z.infer<typeof answerValue>,
): AttributeInput | null {
  if (edit.kind === "blocked") return null;
  if (edit.kind === "choices") {
    const list = (Array.isArray(raw) ? raw : [raw]).map(String);
    const codes = list.flatMap((item) => {
      const code = optionCode(edit.options, item);
      return code === null ? [] : [code];
    });
    return codes.length > 0 ? [...new Set(codes)] : null;
  }
  if (Array.isArray(raw)) return null;
  if (edit.kind === "choice") return optionCode(edit.options, String(raw));
  if (edit.kind === "boolean") {
    if (typeof raw === "boolean") return String(raw);
    const text = norm(String(raw));
    if (["true", "yes", "da"].includes(text)) return "true";
    if (["false", "no", "ne"].includes(text)) return "false";
    return null;
  }
  if (
    edit.kind === "integer" ||
    edit.kind === "decimal" ||
    edit.kind === "measurement"
  ) {
    // "4.7 m²" or "4,7" → "4.7": the number, never a unit or a range.
    const text = String(raw).trim();
    if (RANGE.test(text)) return null;
    const match = /^-?\d+(?:[.,]\d+)?/.exec(text);
    return match ? match[0].replace(",", ".") : null;
  }
  return String(raw).trim();
}

function displayOf(edit: FieldEdit, input: AttributeInput): string {
  if (edit.kind === "blocked") return "";
  const label = (code: string) =>
    edit.options.find((o) => o.code === code)?.label ?? code;
  if (Array.isArray(input)) return input.map(label).join(", ");
  if (edit.kind === "choice") return label(input);
  if (edit.kind === "boolean") return input === "true" ? "Yes" : "No";
  return edit.unit ? `${input} ${edit.unit}` : input;
}

/**
 * The categorizer's values as suggestions: only for fields asked about,
 * only where the field is still empty, each accepted by the same check a
 * person's entry passes. A variant value must name one of the product's
 * variants; a product value must name none.
 */
export function suggestedValues(
  fields: readonly AttributeField[],
  before: AttributeInputs,
  variantIds: readonly string[],
  answer: ValuesAnswer,
): AutofillValue[] {
  const byId = new Map(fields.map((field) => [field.attributeId, field]));
  const variants = new Set(variantIds);
  const seen = new Set<string>();
  const out: AutofillValue[] = [];
  for (const item of answer.values) {
    const field = byId.get(item.attributeId);
    if (!field || field.edit.kind === "blocked" || item.value === null)
      continue;
    const variantId =
      field.scope === "variant" ? (item.variantId ?? null) : null;
    if (field.scope === "variant" && (!variantId || !variants.has(variantId)))
      continue;
    const key = inputKey(field.attributeId, variantId);
    if (seen.has(key) || !isEmptyInput(before[key])) continue;
    const input = inputFor(field.edit, item.value);
    if (input === null || isEmptyInput(input)) continue;
    const checked = metafieldValue(field.edit, input);
    if (!checked.ok || checked.value === null) continue;
    seen.add(key);
    out.push({
      key,
      attributeId: field.attributeId,
      variantId,
      name: field.name,
      input,
      display: displayOf(field.edit, input),
    });
  }
  return out;
}

/** The form a save would post: what was read, with the kept suggestions in. */
export function inputsWithSuggestions(
  before: AttributeInputs,
  values: readonly AutofillValue[],
  keep: ReadonlySet<string> | null,
): AttributeInputs {
  const after: AttributeInputs = { ...before };
  for (const value of values) {
    if (keep !== null && !keep.has(value.key)) continue;
    // A value someone entered since the suggestion was made wins.
    if (!isEmptyInput(before[value.key])) continue;
    after[value.key] = value.input;
  }
  return after;
}

/** Stored suggestions, read back; anything malformed is dropped. */
export const autofillValuesCodec = z.array(
  z.object({
    key: z.string(),
    attributeId: z.string(),
    variantId: z.string().nullable(),
    name: z.string(),
    input: z.union([z.string(), z.array(z.string())]),
    display: z.string(),
  }),
);

/**
 * How sure the categorizer must be of a type it chose for a source set to
 * apply on its own; below it, the suggestion waits for a person.
 */
export const AUTO_APPLY_CONFIDENCE = 0.8;

/**
 * Whether a suggestion may be applied without a person (docs/attributes.md
 * § AI autofill). A type the product already had needs no confidence, so
 * its values go in; a type the categorizer chose must be at or above
 * `AUTO_APPLY_CONFIDENCE`. A suggestion with nothing to apply is left as
 * it is.
 */
export function confidentEnough(suggestion: {
  typeId: string | null;
  typeOrigin: "suggested" | "kept" | null;
  typeConfidence: number | null;
  values: readonly unknown[];
}): boolean {
  if (suggestion.typeId === null) return false;
  if (suggestion.typeOrigin === "kept") return suggestion.values.length > 0;
  return (
    suggestion.typeOrigin === "suggested" &&
    suggestion.typeConfidence !== null &&
    suggestion.typeConfidence >= AUTO_APPLY_CONFIDENCE
  );
}
