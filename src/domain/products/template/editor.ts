/**
 * The pattern as a flat row of atoms, which is what an inline editor edits.
 *
 * The stored value stays a plain string. This is the shape that string takes
 * while somebody is working on it: a sequence where each entry is either the
 * merchant's own words or one field, and where concatenating every entry's
 * `src` gives the string back. Everything the editor does — inserting,
 * removing, changing a field's options — is a change to this list followed by
 * a concatenation, so the string is never assembled by hand and never drifts
 * from what the parser would read.
 *
 * ## Why a group can be part of an atom
 *
 * `[ - {options}]` is not a separator and a field, it is one idea: "the options
 * with a dash in front, and neither if there are no options". An editor that
 * showed the bracket, the dash and the field as three things to move
 * independently would be showing the merchant the implementation. So a group
 * holding exactly one field becomes that field's atom, with the literal text
 * either side of it carried as `before` and `after`.
 *
 * A group holding more than one field cannot collapse that way, and its
 * brackets become ordinary text. That is rarer, and the alternative — hiding
 * structure the merchant cannot then edit — is worse than showing it.
 *
 * Pure (section 5). `tests/unit/template-editor.test.ts` holds the round trip.
 */
import { parseTemplate, serializeTemplate, tokensOf } from "./parse";
import type { FilterCall, TemplateNode } from "./types";

export interface TextAtom {
  kind: "text";
  /** Exactly what this contributes to the pattern, escapes included. */
  src: string;
  /** The same text as the merchant sees and types it. */
  text: string;
}

export interface FieldAtom {
  kind: "field";
  src: string;
  field: string;
  filters: FilterCall[];
  /** Literal text bound to the field, inside its group. Usually a separator. */
  before: string;
  after: string;
  /**
   * True when the field sits in a group of its own, so it and its separator
   * disappear together on a product that has no value for it.
   */
  optional: boolean;
}

export type Atom = TextAtom | FieldAtom;

function node(text: string): TemplateNode {
  return { kind: "literal", text, start: 0, length: 0 };
}

/** The source for one field atom, built by the serializer rather than by hand. */
export function fieldSrc(atom: Omit<FieldAtom, "kind" | "src">): string {
  const inner: TemplateNode[] = [
    ...(atom.before === "" ? [] : [node(atom.before)]),
    {
      kind: "token",
      field: atom.field,
      filters: atom.filters,
      start: 0,
      length: 0,
    },
    ...(atom.after === "" ? [] : [node(atom.after)]),
  ];

  return atom.optional
    ? serializeTemplate([
        { kind: "group", children: inner, start: 0, length: 0 },
      ])
    : serializeTemplate(inner);
}

/**
 * The spread comes first on purpose. Callers pass a whole `FieldAtom` back in
 * — `{ ...atom, filters }` — and that object still carries the old `src` at
 * runtime whatever the parameter type says. Spreading it last put the stale
 * source back over the one just built, so every change to a field silently
 * did nothing.
 */
function fieldAtom(atom: Omit<FieldAtom, "kind" | "src">): FieldAtom {
  return { ...atom, kind: "field", src: fieldSrc(atom) };
}

function textAtom(text: string): TextAtom {
  return { kind: "text", src: serializeTemplate([node(text)]), text };
}

/**
 * A bracket that is syntax rather than something the merchant typed.
 *
 * `textAtom` escapes what it is given, which is right for a literal `[` in a
 * name and wrong for the bracket opening a group. Running a group boundary
 * through it turned `[ m2]` into `\[ m2\]` and quietly changed a group into
 * two escaped characters.
 */
function syntaxAtom(src: string): TextAtom {
  return { kind: "text", src, text: src };
}

function walk(nodes: TemplateNode[]): Atom[] {
  return nodes.flatMap((current): Atom[] => {
    if (current.kind === "literal") return [textAtom(current.text)];

    if (current.kind === "token") {
      return [
        fieldAtom({
          field: current.field,
          filters: current.filters,
          before: "",
          after: "",
          optional: false,
        }),
      ];
    }

    const inside = tokensOf(current.children);

    // One field: the group is that field's own, and collapses into it.
    if (inside.length === 1) {
      const token = inside[0]!;
      const at = current.children.indexOf(token);
      const literal = (list: TemplateNode[]) =>
        list
          .map((entry) => (entry.kind === "literal" ? entry.text : ""))
          .join("");

      return [
        fieldAtom({
          field: token.field,
          filters: token.filters,
          before: literal(current.children.slice(0, at)),
          after: literal(current.children.slice(at + 1)),
          optional: true,
        }),
      ];
    }

    // Two or more, or none: nothing to collapse into, so the brackets stay as
    // themselves rather than becoming a field's business.
    return [syntaxAtom("["), ...walk(current.children), syntaxAtom("]")];
  });
}

export function toAtoms(source: string): Atom[] {
  return walk(parseTemplate(source).nodes);
}

export function fromAtoms(atoms: Atom[]): string {
  return atoms.map((atom) => atom.src).join("");
}

/* -------------------------------------------------------------------------- */
/* Changing one atom                                                          */
/* -------------------------------------------------------------------------- */

/** Replaces a field's options, rebuilding its source through the serializer. */
export function withFilters(atom: FieldAtom, filters: FilterCall[]): FieldAtom {
  return fieldAtom({ ...atom, filters });
}

/** Turns the surrounding group on or off, which is what "optional" means. */
export function withOptional(atom: FieldAtom, optional: boolean): FieldAtom {
  return fieldAtom({ ...atom, optional });
}

