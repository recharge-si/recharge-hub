import { z } from "zod";

import { isOnSale } from "~/domain/sales/pricing";
import type {
  CatalogueVariantFacts,
  MetafieldValue,
} from "~/domain/sales/types";

/**
 * Targeting rules (docs/sale-campaigns.md § Targeting and rule evaluation).
 *
 * A rule tree is evaluated against the catalogue snapshot, one variant at a
 * time, and answers with the set of variant ids that match. Include first,
 * then exclude. Everything here is deterministic: no clock, no Shopify.
 */

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

export const RULE_FIELDS = [
  "all_products",
  "product",
  "variant",
  "collection",
  "vendor",
  "product_type",
  "tag",
  "category",
  "status",
  "sku",
  "barcode",
  "title",
  "handle",
  "price",
  "compare_at_price",
  "on_sale",
  "metafield",
] as const;

export type RuleField = (typeof RULE_FIELDS)[number];

export const OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "is_empty",
  "is_not_empty",
  "in",
  "not_in",
  "is_true",
  "is_false",
] as const;

export type Operator = (typeof OPERATORS)[number];

const metafieldRefSchema = z.object({
  owner: z.enum(["product", "variant"]),
  namespace: z.string().min(1),
  key: z.string().min(1),
  /** Shopify's metafield definition type, e.g. `number_integer`. */
  type: z.string().min(1),
});

export type MetafieldRef = z.infer<typeof metafieldRefSchema>;

const ruleValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

export type RuleValue = z.infer<typeof ruleValueSchema>;

export const ruleSchema = z.object({
  kind: z.literal("rule"),
  field: z.enum(RULE_FIELDS),
  operator: z.enum(OPERATORS),
  value: ruleValueSchema.optional(),
  metafield: metafieldRefSchema.optional(),
  /**
   * What the ids in `value` were called when the merchant picked them, so the
   * editor can show "Windsurf" rather than a GID. Display only; matching
   * reads `value`.
   */
  labels: z.array(z.string()).optional(),
});

export type Rule = z.infer<typeof ruleSchema>;

export interface RuleGroup {
  kind: "group";
  op: "and" | "or";
  rules: RuleNode[];
}

export type RuleNode = Rule | RuleGroup;

export const ruleGroupSchema: z.ZodType<RuleGroup> = z.lazy(() =>
  z.object({
    kind: z.literal("group"),
    op: z.enum(["and", "or"]),
    rules: z.array(z.union([ruleSchema, ruleGroupSchema])),
  }),
);

/** An empty group: matches nothing as an include, excludes nothing as an exclude. */
export const EMPTY_GROUP: RuleGroup = { kind: "group", op: "and", rules: [] };

export function isEmptyGroup(group: RuleGroup): boolean {
  return group.rules.every(
    (node) => node.kind === "group" && isEmptyGroup(node),
  );
}

/* -------------------------------------------------------------------------- */
/* Which operators make sense where                                           */
/* -------------------------------------------------------------------------- */

export type ValueKind =
  | "text"
  | "number"
  | "money"
  | "boolean"
  | "date"
  | "list"
  | "reference"
  | "reference_list"
  | "id"
  | "tag"
  | "none";

const TEXT_OPERATORS: readonly Operator[] = [
  "eq",
  "neq",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "in",
  "not_in",
  "is_empty",
  "is_not_empty",
];
const NUMBER_OPERATORS: readonly Operator[] = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "is_empty",
  "is_not_empty",
];
const BOOLEAN_OPERATORS: readonly Operator[] = [
  "is_true",
  "is_false",
  "is_empty",
  "is_not_empty",
];
const LIST_OPERATORS: readonly Operator[] = [
  "contains",
  "not_contains",
  "in",
  "not_in",
  "is_empty",
  "is_not_empty",
];
const REFERENCE_OPERATORS: readonly Operator[] = [
  "eq",
  "neq",
  "in",
  "not_in",
  "is_empty",
  "is_not_empty",
];
const ID_OPERATORS: readonly Operator[] = ["in", "not_in"];
const TAG_OPERATORS: readonly Operator[] = ["eq", "neq", "in", "not_in"];

export function operatorsFor(kind: ValueKind): readonly Operator[] {
  switch (kind) {
    case "text":
      return TEXT_OPERATORS;
    case "number":
    case "money":
    case "date":
      return NUMBER_OPERATORS;
    case "boolean":
      return BOOLEAN_OPERATORS;
    case "list":
    case "reference_list":
      return LIST_OPERATORS;
    case "reference":
      return REFERENCE_OPERATORS;
    case "id":
      return ID_OPERATORS;
    case "tag":
      return TAG_OPERATORS;
    case "none":
      return [];
  }
}

