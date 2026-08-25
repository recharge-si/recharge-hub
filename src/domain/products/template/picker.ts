/**
 * The field picker that opens when a merchant types `{`.
 *
 * This is the whole of the picker's behaviour, and none of its rendering: where
 * the caret has to be for the picker to be open, what it should list, what each
 * row resolves to for the product being previewed, and what the field becomes
 * once a row is chosen. Pure (section 5), so the awkward parts — an escaped
 * brace, a caret in the middle of an existing name — are settled by tests
 * rather than by clicking around the settings screen.
 *
 * The rows carry real values from a real variant. There is no sample product in
 * here and no fallback to one: a picker that shows invented values next to a
 * preview of the merchant's own catalogue teaches them the wrong thing about
 * their data.
 */
import { resolveField, type FieldDef } from "./fields";
import {
  MAX_TOKENS,
  parseTemplate,
  serializeTemplate,
  tokensOf,
} from "./parse";
import type { TemplateNode, VariantFacts } from "./types";

/** Characters that may follow `{` while the picker is still open. */
const FIELD_CHARS = /[A-Za-z0-9_.]/;

export interface PickerQuery {
  /** Index of the `{` that opened the picker. */
  start: number;
  /** What has been typed after the brace, lowercased. */
  query: string;
}

/**
 * True when the brace at `index` is escaped, and so is literal text rather than
 * the start of a field. `\{` is an escaped brace; `\\{` is a backslash
 * followed by a real one, so the count of preceding backslashes decides it.
 */
function isEscaped(source: string, index: number): boolean {
  let slashes = 0;
  for (let at = index - 1; at >= 0 && source[at] === "\\"; at -= 1)
    slashes += 1;
  return slashes % 2 === 1;
}

/**
 * The open picker query at this caret, or null when the picker is closed.
 *
 * Open means: an unescaped `{` sits somewhere before the caret with nothing but
 * field characters between it and the caret. A `}` closes the field, and is not
 * a field character, so a completed token never reopens the picker when the
 * merchant moves back through it.
 */
export function pickerQueryAt(
  source: string,
  caret: number,
): PickerQuery | null {
  const at = Math.max(0, Math.min(caret, source.length));

  for (let index = at - 1; index >= 0; index -= 1) {
    const char = source[index] ?? "";

    if (char === "{") {
      if (isEscaped(source, index)) return null;
      return { start: index, query: source.slice(index + 1, at).toLowerCase() };
    }

    if (!FIELD_CHARS.test(char)) return null;
  }

  return null;
}

export interface PickResult {
  source: string;
  caret: number;
}

/**
 * Inserts a field, replacing the half-typed `{query` when the picker is open
 * and inserting at the caret when it is not.
 *
 * Nothing is added around the token — no space, no separator. The merchant is
 * typing a name and knows where they are in it, and a helpful space inserted
 * where they did not ask for one is the kind of thing that makes a field feel
 * like it is arguing with you.
 */
export function applyPick(
  source: string,
  caret: number,
  fieldId: string,
): PickResult {
  const token = `{${fieldId}}`;
  const active = pickerQueryAt(source, caret);
  const start = active
    ? active.start
    : Math.max(0, Math.min(caret, source.length));
  const end = Math.max(start, Math.min(caret, source.length));

  return {
    source: `${source.slice(0, start)}${token}${source.slice(end)}`,
    caret: start + token.length,
  };
}

/**
 * Escape leaves the literal brace where it is: the merchant may have meant to
 * type one. Closing the picker is a UI state change, not an edit, so there is
 * nothing here to call — this comment is the documentation of that decision.
 */

export type PickerGroupId = "product" | "variant" | "options" | "metafield";

/**
 * Option fields come out of `fields.ts` in the variant group, because that is
 * where they belong to the renderer. The picker splits them out: a merchant
 * looking for "colour" is looking under options, not under a list that also
 * holds the barcode and the price.
 */
const OPTION_IDS = new Set([
  "options",
  "option1",
  "option2",
  "option3",
  "option1name",
  "option2name",
  "option3name",
]);

const GROUP_ORDER: { id: PickerGroupId; label: string }[] = [
  { id: "product", label: "Product" },
  { id: "variant", label: "Variant" },
  { id: "options", label: "Options" },
  { id: "metafield", label: "Metafields" },
];

function groupOf(field: FieldDef): PickerGroupId {
  if (field.group === "metafield") return "metafield";
  if (OPTION_IDS.has(field.id)) return "options";
  return field.group === "product" ? "product" : "variant";
}

