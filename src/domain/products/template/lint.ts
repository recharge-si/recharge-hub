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
import { renderWithTrace } from "./render";
import type { Diagnostic, TemplateNode, VariantFacts } from "./types";

const SAMPLES = 5;

function sample(ids: string[]): string[] {
  return ids.slice(0, SAMPLES);
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

  // The renderer falls back to the title or the SKU rather than writing a
  // nameless product, but the merchant did not ask for that name.
  const empty = traces
    .filter(({ trace }) => trace.usedFallback)
    .map(({ facts }) => facts.sku);
  if (empty.length > 0) {
    diagnostics.push({
      code: "empty_name",
      severity: "error",
      message: `The template produces no name for ${empty.length} ${empty.length === 1 ? "product" : "products"}, so the product title would be used instead. Add a field that always has a value, such as the product title.`,
      count: empty.length,
      sampleIds: sample(empty),
    });
  }

  /* -------------------------------------------------------------- warnings */

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