/** The value a field carries, so the builder offers the right operators and input. */
export function valueKindFor(
  field: RuleField,
  metafieldType?: string,
): ValueKind {
  switch (field) {
    case "all_products":
      return "none";
    case "product":
    case "variant":
    case "collection":
    case "category":
      return "id";
    case "vendor":
    case "product_type":
    case "status":
    case "sku":
    case "barcode":
    case "title":
    case "handle":
      return "text";
    case "tag":
      return "tag";
    case "price":
    case "compare_at_price":
      return "money";
    case "on_sale":
      return "boolean";
    case "metafield":
      return metafieldValueKind(metafieldType ?? "");
  }
}

/**
 * Shopify metafield types, grouped by what an operator can do with them.
 * Unknown types are compared as text, which is the honest fallback.
 */
export function metafieldValueKind(type: string): ValueKind {
  if (type.startsWith("list.")) {
    return type.endsWith("_reference") ? "reference_list" : "list";
  }
  switch (type) {
    case "number_integer":
    case "number_decimal":
    case "weight":
    case "volume":
    case "dimension":
    case "rating":
      return "number";
    case "money":
      return "money";
    case "boolean":
      return "boolean";
    case "date":
    case "date_time":
      return "date";
    case "product_reference":
    case "collection_reference":
    case "variant_reference":
    case "metaobject_reference":
    case "file_reference":
    case "page_reference":
    case "customer_reference":
    case "company_reference":
    case "order_reference":
    case "product_taxonomy_value_reference":
      return "reference";
    default:
      return "text";
  }
}

/* -------------------------------------------------------------------------- */
/* Value parsing                                                              */
/* -------------------------------------------------------------------------- */

function norm(text: string): string {
  return text.trim().toLowerCase();
}

function asStrings(value: RuleValue | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return [String(value)];
}

function asNumber(value: RuleValue | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return parseNumber(value);
  return null;
}

/** "1,5", "1.5", " 12 " → a number; anything else → null. */
export function parseNumber(raw: string): number | null {
  const text = raw.trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** A metafield's number, by its type. Null when it has none. */
export function metafieldNumber(field: MetafieldValue): number | null {
  switch (field.type) {
    case "number_integer":
    case "number_decimal":
      return parseNumber(field.value);
    case "weight":
    case "volume":
    case "dimension":
    case "rating":
    case "money": {
      const json = parseJson(field.value);
      if (!json || typeof json !== "object") return null;
      const record = json as Record<string, unknown>;
      const inner = field.type === "money" ? record.amount : record.value;
      if (typeof inner === "number") return inner;
      if (typeof inner === "string") return parseNumber(inner);
      return null;
    }
    default:
      return parseNumber(field.value);
  }
}

/** A `list.*` metafield's items. A non-list is one item. */
export function metafieldList(field: MetafieldValue): string[] {
  if (!field.type.startsWith("list.")) return [field.value];
  const json = parseJson(field.value);
  if (!Array.isArray(json)) return [];
  return json.map((item) =>
    typeof item === "string" ? item : JSON.stringify(item),
  );
}

/**
 * ISO 8601 (`2025-03-01`, `2025-03-01T10:00:00Z`, `…+02:00`) to a number
 * that orders the same way, without the `Date` global `domain/` forbids.
 * Milliseconds since the epoch, computed from the civil date.
 */
export function isoToMs(raw: string): number | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(
      raw.trim(),
    );
  if (!match) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "0", offset] = match;
  const days = daysFromCivil(Number(y), Number(mo), Number(d));
  let ms =
    days * 86_400_000 +
    Number(h) * 3_600_000 +
    Number(mi) * 60_000 +
    Number(s) * 1000 +
    Number(frac.padEnd(3, "0"));
  if (offset && offset !== "Z") {
    const sign = offset.startsWith("-") ? -1 : 1;
    const [oh, om] = offset.slice(1).split(":");
    ms -= sign * (Number(oh) * 3_600_000 + Number(om) * 60_000);
  }
  return ms;
}

/** Howard Hinnant's days-from-civil: proleptic Gregorian days since 1970-01-01. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                   */
/* -------------------------------------------------------------------------- */

