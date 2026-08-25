/**
 * What a template would do to the catalogue, worked out without touching it.
 *
 * Read-only by construction: this module takes the variants, the names
 * MetaKocka currently holds and the settings, and returns rows. It has no
 * client, no repository and no way to write anything, which is the point — a
 * preview that can write is not a preview.
 *
 * It calls exactly the same `nameFor` the sync job calls. That is not tidiness:
 * a preview that renders names differently from the job is a promise the job
 * then breaks across the whole catalogue, and nobody notices until the ERP is
 * full of wrong names. `tests/unit/template-agreement.test.ts` holds the two to
 * each other.
 */
import { nameFor } from "./index";
import { lintTemplate } from "./lint";
import { parseTemplate } from "./parse";
import { allTemplates, type NameSettings } from "./settings";
import type { Diagnostic, VariantFacts } from "./types";

export type PreviewStatus = "changed" | "unchanged" | "new" | "unknown";

export interface PreviewRow {
  sku: string;
  productTitle: string;
  /** What MetaKocka holds now, or null when we have not read the catalogue. */
  currentName: string | null;
  nextName: string;
  status: PreviewStatus;
  /** Which rule named this variant, or null for the default template. */
  ruleId: string | null;
}

export interface PreviewTotals {
  rows: number;
  changed: number;
  unchanged: number;
  created: number;
  unknown: number;
}

export interface PreviewResult {
  rows: PreviewRow[];
  totals: PreviewTotals;
  diagnostics: Diagnostic[];
}

export interface PreviewInput {
  settings: NameSettings;
  variants: VariantFacts[];
  /**
   * MetaKocka's current name per SKU. Omit it for the live preview, where the
   * question is "what would this template produce" rather than "what would
   * change" — and where a MetaKocka read per keystroke would be absurd.
   */
  currentNames?: Map<string, string | null>;
  knownMetafields?: Set<string>;
}

export function buildPreview({
  settings,
  variants,
  currentNames,
  knownMetafields,
}: PreviewInput): PreviewResult {
  const rows: PreviewRow[] = variants.map((facts) => {
    const { name, ruleId } = nameFor(settings, facts);

    let status: PreviewStatus = "unknown";
    if (currentNames) {
      const current = currentNames.get(facts.sku);
      status =
        current === undefined
          ? "new"
          : (current ?? "") === name
            ? "unchanged"
            : "changed";
    }

    return {
      sku: facts.sku,
      productTitle: facts.productTitle,
      currentName: currentNames ? (currentNames.get(facts.sku) ?? null) : null,
      nextName: name,
      status,
      ruleId,
    };
  });

  const totals: PreviewTotals = {
    rows: rows.length,
    changed: rows.filter((row) => row.status === "changed").length,
    unchanged: rows.filter((row) => row.status === "unchanged").length,
    created: rows.filter((row) => row.status === "new").length,
    unknown: rows.filter((row) => row.status === "unknown").length,
  };

  // Lint every template the settings can reach, not just the default: a rule
  // that names two variants the same is the same corruption as a default that
  // does, and the merchant should hear about it before saving either.
  const seen = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  for (const template of allTemplates(settings)) {
    for (const diagnostic of lintTemplate({
      nodes: parseTemplate(template).nodes,
      variants,
      knownMetafields,
    })) {
      // The same rule firing on two templates is one thing to fix, not two.
      const key = `${diagnostic.code}:${diagnostic.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push(diagnostic);
    }
  }

  return { rows, totals, diagnostics };
}
