/**
 * What is wrong with a template, judged against real variants.
 *
 * Severity is not decoration. An `error` blocks saving because it corrupts data
 * in the ERP; a `warning` is something the merchant should look at and may well
 * accept. The line between them is drawn here and nowhere else, so the UI never
 * has to decide what a diagnostic means.
 *
 * The sharpest rule is the duplicate-name one. MetaKocka matches products by
 * name in several places, so two variants sharing a name is not a cosmetic
 * problem — it is two products the ERP can no longer tell apart.
 *
 * Every diagnostic carries a count and a few sample SKUs, because "some product
 * is wrong" is not something a merchant can act on.
 */
import { VARIANT_LEVEL_IDS, METAFIELD_PREFIX } from "./fields";
import { tokensOf } from "./parse";
import { MAX_NAME_LENGTH, renderWithTrace } from "./render";
import type { Diagnostic, TemplateNode, VariantFacts } from "./types";

const SAMPLES = 5;

function sample(ids: string[]): string[] {
  return ids.slice(0, SAMPLES);
}

function plural(count: number): string {
  return count === 1 ? "product" : "products";
}

/** Punctuation hanging off either end of a word, which is not part of it. */
const WORD_EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/**
 * The words of a name, for the repeat rule.
 *
 * Split on whitespace rather than on runs of letters, so "5.4" stays one word.
 * Splitting finer would read "5.4" and "4.5" as sharing both their digits and
 * report a repeat in a name that has none.
 */
function wordsOf(name: string): string[] {
  return name
    .split(/\s+/)
    .map((part) => part.replace(WORD_EDGES, ""))
    .filter((part) => part !== "");
}

/** Words appearing more than once in one name, lowercased. */
function repeatsIn(name: string): string[] {
  const counts = new Map<string, number>();
  for (const word of wordsOf(name)) {
    const key = word.toLocaleLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, seen]) => seen > 1)
    .map(([word]) => word);
}

export interface LintInput {
  nodes: TemplateNode[];
  variants: VariantFacts[];
  /** `namespace.key` for every metafield the shop still defines. */
  knownMetafields?: Set<string>;
}

