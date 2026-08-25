/**
 * Naming settings: one default template plus an ordered list of rules.
 *
 * Masts are measured in cm, sails in m², bags have no option at all — one
 * template cannot name all three well. So the stored shape is a default plus
 * rules, first match wins, from the start. The UI ships with the single
 * template only, but preview and lint already resolve through this, so adding
 * the rules screen later is additive rather than a rewrite of everything that
 * reads a template.
 *
 * A settings object with an empty rule list behaves exactly like a bare
 * template, which is what every existing shop has.
 *
 * Pure (section 5). Rules are data, not code — the same choice §6 makes for
 * allocation rules.
 */
import { resolveField } from "./fields";
import type { VariantFacts } from "./types";

export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "starts_with"
  | "is_empty"
  | "is_not_empty";

export interface RuleCondition {
  /** A field id, the same vocabulary templates use. */
  field: string;
  operator: ConditionOperator;
  /** Ignored by `is_empty` and `is_not_empty`. */
  value?: string;
}

export interface NameRule {
  id: string;
  /** Shown in the rules list so a merchant can tell them apart. */
  label: string;
  /** Every condition must hold. An empty list never matches, by design: a rule
   * with no conditions would silently capture the whole catalogue. */
  conditions: RuleCondition[];
  template: string;
}

export interface NameSettings {
  defaultTemplate: string;
  rules: NameRule[];
}

export function settingsFromTemplate(template: string): NameSettings {
  return { defaultTemplate: template, rules: [] };
}

function matches(condition: RuleCondition, facts: VariantFacts): boolean {
  const raw = resolveField(condition.field, facts);
  const actual = (raw ?? "").trim().toLowerCase();
  const expected = (condition.value ?? "").trim().toLowerCase();

  switch (condition.operator) {
    case "equals":
      return actual === expected;
    case "not_equals":
      return actual !== expected;
    case "contains":
      return expected !== "" && actual.includes(expected);
    case "starts_with":
      return expected !== "" && actual.startsWith(expected);
    case "is_empty":
      return actual === "";
    case "is_not_empty":
      return actual !== "";
    default:
      return false;
  }
}

export function ruleMatches(rule: NameRule, facts: VariantFacts): boolean {
  if (rule.conditions.length === 0) return false;
  return rule.conditions.every((condition) => matches(condition, facts));
}

/** The template that governs one variant: first matching rule, else the default. */
export function resolveTemplate(
  settings: NameSettings,
  facts: VariantFacts,
): { template: string; ruleId: string | null } {
  for (const rule of settings.rules) {
    if (ruleMatches(rule, facts)) {
      return { template: rule.template, ruleId: rule.id };
    }
  }
  return { template: settings.defaultTemplate, ruleId: null };
}

/** Every template a settings object can produce, for linting across rules. */
export function allTemplates(settings: NameSettings): string[] {
  return [settings.defaultTemplate, ...settings.rules.map((r) => r.template)];
}