function matchText(
  actual: string | null,
  operator: Operator,
  value: RuleValue | undefined,
): boolean {
  const have = actual === null ? "" : norm(actual);
  const wanted = asStrings(value).map(norm);
  const [first = ""] = wanted;
  switch (operator) {
    case "eq":
      return have !== "" && have === first;
    case "neq":
      return have !== first;
    case "contains":
      return first !== "" && have.includes(first);
    case "not_contains":
      return first === "" || !have.includes(first);
    case "starts_with":
      return first !== "" && have.startsWith(first);
    case "ends_with":
      return first !== "" && have.endsWith(first);
    case "in":
      return wanted.includes(have) && have !== "";
    case "not_in":
      return !wanted.includes(have);
    case "is_empty":
      return have === "";
    case "is_not_empty":
      return have !== "";
    default:
      return false;
  }
}

function matchNumber(
  actual: number | null,
  operator: Operator,
  value: RuleValue | undefined,
): boolean {
  if (operator === "is_empty") return actual === null;
  if (operator === "is_not_empty") return actual !== null;
  const wanted = asNumber(value);
  if (actual === null || wanted === null) return false;
  switch (operator) {
    case "eq":
      return actual === wanted;
    case "neq":
      return actual !== wanted;
    case "gt":
      return actual > wanted;
    case "gte":
      return actual >= wanted;
    case "lt":
      return actual < wanted;
    case "lte":
      return actual <= wanted;
    default:
      return false;
  }
}

function matchBoolean(actual: boolean | null, operator: Operator): boolean {
  switch (operator) {
    case "is_true":
      return actual === true;
    case "is_false":
      return actual === false;
    case "is_empty":
      return actual === null;
    case "is_not_empty":
      return actual !== null;
    default:
      return false;
  }
}

/** Set semantics over a list of strings, case-insensitive. */
function matchList(
  actual: readonly string[],
  operator: Operator,
  value: RuleValue | undefined,
): boolean {
  const have = actual.map(norm);
  const wanted = asStrings(value)
    .map(norm)
    .filter((item) => item !== "");
  switch (operator) {
    case "eq":
    case "contains":
      return wanted.length > 0 && wanted.every((item) => have.includes(item));
    case "neq":
    case "not_contains":
      return !wanted.some((item) => have.includes(item));
    case "in":
      return wanted.some((item) => have.includes(item));
    case "not_in":
      return !wanted.some((item) => have.includes(item));
    case "is_empty":
      return have.length === 0;
    case "is_not_empty":
      return have.length > 0;
    default:
      return false;
  }
}

/** Ids compare exactly: a GID is not text a person typed. */
function matchIds(
  actual: readonly string[],
  operator: Operator,
  value: RuleValue | undefined,
): boolean {
  const wanted = asStrings(value);
  switch (operator) {
    case "eq":
    case "in":
    case "contains":
      return wanted.some((id) => actual.includes(id));
    case "neq":
    case "not_in":
    case "not_contains":
      return !wanted.some((id) => actual.includes(id));
    case "is_empty":
      return actual.length === 0;
    case "is_not_empty":
      return actual.length > 0;
    default:
      return false;
  }
}

function matchMetafield(rule: Rule, facts: CatalogueVariantFacts): boolean {
  const ref = rule.metafield;
  if (!ref) return false;
  const map =
    ref.owner === "variant" ? facts.variantMetafields : facts.productMetafields;
  const field = map[`${ref.namespace}.${ref.key}`] ?? null;
  const kind = metafieldValueKind(ref.type);

  if (field === null || field.value.trim() === "") {
    return rule.operator === "is_empty";
  }
  // Present and non-empty, whatever the type makes of it.
  if (rule.operator === "is_empty") return false;
  if (rule.operator === "is_not_empty") return true;

  switch (kind) {
    case "number":
      return matchNumber(metafieldNumber(field), rule.operator, rule.value);
    case "money": {
      const amount = metafieldNumber(field);
      // A money rule's value is minor units (the form converts); the
      // metafield amount is major units.
      return matchNumber(
        amount === null ? null : Math.round(amount * 100),
        rule.operator,
        rule.value,
      );
    }
    case "boolean": {
      const text = norm(field.value);
      const actual = text === "true" ? true : text === "false" ? false : null;
      return matchBoolean(actual, rule.operator);
    }
    case "date": {
      const wanted = asStrings(rule.value)[0];
      return matchNumber(
        isoToMs(field.value),
        rule.operator,
        wanted === undefined ? undefined : (isoToMs(wanted) ?? undefined),
      );
    }
    case "list":
      return matchList(metafieldList(field), rule.operator, rule.value);
    case "reference_list":
      return matchIds(metafieldList(field), rule.operator, rule.value);
    case "reference":
      return matchIds([field.value], rule.operator, rule.value);
    default:
      return matchText(field.value, rule.operator, rule.value);
  }
}

