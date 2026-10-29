import {
  metafieldValue,
  storedInput,
  type AttributeInput,
  type FieldEdit,
  type InputKind,
} from "~/domain/products/attribute-values";

/**
 * One spreadsheet cell, both ways (docs/attributes.md § Bulk values). An
 * entry is read with the same validator a person's entry on the product
 * page goes through (`metafieldValue`); this file only turns what a
 * spreadsheet holds into what that validator takes: a yes into `true`, a
 * label into its code, `4,2` into `4.2`.
 *
 * Pure.
 */

/** The cell that removes a value. */
export const CLEAR_TOKEN = "[clear]";

/* -------------------------------------------------------------------------- */
/* Formula injection                                                          */
/* -------------------------------------------------------------------------- */

/** A spreadsheet runs a cell as a formula when it starts like one. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Written on export: a cell a spreadsheet would run as a formula gets a
 * leading apostrophe, which it shows as nothing and does not run.
 */
export function guardCell(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

/** Read on import: undoes `guardCell`, and only that. */
export function unguardCell(text: string): string {
  return text.startsWith("'") && FORMULA_START.test(text.slice(1))
    ? text.slice(1)
    : text;
}

/** One cell as CSV text, guarded and quoted when it needs to be. */
export function csvCell(text: string): string {
  const safe = guardCell(text);
  return /[",\n\r;]/.test(safe) || safe !== safe.trim()
    ? `"${safe.replace(/"/g, '""')}"`
    : safe;
}

/* -------------------------------------------------------------------------- */
/* Stored values                                                              */
/* -------------------------------------------------------------------------- */

interface Stored {
  type: string;
  value: string;
}

/** A number as a short plain string: `5.0` and `5` are the same cell. */
function plainNumber(text: string): string {
  const number = Number(text.trim().replace(",", "."));
  return Number.isFinite(number) ? String(number) : text.trim();
}

/**
 * A stored value in one canonical form, so two spellings of one value
 * compare equal: `"5.0"` and `5`, a measurement's JSON and its number, a
 * list in any order. An empty or missing value is the empty string.
 */
export function canonicalStored(
  kind: InputKind,
  stored: Stored | string | null | undefined,
): string {
  if (stored === null || stored === undefined) return "";
  const raw = typeof stored === "string" ? stored : stored.value;
  if (raw.trim() === "") return "";
  switch (kind) {
    case "integer":
    case "decimal":
      return plainNumber(raw);
    case "measurement": {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && "value" in parsed)
          return plainNumber(String((parsed as { value: unknown }).value));
      } catch {
        // Falls through to the plain reading.
      }
      return plainNumber(raw);
    }
    case "choices": {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed))
          return parsed
            .map((item) => String(item))
            .sort()
            .join("|");
      } catch {
        // Falls through.
      }
      return raw.trim();
    }
    default:
      return raw.trim();
  }
}

const YES_NO = (value: string) => (value === "true" ? "yes" : "no");

/** A stored value as a person reads it in a cell: no unit, no JSON. */
export function cellFromStored(
  edit: FieldEdit,
  stored: Stored | undefined,
): string {
  if (!stored || edit.kind === "blocked") return "";
  const input = storedInput(edit, stored);
  if (Array.isArray(input)) return input.join(", ");
  switch (edit.kind) {
    case "boolean":
      return input === "true" || input === "false" ? YES_NO(input) : input;
    case "decimal":
    case "integer":
    case "measurement":
      return plainNumber(input);
    default:
      return input;
  }
}

/** A value for the preview's before and after: with its unit, options by label. */
export function displayOf(edit: FieldEdit, input: AttributeInput): string {
  if (edit.kind === "blocked") return "";
  const label = (code: string) =>
    edit.options.find((option) => option.code === code)?.label ?? code;
  if (Array.isArray(input)) return input.map(label).join(", ");
  if (input.trim() === "") return "";
  switch (edit.kind) {
    case "choice":
      return label(input);
    case "boolean":
      return input === "true" || input === "false" ? YES_NO(input) : input;
    case "measurement":
    case "decimal":
    case "integer": {
      const number = plainNumber(input);
      return edit.unit ? `${number} ${edit.unit}` : number;
    }
    default:
      return input;
  }
}

