/**
 * The naming engine's public surface.
 *
 * Everything outside `domain/products/template` imports from here, so the
 * internals can move without a sweep across the app. The sync job and the
 * settings screen both go through `nameFor`, which is the point: one
 * implementation, no second opinion about what a product is called.
 */
export type {
  Diagnostic,
  DiagnosticSeverity,
  FilterCall,
  ParseError,
  ParseErrorCode,
  ParseResult,
  TemplateNode,
  VariantFacts,
} from "./types";

export { FILTERS, findFilter, type FilterSpec } from "./filters";

export {
  fieldRegistry,
  metafieldFieldId,
  resolveField,
  METAFIELD_PREFIX,
  PRODUCT_FIELDS,
  VARIANT_FIELDS,
  VARIANT_LEVEL_IDS,
  type FieldDef,
  type FieldGroup,
  type MetafieldDefinition,
} from "./fields";

export {
  MAX_TEMPLATE_LENGTH,
  MAX_TOKENS,
  parseTemplate,
  serializeTemplate,
  tokensOf,
} from "./parse";

export {
  MAX_NAME_LENGTH,
  renderName,
  renderTemplate,
  renderWithTrace,
  tidy,
  type RenderOptions,
  type RenderTrace,
} from "./render";

export { hasBlockingError, lintTemplate, type LintInput } from "./lint";

export {
  DEFAULT_NAME_PATTERN,
  NAME_PATTERNS,
  type NamePattern,
} from "./presets";

export {
  applyPick,
  canAddField,
  flattenGroups,
  pickerGroups,
  pickerQueryAt,
  type PickerGroup,
  type PickerGroupId,
  type PickerQuery,
  type PickerRow,
  type PickResult,
} from "./picker";

export {
  buildPreview,
  type PreviewInput,
  type PreviewResult,
  type PreviewRow,
  type PreviewStatus,
  type PreviewTotals,
} from "./preview";

export {
  allTemplates,
  resolveTemplate,
  ruleMatches,
  settingsFromTemplate,
  type ConditionOperator,
  type NameRule,
  type NameSettings,
  type RuleCondition,
} from "./settings";

import { METAFIELD_PREFIX } from "./fields";
import { parseTemplate, tokensOf } from "./parse";
import { renderTemplate } from "./render";
import { allTemplates, resolveTemplate, type NameSettings } from "./settings";
import type { VariantFacts } from "./types";

/**
 * Whether any pattern in these settings reads a metafield.
 *
 * Reading metafields costs query points on every page of the catalogue, so the
 * sync job asks for them only when a pattern actually uses one. That decision
 * belongs here rather than in the job: the job is not allowed to know what a
 * pattern looks like inside, which is what keeps preview and sync in step.
 */
export function usesMetafields(settings: NameSettings): boolean {
  return allTemplates(settings).some((template) =>
    tokensOf(parseTemplate(template).nodes).some((token) =>
      token.field.startsWith(METAFIELD_PREFIX),
    ),
  );
}

/**
 * The one entry point that names a variant.
 *
 * Both the sync job and the preview call this. `tests/unit/template-agreement.test.ts`
 * asserts they cannot disagree, because a preview that drifts from the job
 * silently rewrites the merchant's catalogue.
 */
export function nameFor(
  settings: NameSettings,
  facts: VariantFacts,
): { name: string; ruleId: string | null } {
  const { template, ruleId } = resolveTemplate(settings, facts);
  return {
    name: renderTemplate(parseTemplate(template).nodes, facts),
    ruleId,
  };
}
