/**
 * Turns a template plus one variant into the name that goes to MetaKocka.
 *
 * The whole design question here is what happens when a token resolves empty,
 * because that is what separates "T-Shirt" from "T-Shirt -" on a product with
 * no options. Three mechanisms handle it, in this order:
 *
 *  1. `prefix`/`suffix` attach the separator to the token, so an empty value
 *     takes its separator with it (see `filters.ts`).
 *  2. A `[...]` group vanishes whole when every token inside it resolved empty,
 *     which is how a separator shared by two tokens disappears.
 *  3. Whatever still ends up stranded — doubled spaces, a leading dash, two
 *     separators that have become neighbours — is cleaned up at the end.
 *
 * Step 3 exists because 1 and 2 cannot catch everything: a merchant writing
 * plain `{title} - {options}` with no group and no filters still deserves a
 * clean name. It is deliberately last, and deliberately conservative — it only
 * removes separators that have nothing left on one side.
 *
 * This module is the single implementation. The sync job and the preview screen
 * both call it, and a test asserts they agree: a preview that can drift from
 * the job is a data-corruption bug, not a cosmetic one.
 */
import { applyFilters } from "./filters";
import { resolveField } from "./fields";
import { parseTemplate } from "./parse";
import type { TemplateNode, VariantFacts } from "./types";

/**
 * Characters that join parts of a name and mean nothing on their own. A run of
 * them, or one at either end, is left over from a token that resolved empty.
 */
const SEPARATORS = "\\-\u2013\u2014/|,;:";

const LEADING = new RegExp(`^[\\s${SEPARATORS}]+`);
const TRAILING = new RegExp(`[\\s${SEPARATORS}]+$`);
const ADJACENT = new RegExp(`([${SEPARATORS}])\\s*[${SEPARATORS}]`, "g");

/**
 * Collapses the gaps an empty token leaves behind.
 *
 * Order matters. Whitespace is collapsed first so that "A  -  - B" becomes a
 * shape the adjacency rule can see; adjacency runs to a fixed point because
 * removing one separator can make two others neighbours; the ends are trimmed
 * last, once nothing more is going to move.
 */
export function tidy(text: string): string {
  let out = text.replace(/\s+/g, " ");

  // Punctuation that belongs tight against the word before it.
  out = out.replace(/\s+([,;:.])/g, "$1");
  out = out.replace(/([([])\s+/g, "$1");
  out = out.replace(/\s+([)\]])/g, "$1");

  // A group whose contents vanished can leave empty brackets behind.
  out = out.replace(/\(\s*\)/g, "").replace(/\[\s*\]/g, "");

  let previous = "";
  while (previous !== out) {
    previous = out;
    out = out.replace(ADJACENT, "$1");
  }

  out = out.replace(LEADING, "").replace(TRAILING, "");
  return out.replace(/\s+/g, " ").trim();
}

interface Rendered {
  text: string;
  /** True when at least one token in this run produced a value. */
  filled: boolean;
  /** True when this run contained a token at all. */
  hadToken: boolean;
}

function renderNodes(nodes: TemplateNode[], facts: VariantFacts): Rendered {
  let text = "";
  let filled = false;
  let hadToken = false;

  for (const node of nodes) {
    if (node.kind === "literal") {
      text += node.text;
      continue;
    }

    if (node.kind === "group") {
      const inner = renderNodes(node.children, facts);
      // A group with no token in it is literal text the merchant wanted kept.
      if (!inner.hadToken) {
        text += inner.text;
        continue;
      }
      if (inner.filled) {
        text += inner.text;
        filled = true;
        hadToken = true;
      } else {
        hadToken = true;
      }
      continue;
    }

    hadToken = true;
    const raw = resolveField(node.field, facts);

    if (raw === null) {
      // An unknown field stays visible rather than being silently dropped. A
      // typo that quietly produces the wrong name in the ERP is worse than one
      // the merchant can see in the preview.
      text += `{${node.field}}`;
      filled = true;
      continue;
    }

    const value = applyFilters(raw, node.filters);
    if (value !== "") filled = true;
    text += value;
  }

  return { text, filled, hadToken };
}

export interface RenderOptions {
  /**
   * Truncation is a backstop, not a feature: MetaKocka publishes no length
   * limit for a product name, so this only exists to stop something absurd
   * reaching the ERP. Pass Infinity to render untruncated.
   */
  maxLength?: number;
}

export const MAX_NAME_LENGTH = 250;

/**
 * The name before truncation, and whether the template produced it.
 *
 * Split out of `renderTemplate` so lint can measure the length the merchant
 * actually wrote against the cap without re-deriving the fallback rule. Nothing
 * about the result changes: `renderTemplate` is this, truncated.
 */
function composeName(
  nodes: TemplateNode[],
  facts: VariantFacts,
): { name: string; usedFallback: boolean } {
  const rendered = tidy(renderNodes(nodes, facts).text);

  // A template that renders to nothing would create a nameless product. The
  // product title, then the SKU, is a better answer than an empty name.
  return {
    name: rendered || facts.productTitle.trim() || facts.sku,
    usedFallback: rendered === "",
  };
}

/**
 * Renders one product name. Never throws: a template the merchant typed badly
 * shows a visible result in the preview rather than failing a sync at midnight.
 */
export function renderTemplate(
  nodes: TemplateNode[],
  facts: VariantFacts,
  options: RenderOptions = {},
): string {
  const maxLength = options.maxLength ?? MAX_NAME_LENGTH;
  const { name } = composeName(nodes, facts);

  return name.length > maxLength ? name.slice(0, maxLength).trim() : name;
}

export interface RenderTrace {
  name: string;
  /** What each token resolved to, keyed by its position in the source. */
  tokens: { field: string; start: number; value: string; known: boolean }[];
  /**
   * True when the template rendered to nothing and the title or SKU stood in.
   * The merchant did not ask for that name, so lint reports it.
   */
  usedFallback: boolean;
  /**
   * How long the name was before `maxLength` was applied. `name` is already
   * truncated, so it cannot answer "is this over the cap" on its own.
   */
  rawLength: number;
}

/** Renders and reports what each token contributed, for lint and the editor. */
export function renderWithTrace(
  nodes: TemplateNode[],
  facts: VariantFacts,
  options: RenderOptions = {},
): RenderTrace {
  const tokens: RenderTrace["tokens"] = [];

  const visit = (list: TemplateNode[]) => {
    for (const node of list) {
      if (node.kind === "group") visit(node.children);
      if (node.kind !== "token") continue;
      const raw = resolveField(node.field, facts);
      tokens.push({
        field: node.field,
        start: node.start,
        value: raw === null ? "" : applyFilters(raw, node.filters),
        known: raw !== null,
      });
    }
  };
  visit(nodes);

  const composed = composeName(nodes, facts);
  return {
    name: renderTemplate(nodes, facts, options),
    tokens,
    usedFallback: composed.usedFallback,
    rawLength: composed.name.length,
  };
}

/** Convenience for callers holding a template string rather than nodes. */
export function renderName(
  template: string,
  facts: VariantFacts,
  options: RenderOptions = {},
): string {
  return renderTemplate(parseTemplate(template).nodes, facts, options);
}
