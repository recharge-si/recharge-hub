import type { Field, FieldToken } from "~/domain/export-portal/contract";
import {
  FILTERS,
  parseTemplate,
  pickerRows,
  type FieldDef,
  type PickerGroup,
  type TemplateNode,
} from "~/domain/products/template";

/**
 * A portal text field that takes `{fields}`, as the pattern editor sees it.
 *
 * The portal names the fields a value may use, what each comes to for one
 * real product of the source, and that product (docs/sources.md § Fields).
 * This turns that into the editor's registry, rows, preview and lint. Like
 * `order-reference-fields.ts`, it is the whole of what makes a portal field
 * the same control as the name pattern — and like the rest of the source
 * screens, it knows nothing about what any field means.
 *
 * The syntax is the name pattern's own, parsed by `domain/products/template`.
 * The portal renders it with a port of the same parser and filters
 * (`titlePattern.js`), and `renderTokens` follows that port's rules for what
 * an empty token leaves behind, so the preview is what will be pushed.
 */

/** Every field as a chip the editor can draw. */
export function tokenRegistry(tokens: readonly FieldToken[]): FieldDef[] {
  return tokens.map((token) => ({
    id: token.key,
    label: token.label,
    // The picker's grouping is about products; these are one group.
    group: "product",
  }));
}

/** The fields to offer for what is being typed, each with its example. */
export function tokenRows(
  tokens: readonly FieldToken[],
  query: string,
): PickerGroup[] {
  const examples = new Map(tokens.map((t) => [t.key, t.example ?? null]));
  const rows = pickerRows(
    tokenRegistry(tokens),
    query,
    (key) => examples.get(key) ?? null,
  );
  return rows.length > 0 ? [{ id: "tokens", label: "Fields", rows }] : [];
}

const BY_NAME = new Map(FILTERS.map((filter) => [filter.name, filter]));

function renderNodes(
  nodes: TemplateNode[],
  values: ReadonlyMap<string, string>,
): { text: string; filled: boolean; hadToken: boolean } {
  let text = "";
  let filled = false;
  let hadToken = false;
  for (const node of nodes) {
    if (node.kind === "literal") {
      text += node.text;
      continue;
    }
    if (node.kind === "group") {
      const inner = renderNodes(node.children, values);
      if (!inner.hadToken) {
        text += inner.text;
        continue;
      }
      hadToken = true;
      if (inner.filled) {
        text += inner.text;
        filled = true;
      }
      continue;
    }
    hadToken = true;
    const value = node.filters.reduce(
      (current, call) =>
        BY_NAME.get(call.name)?.apply(current, call.args) ?? current,
      values.get(node.field) ?? "",
    );
    if (value !== "") filled = true;
    text += value;
  }
  return { text, filled, hadToken };
}

const SEP = "\\-\u2013\u2014/|,;:\u00b7";
const LEADING = new RegExp(`^[\\s${SEP}]+`);
const ADJACENT = new RegExp(`[${SEP}]\\s*([${SEP}])`, "g");
const ONLY_SEPARATORS = new RegExp(`^[\\s${SEP}]*$`);

/**
 * The value with each field's example filled in: gaps an empty field leaves
 * collapsed, a leading separator dropped, the trailing one kept (it is what
 * joins a prefix to what follows). Empty when it has fields and none of them
 * produced anything.
 */
export function renderTokens(
  value: string,
  tokens: readonly FieldToken[],
): string {
  const values = new Map(tokens.map((t) => [t.key, t.example ?? ""]));
  const rendered = renderNodes(parseTemplate(value).nodes, values);
  if (rendered.hadToken && !rendered.filled) return "";
  let out = rendered.text.replace(/\s+/g, " ");
  let previous = "";
  while (previous !== out) {
    previous = out;
    out = out.replace(ADJACENT, "$1");
  }
  out = out.replace(LEADING, "").replace(/\s+/g, " ").trim();
  return ONLY_SEPARATORS.test(out) ? "" : out;
}

/**
 * What the field comes to for the portal's sample product, the way the
 * MetaKocka name shows it: "UF-1203: Dakine - Seeker Vest". Null with no
 * sample or nothing typed, rather than an invented example.
 */
export function tokenPreview(field: Field, value: string): string | null {
  const tokens = field.tokens ?? [];
  if (!field.sample || value.trim() === "") return null;
  if (!tokens.some((t) => t.example)) return null;
  const filled = renderTokens(value, tokens);
  const text = [filled, field.sample.after].filter(Boolean).join(" ");
  return `${field.sample.label}: ${text}`;
}

/** Why the value would be refused, as one sentence, or null. */
export function tokenError(field: Field, value: string): string | null {
  const { nodes, errors } = parseTemplate(value);
  if (errors.length > 0) return errors[0]!.message;
  const known = new Set((field.tokens ?? []).map((t) => t.key));
  const unknown = new Set<string>();
  const visit = (list: TemplateNode[]) => {
    for (const node of list) {
      if (node.kind === "group") visit(node.children);
      if (node.kind === "token" && !known.has(node.field))
        unknown.add(node.field);
    }
  };
  visit(nodes);
  if (unknown.size === 0) return null;
  const names = [...unknown].map((f) => `{${f}}`).join(", ");
  return `${names} ${unknown.size === 1 ? "is not a field" : "are not fields"} this setting can use.`;
}