/** A stored value for the preview, as `displayOf` would show it. */
export function displayStored(
  edit: FieldEdit,
  stored: Stored | undefined,
): string {
  if (!stored || edit.kind === "blocked") return "";
  return displayOf(edit, storedInput(edit, stored));
}

/* -------------------------------------------------------------------------- */
/* Reading a cell                                                             */
/* -------------------------------------------------------------------------- */

export type CellOutcome =
  | {
      ok: true;
      /** What the field holds after, as a form holds it. */
      input: AttributeInput;
      /** The metafield value to write. */
      value: string;
    }
  | { ok: false; error: string };

const TRUE_WORDS = new Set(["yes", "true"]);
const FALSE_WORDS = new Set(["no", "false"]);
/** A comma between digits is a decimal comma: `4,2`. */
const DECIMAL_COMMA = /^-?\d+,\d+$/;

const norm = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

function optionCode(
  options: ReadonlyArray<{ code: string; label: string }>,
  text: string,
): { ok: true; code: string } | { ok: false; error: string } {
  const wanted = text.trim();
  const exact = options.find((option) => option.code === wanted);
  if (exact) return { ok: true, code: exact.code };
  const folded = norm(wanted);
  const matches = options.filter(
    (option) =>
      norm(option.code) === folded ||
      norm(option.label) === folded ||
      norm(option.code.replace(/_/g, " ")) === folded,
  );
  const codes = [...new Set(matches.map((option) => option.code))];
  if (codes.length === 1 && codes[0] !== undefined)
    return { ok: true, code: codes[0] };
  if (codes.length > 1)
    return {
      ok: false,
      error: `"${wanted}" matches more than one option (${codes.join(", ")}). Use the code.`,
    };
  const known = options
    .slice(0, 6)
    .map((option) => option.code)
    .join(", ");
  return {
    ok: false,
    error: `"${wanted}" is not one of the options${known ? ` (${known}${options.length > 6 ? ", …" : ""})` : ""}.`,
  };
}

/**
 * A cell's text read for a field. Never a range, never a unit inside the
 * number; a select takes an option's code or its label; a list takes its
 * options separated by commas, semicolons or bars.
 */
export function parseCell(edit: FieldEdit, raw: string): CellOutcome {
  if (edit.kind === "blocked") return { ok: false, error: edit.reason };
  const text = raw.trim();
  let input: AttributeInput = text;

  switch (edit.kind) {
    case "decimal":
    case "measurement":
      if (DECIMAL_COMMA.test(text)) input = text.replace(",", ".");
      if (typeof input === "string" && !/^-?\d+(\.\d+)?$/.test(input))
        return {
          ok: false,
          error: `"${text}" is not one number. Enter a number such as 4.2, without a unit and not a range.`,
        };
      break;
    case "integer":
      if (/^-?\d+[.,]0+$/.test(text)) input = text.replace(/[.,]0+$/, "");
      if (typeof input === "string" && !/^-?\d+$/.test(input))
        return { ok: false, error: `"${text}" is not a whole number.` };
      break;
    case "boolean": {
      const word = norm(text);
      if (TRUE_WORDS.has(word)) input = "true";
      else if (FALSE_WORDS.has(word)) input = "false";
      else return { ok: false, error: `"${text}" is not yes or no.` };
      break;
    }
    case "choice": {
      const code = optionCode(edit.options, text);
      if (!code.ok) return code;
      input = code.code;
      break;
    }
    case "choices": {
      const codes: string[] = [];
      for (const part of text.split(/[,;|]/)) {
        if (part.trim() === "") continue;
        const code = optionCode(edit.options, part);
        if (!code.ok) return code;
        codes.push(code.code);
      }
      input = [...new Set(codes)];
      break;
    }
    default:
      break;
  }

  const outcome = metafieldValue(edit, input);
  if (!outcome.ok) return outcome;
  if (outcome.value === null)
    return {
      ok: false,
      error: "That cell holds no value. Use [clear] to remove one.",
    };
  return { ok: true, input, value: outcome.value };
}

export type { InputKind };