export function matchesRule(rule: Rule, facts: CatalogueVariantFacts): boolean {
  switch (rule.field) {
    case "all_products":
      return true;
    case "product":
      return matchIds([facts.productId], rule.operator, rule.value);
    case "variant":
      return matchIds([facts.variantId], rule.operator, rule.value);
    case "collection":
      return matchIds(facts.collectionIds, rule.operator, rule.value);
    case "category":
      return matchIds(
        facts.categoryId ? [facts.categoryId] : [],
        rule.operator,
        rule.value,
      );
    case "vendor":
      return matchText(facts.vendor, rule.operator, rule.value);
    case "product_type":
      return matchText(facts.productType, rule.operator, rule.value);
    case "status":
      return matchText(facts.status, rule.operator, rule.value);
    case "tag":
      return matchList(facts.tags, rule.operator, rule.value);
    case "sku":
      return matchText(facts.sku, rule.operator, rule.value);
    case "barcode":
      return matchText(facts.barcode, rule.operator, rule.value);
    case "title":
      return matchText(facts.productTitle, rule.operator, rule.value);
    case "handle":
      return matchText(facts.handle, rule.operator, rule.value);
    case "price":
      return matchNumber(facts.priceMinor, rule.operator, rule.value);
    case "compare_at_price":
      return matchNumber(facts.compareAtMinor, rule.operator, rule.value);
    case "on_sale":
      return matchBoolean(
        isOnSale({
          priceMinor: facts.priceMinor,
          compareAtMinor: facts.compareAtMinor,
        }),
        rule.operator,
      );
    case "metafield":
      return matchMetafield(rule, facts);
  }
}

/**
 * A group with no rules matches nothing. "Match all" over an empty list would
 * be true, and an include tree that a merchant has not filled in must not
 * quietly select the whole catalogue.
 */
export function matchesGroup(
  group: RuleGroup,
  facts: CatalogueVariantFacts,
): boolean {
  const nodes = group.rules.filter(
    (node) => node.kind === "rule" || !isEmptyGroup(node),
  );
  if (nodes.length === 0) return false;
  const test = (node: RuleNode) =>
    node.kind === "rule" ? matchesRule(node, facts) : matchesGroup(node, facts);
  return group.op === "and" ? nodes.every(test) : nodes.some(test);
}

export interface Selection {
  /** Every variant the include tree matched. */
  included: string[];
  /** Of those, the ones the exclude tree removed. */
  excluded: string[];
  /** What is left: the campaign's membership. */
  final: string[];
}

/** Include first, then exclude, over the whole catalogue. */
export function selectVariants(
  include: RuleGroup,
  exclude: RuleGroup,
  catalogue: Iterable<CatalogueVariantFacts>,
): Selection {
  const included: string[] = [];
  const excluded: string[] = [];
  const final: string[] = [];

  for (const facts of catalogue) {
    if (!matchesGroup(include, facts)) continue;
    included.push(facts.variantId);
    if (matchesGroup(exclude, facts)) excluded.push(facts.variantId);
    else final.push(facts.variantId);
  }

  return { included, excluded, final };
}

/** Distinct product ids among a set of variants. */
export function productsOf(
  variantIds: Iterable<string>,
  byVariant: ReadonlyMap<string, CatalogueVariantFacts>,
): Set<string> {
  const products = new Set<string>();
  for (const id of variantIds) {
    const facts = byVariant.get(id);
    if (facts) products.add(facts.productId);
  }
  return products;
}

/**
 * Parses a stored or posted rule tree. Anything that fails is the empty
 * group, so a corrupt column never selects the catalogue by accident.
 */
export function parseRuleGroup(raw: unknown): RuleGroup {
  const parsed = ruleGroupSchema.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_GROUP;
}

/** What is wrong with a rule tree, in a form the editor can show. Empty when fine. */
export function lintRuleGroup(group: RuleGroup, path = "rules"): string[] {
  const problems: string[] = [];
  group.rules.forEach((node, index) => {
    const here = `${path}[${index}]`;
    if (node.kind === "group") {
      problems.push(...lintRuleGroup(node, here));
      return;
    }
    const kind = valueKindFor(node.field, node.metafield?.type);
    if (node.field === "metafield" && !node.metafield) {
      problems.push(`${here}: choose a metafield.`);
      return;
    }
    if (!operatorsFor(kind).includes(node.operator) && kind !== "none") {
      problems.push(`${here}: the operator does not fit the field.`);
    }
    const needsValue =
      !["is_empty", "is_not_empty", "is_true", "is_false"].includes(
        node.operator,
      ) && kind !== "none";
    if (
      needsValue &&
      asStrings(node.value).filter((item) => item.trim() !== "").length === 0
    ) {
      problems.push(`${here}: enter a value.`);
    }
  });
  return problems;
}