export interface PickerRow {
  field: FieldDef;
  /**
   * What this field resolves to for the previewed variant. Null when there is
   * no variant to resolve against — an empty catalogue — and never a stand-in.
   */
  value: string | null;
}

export interface PickerGroup {
  id: PickerGroupId;
  label: string;
  rows: PickerRow[];
}

function matchesQuery(field: FieldDef, query: string): boolean {
  if (query === "") return true;
  return (
    field.id.toLowerCase().includes(query) ||
    field.label.toLowerCase().includes(query)
  );
}

/**
 * The rows to show, grouped and in reading order. Empty groups are dropped, so
 * a shop with no metafield definitions never sees an empty Metafields heading.
 */
export function pickerGroups(
  registry: FieldDef[],
  query: string,
  facts: VariantFacts | null,
): PickerGroup[] {
  const needle = query.trim().toLowerCase();

  return GROUP_ORDER.map(({ id, label }) => ({
    id,
    label,
    rows: registry
      .filter((field) => groupOf(field) === id && matchesQuery(field, needle))
      .map((field) => ({
        field,
        value: facts ? (resolveField(field.id, facts) ?? "") : null,
      })),
  })).filter((group) => group.rows.length > 0);
}

/** Total rows across groups, for "nothing matches" and for keyboard paging. */
export function flattenGroups(groups: PickerGroup[]): PickerRow[] {
  return groups.flatMap((group) => group.rows);
}

/**
 * Whether another field can be added. The cap is the parser's, so a template
 * the editor builds can always be read back by it.
 */
export function canAddField(nodes: TemplateNode[]): boolean {
  return tokensOf(nodes).length < MAX_TOKENS;
}

/* -------------------------------------------------------------------------- */
/* Reading a pattern back as parts, and taking one out                        */
/* -------------------------------------------------------------------------- */

export interface PatternPart {
  /** Where it starts in the source, which is also how it is addressed. */
  start: number;
  /** A field, or the merchant's own words between fields. */
  kind: "field" | "text";
  /** The field's label, or the literal text. */
  label: string;
  /** What the field resolves to for the previewed variant. Null for text. */
  value: string | null;
  /** False when the field does not exist, so the editor can say so. */
  known: boolean;
}

/**
 * A pattern as a row of parts a merchant can read.
 *
 * `{title}[ {options}]` tells nobody anything. "Product title" followed by
 * "All option values" does, and so does seeing what each one is for one of
 * their own products. Groups are flattened: the brackets are a rendering rule
 * about empty values, not a thing to look at.
 */
export function patternParts(
  source: string,
  registry: FieldDef[],
  facts: VariantFacts | null,
): PatternPart[] {
  const byId = new Map(registry.map((field) => [field.id, field]));

  const walk = (nodes: TemplateNode[]): PatternPart[] =>
    nodes.flatMap((node) => {
      if (node.kind === "group") return walk(node.children);

      if (node.kind === "literal") {
        const text = node.text.trim();
        return text === ""
          ? []
          : [
              {
                start: node.start,
                kind: "text" as const,
                label: text,
                value: null,
                known: true,
              },
            ];
      }

      const field = byId.get(node.field);
      const resolved = facts ? resolveField(node.field, facts) : null;
      return [
        {
          start: node.start,
          kind: "field" as const,
          label: field?.label ?? node.field,
          value: resolved,
          known: resolved !== null,
        },
      ];
    });

  return walk(parseTemplate(source).nodes);
}

/** Separators that mean nothing once the field beside them has gone. */
const EDGE = /^[\s\-–—/|,;:]+|[\s\-–—/|,;:]+$/g;

function stripToken(nodes: TemplateNode[], start: number): TemplateNode[] {
  return nodes.flatMap((node): TemplateNode[] => {
    if (node.kind === "token") return node.start === start ? [] : [node];

    if (node.kind === "group") {
      const children = stripToken(node.children, start);
      // A group exists to make its separator vanish with its field. With the
      // field gone the group is a separator on its own, so it goes too.
      if (
        tokensOf(node.children).length > 0 &&
        tokensOf(children).length === 0
      ) {
        return [];
      }
      return [{ ...node, children }];
    }

    return [node];
  });
}

/**
 * Removes one field from a pattern, and the punctuation it leaves stranded.
 *
 * Addressed by its position in the source, because that is what identifies one
 * `{options}` among several. Returns the pattern unchanged when nothing sits
 * there, so a stale click cannot rewrite something else.
 */
export function removeFieldAt(source: string, start: number): string {
  const { nodes } = parseTemplate(source);
  if (!tokensOf(nodes).some((token) => token.start === start)) return source;

  return serializeTemplate(stripToken(nodes, start)).replace(EDGE, "");
}