export function lintTemplate({
  nodes,
  variants,
  knownMetafields,
}: LintInput): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const tokens = tokensOf(nodes);

  if (variants.length === 0) return diagnostics;

  const traces = variants.map((facts) => ({
    facts,
    trace: renderWithTrace(nodes, facts),
  }));

  /* ---------------------------------------------------------------- errors */

  // A field that does not exist is written into the name as the merchant typed
  // it, braces and all, for every product. Blocking, because the alternative is
  // discovering "{titel}" across the ERP catalogue after the sync has run.
  const unknownFields = new Set<string>();
  for (const { trace } of traces) {
    for (const token of trace.tokens) {
      if (!token.known) unknownFields.add(token.field);
    }
  }
  for (const field of unknownFields) {
    diagnostics.push({
      code: "unknown_field",
      severity: "error",
      message: `There is no field called {${field}}, so it would be written into every name exactly as it appears here. Choose a field from the list, or remove it.`,
      count: traces.length,
      sampleIds: sample(traces.map(({ facts }) => facts.sku)),
    });
  }

  // Two variants that resolve to the same name become one product in the ERP.
  const byName = new Map<string, string[]>();
  for (const { facts, trace } of traces) {
    const key = trace.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), facts.sku]);
  }
  const collisions = [...byName.values()].filter((skus) => skus.length > 1);
  if (collisions.length > 0) {
    const affected = collisions.flat();
    diagnostics.push({
      code: "duplicate_name",
      severity: "error",
      message: `${affected.length} products would share a name with another product. MetaKocka matches products by name, so these would be impossible to tell apart. Add a field that differs between variants, such as the SKU or an option.`,
      count: affected.length,
      sampleIds: sample(affected),
    });
  }

  /* -------------------------------------------------------------- warnings */

  // Every field resolved empty. The renderer falls back to the title or the SKU
  // rather than writing a nameless product, so nothing is corrupted — but the
  // merchant did not ask for that name, and should know they are getting it.
  const empty = traces
    .filter(({ trace }) => trace.usedFallback)
    .map(({ facts }) => facts.sku);
  if (empty.length > 0) {
    diagnostics.push({
      code: "empty_name",
      severity: "warning",
      message: `Every field is empty for ${empty.length} ${plural(empty.length)}, so the product title would be used as the name instead. Add a field that always has a value, such as the product title.`,
      count: empty.length,
      sampleIds: sample(empty),
    });
  }

  // "CARBON Carbon": a field whose value is already part of another field.
  const repeating = traces.filter(
    ({ trace }) => repeatsIn(trace.name).length > 0,
  );
  const firstRepeat = repeating[0];
  if (firstRepeat) {
    diagnostics.push({
      code: "repeated_word",
      severity: "warning",
      message: `The name repeats a word for ${repeating.length} ${plural(repeating.length)}: "${firstRepeat.trace.name}" says "${repeatsIn(firstRepeat.trace.name)[0]}" twice. Remove the field that duplicates it, or narrow it with a filter.`,
      count: repeating.length,
      sampleIds: sample(repeating.map(({ facts }) => facts.sku)),
    });
  }

  // Our cap, not MetaKocka's, and the copy has to say so: MetaKocka publishes
  // no length limit for a product name, so claiming one would be inventing it.
  const tooLong = traces.filter(
    ({ trace }) => trace.rawLength > MAX_NAME_LENGTH,
  );
  if (tooLong.length > 0) {
    diagnostics.push({
      code: "name_too_long",
      severity: "warning",
      message: `The name is longer than ${MAX_NAME_LENGTH} characters for ${tooLong.length} ${plural(tooLong.length)} and would be shortened to fit. MetaKocka publishes no length limit, so ${MAX_NAME_LENGTH} is this app's own cap rather than the ERP's.`,
      count: tooLong.length,
      sampleIds: sample(tooLong.map(({ facts }) => facts.sku)),
    });
  }

  // A token whose value is already in the title just repeats it.
  for (const token of tokens) {
    if (token.field === "title") continue;
    const repeated = traces
      .filter(({ facts, trace }) => {
        const resolved = trace.tokens.find(
          (entry) => entry.start === token.start,
        );
        if (!resolved || resolved.value.trim() === "") return false;
        return facts.productTitle
          .toLowerCase()
          .includes(resolved.value.trim().toLowerCase());
      })
      .map(({ facts }) => facts.sku);

    if (repeated.length > 0) {
      diagnostics.push({
        code: "redundant_token",
        severity: "warning",
        message: `The value of {${token.field}} already appears in the product title for ${repeated.length} ${repeated.length === 1 ? "product" : "products"}, so the name repeats itself.`,
        count: repeated.length,
        sampleIds: sample(repeated),
      });
    }
  }

  // A token that is empty everywhere is either the wrong field or a field the
  // catalogue does not fill in.
  for (const token of tokens) {
    const values = traces.map(
      ({ trace }) =>
        trace.tokens.find((entry) => entry.start === token.start)?.value ?? "",
    );
    if (values.every((value) => value.trim() === "")) {
      diagnostics.push({
        code: "always_empty",
        severity: "warning",
        message: `{${token.field}} is empty for every product previewed, so it adds nothing to the name.`,
        count: traces.length,
        sampleIds: sample(traces.map(({ facts }) => facts.sku)),
      });
    }
  }

  // A multi-variant product whose template reads nothing variant-level names
  // every variant identically, which the duplicate rule will also catch — but
  // this says why.
  const hasVariantField = tokens.some(
    (token) =>
      VARIANT_LEVEL_IDS.has(token.field) ||
      token.field.startsWith(METAFIELD_PREFIX),
  );
  if (!hasVariantField) {
    const multi = traces
      .filter(({ facts }) => (facts.variantCount ?? 1) > 1)
      .map(({ facts }) => facts.sku);
    if (multi.length > 0) {
      diagnostics.push({
        code: "no_variant_field",
        severity: "warning",
        message: `${multi.length} ${multi.length === 1 ? "product has" : "products have"} more than one variant, but the template uses no field that differs between variants. Every variant would get the same name.`,
        count: multi.length,
        sampleIds: sample(multi),
      });
    }
  }

  // A metafield the shop no longer defines resolves empty forever.
  if (knownMetafields) {
    for (const token of tokens) {
      if (!token.field.startsWith(METAFIELD_PREFIX)) continue;
      const path = token.field.slice(METAFIELD_PREFIX.length);
      if (knownMetafields.has(path)) continue;
      diagnostics.push({
        code: "missing_metafield",
        severity: "warning",
        message: `This shop no longer defines the metafield "${path}", so {${token.field}} will always be empty. Remove it, or add the definition back in Shopify.`,
        count: traces.length,
        sampleIds: sample(traces.map(({ facts }) => facts.sku)),
      });
    }
  }

  return diagnostics;
}

export function hasBlockingError(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}
