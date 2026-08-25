/**
 * Reads a template string into nodes, and writes nodes back out again.
 *
 * Parsing never throws. A merchant types into this field, so half-finished
 * input is the normal state, not an exceptional one: a malformed template
 * returns the best nodes we can make of it plus errors carrying position,
 * length and a code, and the editor underlines the bad part while the rest of
 * the preview keeps working.
 *
 *   template := (literal | group | token)*
 *   group    := "[" (literal | token)* "]"
 *   token    := "{" field ("|" filter)* "}"
 *   field    := [a-z0-9_.]+
 *   filter   := name (":" arg)*
 *
 * A backslash escapes a literal brace, bracket or backslash.
 *
 * `parseTemplate` and `serializeTemplate` are inverses: serializing parsed
 * nodes and parsing the result gives the same nodes back. The test file holds
 * that to a generated corpus, because an editor that rewrites what the merchant
 * typed every time it round-trips is unusable.
 */
import { findFilter } from "./filters";
import type {
  FilterCall,
  ParseError,
  ParseResult,
  TemplateNode,
} from "./types";

const FIELD = /^[a-z0-9_.]+$/;
const ESCAPABLE = new Set(["{", "}", "[", "]", "\\"]);

/** Caps, so a pasted novel cannot become a parse loop or a database row. */
export const MAX_TEMPLATE_LENGTH = 500;
export const MAX_TOKENS = 24;

interface Cursor {
  source: string;
  at: number;
}

/**
 * Filter arguments are either quoted or bare. Quoting matters: a quoted
 * argument may contain the colon that otherwise separates arguments, which is
 * what lets a separator like `" - "` be written at all.
 */
function parseFilterArgs(
  raw: string,
  start: number,
  errors: ParseError[],
): string[] {
  const args: string[] = [];
  let index = 0;

  while (index < raw.length) {
    if (raw[index] === ":") {
      index += 1;
      continue;
    }

    if (raw[index] === '"') {
      let value = "";
      index += 1;
      let closed = false;
      while (index < raw.length) {
        const char = raw[index];
        if (char === "\\" && index + 1 < raw.length) {
          value += raw[index + 1];
          index += 2;
          continue;
        }
        if (char === '"') {
          closed = true;
          index += 1;
          break;
        }
        value += char;
        index += 1;
      }
      if (!closed) {
        errors.push({
          code: "bad_filter_args",
          message: "A quoted value is missing its closing quotation mark.",
          start,
          length: raw.length,
        });
      }
      args.push(value);
      continue;
    }

    let value = "";
    while (index < raw.length && raw[index] !== ":") {
      value += raw[index];
      index += 1;
    }
    args.push(value);
  }

  return args;
}

function parseToken(cursor: Cursor, errors: ParseError[]): TemplateNode | null {
  const start = cursor.at;
  const close = cursor.source.indexOf("}", start + 1);

  if (close === -1) {
    errors.push({
      code: "unclosed_token",
      message: "This token is missing its closing brace.",
      start,
      length: cursor.source.length - start,
    });
    cursor.at = cursor.source.length;
    return null;
  }

  const inner = cursor.source.slice(start + 1, close);
  const length = close - start + 1;
  cursor.at = close + 1;

  const [rawField = "", ...rawFilters] = inner.split("|");
  const field = rawField.trim().toLowerCase();

  if (field === "") {
    errors.push({
      code: "empty_field",
      message: "This token has no field in it.",
      start,
      length,
    });
    return null;
  }

  if (!FIELD.test(field)) {
    errors.push({
      code: "bad_field",
      message: `"${rawField.trim()}" is not a field name. Use letters, numbers, underscores and dots.`,
      start,
      length,
    });
    return null;
  }

  const filters: FilterCall[] = [];
  for (const rawFilter of rawFilters) {
    const trimmed = rawFilter.trim();
    if (trimmed === "") continue;

    const colon = trimmed.indexOf(":");
    const name = (colon === -1 ? trimmed : trimmed.slice(0, colon))
      .trim()
      .toLowerCase();
    const spec = findFilter(name);

    if (!spec) {
      errors.push({
        code: "unknown_filter",
        message: `"${name}" is not a filter. Remove it, or pick one from the list.`,
        start,
        length,
      });
      continue;
    }

    const args =
      colon === -1 ? [] : parseFilterArgs(trimmed.slice(colon), start, errors);

    if (args.length < spec.minArgs || args.length > spec.maxArgs) {
      errors.push({
        code: "bad_filter_args",
        message:
          spec.minArgs === spec.maxArgs
            ? `"${name}" takes ${spec.minArgs} ${spec.minArgs === 1 ? "value" : "values"}.`
            : `"${name}" takes between ${spec.minArgs} and ${spec.maxArgs} values.`,
        start,
        length,
      });
      continue;
    }

    filters.push({ name, args });
  }

  return { kind: "token", field, filters, start, length };
}