/** Replaces the separator carried before or after the field. */
export function withSeparators(
  atom: FieldAtom,
  before: string,
  after: string,
): FieldAtom {
  return fieldAtom({ ...atom, before, after });
}

/** One filter's argument, or "" when the filter is not applied at all. */
export function filterArg(atom: FieldAtom, name: string, index = 0): string {
  return atom.filters.find((call) => call.name === name)?.args[index] ?? "";
}

export function hasFilter(atom: FieldAtom, name: string): boolean {
  return atom.filters.some((call) => call.name === name);
}

/**
 * Adds, replaces or drops one filter, keeping the order the others are in.
 *
 * Passing no arguments removes it. That is what an emptied field in the
 * options popover means, and it is the difference between "no fallback" and "a
 * fallback of nothing" — the second would make every empty value non-empty and
 * defeat the collapsing rules the renderer depends on.
 */
export function withFilter(
  atom: FieldAtom,
  name: string,
  args: string[] | null,
): FieldAtom {
  const without = atom.filters.filter((call) => call.name !== name);

  // `[].every(...)` is true, so an empty list read as "every argument is
  // empty" and removed every filter that takes no arguments — `upper` could
  // never be turned on. Only a filter that wants arguments can be emptied.
  const emptied =
    args !== null && args.length > 0 && args.every((a) => a === "");
  if (args === null || emptied) return withFilters(atom, without);

  const at = atom.filters.findIndex((call) => call.name === name);
  const next = [...without];
  next.splice(at === -1 ? next.length : at, 0, { name, args });
  return withFilters(atom, next);
}

/* -------------------------------------------------------------------------- */
/* Editing the row                                                            */
/* -------------------------------------------------------------------------- */

/** Text a merchant typed, ready to sit in a pattern. */
export function makeTextAtom(text: string): TextAtom {
  return textAtom(text);
}

/** The source form of literal text, with braces and brackets escaped. */
export function escapeText(text: string): string {
  return textAtom(text).src;
}

/**
 * Punctuation at the end of what has been typed, which a field about to be
 * inserted should take responsibility for.
 */
const TRAILING_SEPARATOR = /[\s\-\u2013\u2014/|,;:]+$/;

export interface EditResult {
  atoms: Atom[];
  /** Which atom the caret belongs after. */
  caret: number;
}

/**
 * Puts a field into the row, and gives it the separator in front of it.
 *
 * This is the one piece of judgement in the editor. Typing "Shirt - " and then
 * choosing Options could produce `Shirt - {options}`, and on a product with no
 * options that name ends "Shirt -". Handing the dash to the field instead —
 * `Shirt[ - {options}]` — is what makes it vanish along with the value, which
 * is the behaviour every shipped pattern already relies on.
 *
 * Only a separator is taken. Typing "Shirt" and inserting a field leaves
 * "Shirt" alone: a word is not punctuation and does not belong to what follows
 * it.
 */
export function insertField(
  atoms: Atom[],
  at: number,
  from: number,
  to: number,
  field: string,
): EditResult {
  const target = atoms[at];

  // The caret was not in text — between two fields, or in an empty row. There
  // is nothing to take a separator from, so the field goes in bare.
  if (!target || target.kind !== "text") {
    const bare = fieldAtom({
      field,
      filters: [],
      before: "",
      after: "",
      optional: false,
    });
    const index = Math.max(0, Math.min(at + 1, atoms.length));
    return {
      atoms: [...atoms.slice(0, index), bare, ...atoms.slice(index)],
      caret: index,
    };
  }

  const before = target.text.slice(0, Math.max(0, from));
  const after = target.text.slice(Math.max(0, to));
  const separator = TRAILING_SEPARATOR.exec(before)?.[0] ?? "";
  const kept = before.slice(0, before.length - separator.length);

  const inserted = fieldAtom({
    field,
    filters: [],
    before: separator,
    after: "",
    optional: separator !== "",
  });

  const middle: Atom[] = [
    ...(kept === "" ? [] : [textAtom(kept)]),
    inserted,
    ...(after === "" ? [] : [textAtom(after)]),
  ];

  return {
    atoms: [...atoms.slice(0, at), ...middle, ...atoms.slice(at + 1)],
    caret: at + (kept === "" ? 0 : 1),
  };
}

/**
 * Takes a field out, and puts its separator back into the text beside it.
 *
 * The separator belonged to the field, so dropping it with the field would
 * silently delete something the merchant typed. It goes back where it came
 * from, and if it is then stranded at either end the caller's own tidying
 * takes it — this function does not decide that on their behalf.
 */
export function removeAtom(atoms: Atom[], at: number): EditResult {
  const target = atoms[at];
  if (!target) return { atoms, caret: Math.max(0, at - 1) };

  const rest = [...atoms.slice(0, at), ...atoms.slice(at + 1)];
  return { atoms: rest, caret: Math.max(0, at - 1) };
}

/**
 * Merges neighbouring text so the row never holds two text atoms in a row.
 *
 * The browser splits and joins text nodes as it pleases while somebody types,
 * and a row read straight back from the DOM reflects that. Normalising here
 * keeps atom positions meaning the same thing from one keystroke to the next.
 */
export function normaliseAtoms(atoms: Atom[]): Atom[] {
  const out: Atom[] = [];

  for (const atom of atoms) {
    const last = out[out.length - 1];
    if (atom.kind === "text" && atom.text === "") continue;

    if (atom.kind === "text" && last?.kind === "text") {
      out[out.length - 1] = textAtom(last.text + atom.text);
      continue;
    }
    out.push(atom);
  }

  return out;
}