function parseNodes(
  cursor: Cursor,
  errors: ParseError[],
  insideGroup: boolean,
): TemplateNode[] {
  const nodes: TemplateNode[] = [];
  let literal = "";
  let literalStart = cursor.at;

  const flush = () => {
    if (literal === "") return;
    nodes.push({
      kind: "literal",
      text: literal,
      start: literalStart,
      length: cursor.at - literalStart,
    });
    literal = "";
  };

  while (cursor.at < cursor.source.length) {
    const char = cursor.source[cursor.at] ?? "";

    if (char === "\\" && ESCAPABLE.has(cursor.source[cursor.at + 1] ?? "")) {
      literal += cursor.source[cursor.at + 1];
      cursor.at += 2;
      continue;
    }

    if (char === "{") {
      flush();
      const token = parseToken(cursor, errors);
      if (token) nodes.push(token);
      literalStart = cursor.at;
      continue;
    }

    if (char === "[") {
      flush();
      const start = cursor.at;

      if (insideGroup) {
        // One level is all the syntax needs, and nesting reads as a mistake far
        // more often than as intent.
        errors.push({
          code: "nested_group",
          message: "An optional group cannot contain another one.",
          start,
          length: 1,
        });
        cursor.at += 1;
        literalStart = cursor.at;
        continue;
      }

      cursor.at += 1;
      const children = parseNodes(cursor, errors, true);

      if (cursor.source[cursor.at] !== "]") {
        errors.push({
          code: "unclosed_group",
          message: "This optional group is missing its closing bracket.",
          start,
          length: cursor.source.length - start,
        });
      } else {
        cursor.at += 1;
      }

      nodes.push({ kind: "group", children, start, length: cursor.at - start });
      literalStart = cursor.at;
      continue;
    }

    if (char === "]") {
      if (insideGroup) {
        flush();
        return nodes;
      }
      flush();
      errors.push({
        code: "unexpected_group_close",
        message: "This bracket closes an optional group that was never opened.",
        start: cursor.at,
        length: 1,
      });
      cursor.at += 1;
      literalStart = cursor.at;
      continue;
    }

    literal += char;
    cursor.at += 1;
  }

  flush();
  return nodes;
}

export function parseTemplate(source: string): ParseResult {
  const errors: ParseError[] = [];
  const cursor: Cursor = { source, at: 0 };
  const nodes = parseNodes(cursor, errors, false);
  return { nodes, errors };
}

function escapeLiteral(text: string): string {
  return text.replace(/[\\{}[\]]/g, (char) => `\\${char}`);
}

function serializeArg(arg: string): string {
  // Bare numbers stay bare, so `truncate:20` round-trips as itself rather than
  // growing a pair of quotes every time the editor saves.
  if (/^\d+$/.test(arg)) return arg;
  return `"${arg.replace(/(["\\])/g, "\\$1")}"`;
}

export function serializeTemplate(nodes: TemplateNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === "literal") return escapeLiteral(node.text);
      if (node.kind === "group") return `[${serializeTemplate(node.children)}]`;

      const filters = node.filters
        .map((filter) =>
          filter.args.length === 0
            ? `|${filter.name}`
            : `|${filter.name}:${filter.args.map(serializeArg).join(":")}`,
        )
        .join("");
      return `{${node.field}${filters}}`;
    })
    .join("");
}

/** Every token in a tree, groups included. */
export function tokensOf(
  nodes: TemplateNode[],
): Extract<TemplateNode, { kind: "token" }>[] {
  return nodes.flatMap((node) =>
    node.kind === "group"
      ? tokensOf(node.children)
      : node.kind === "token"
        ? [node]
        : [],
  );
}
