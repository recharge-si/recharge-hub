import { useCallback } from "react";

import type { MetafieldDefinition } from "~/domain/products/template";
import {
  RULE_FIELDS,
  type Operator,
  type Rule,
  type RuleField,
  type RuleGroup,
  type RuleNode,
  type ValueKind,
} from "~/domain/sales/rules";
import { Dropdown } from "~/web/components/dropdown";
import {
  FIELD_LABEL,
  formatAmountInput,
  operatorLabel,
  operatorsForField,
  parseAmount,
  valueKind,
} from "~/web/lib/sales";

/**
 * The visual rule builder (docs/sale-campaigns.md § Targeting and rule
 * evaluation): rows of *field · operator · value*, grouped by "match all"
 * or "match any", with one level of nested groups.
 *
 * Built for staff who do not know what a GID is. Vendors, types, tags and
 * categories come from the catalogue as a list; products, variants and
 * collections come from Shopify's own picker and are shown by name; a
 * metafield is chosen from the shop's definitions and offers only the
 * operators its type can answer. The tree it edits is exactly what the
 * domain evaluates, so what the preview counts is what activation does.
 */

export interface RuleFacets {
  vendors: string[];
  productTypes: string[];
  tags: string[];
  statuses: string[];
  categories: Array<{ id: string; name: string }>;
}

export interface RuleBuilderProps {
  value: RuleGroup;
  onChange: (next: RuleGroup) => void;
  facets: RuleFacets;
  metafields: MetafieldDefinition[];
  currency: string;
  disabled?: boolean;
  /** "Include" or "Exclude": names the empty state. */
  purpose: "include" | "exclude";
}

const FIELD_ORDER: RuleField[] = [
  "collection",
  "product",
  "variant",
  "vendor",
  "product_type",
  "tag",
  "category",
  "status",
  "metafield",
  "sku",
  "barcode",
  "title",
  "handle",
  "price",
  "compare_at_price",
  "on_sale",
  "all_products",
];

function defaultRule(field: RuleField): Rule {
  const kind = valueKind(field);
  const [operator = "eq"] = operatorsForField(field);
  return {
    kind: "rule",
    field,
    operator,
    ...(kind === "id" || kind === "reference_list" ? { value: [] } : {}),
  };
}

function needsValue(operator: Operator, kind: ValueKind): boolean {
  if (kind === "none") return false;
  return !["is_empty", "is_not_empty", "is_true", "is_false"].includes(
    operator,
  );
}

function isListOperator(operator: Operator): boolean {
  return operator === "in" || operator === "not_in";
}

export function RuleBuilder(props: RuleBuilderProps) {
  const { value, onChange, purpose, disabled } = props;

  const setRules = useCallback(
    (rules: RuleNode[]) => onChange({ ...value, rules }),
    [onChange, value],
  );

  return (
    <s-stack direction="block" gap="base">
      <GroupEditor {...props} group={value} depth={0} />
      {value.rules.length === 0 ? (
        <s-text color="subdued">
          {purpose === "include"
            ? "No rules yet. Add one to choose which products go on sale."
            : "No exclusions. Every product the rules above match will be on sale."}
        </s-text>
      ) : null}
      <s-stack direction="inline" gap="small-300">
        <s-button
          type="button"
          icon="plus"
          onClick={() => setRules([...value.rules, defaultRule("collection")])}
          {...(disabled ? { disabled: true } : {})}
        >
          Add rule
        </s-button>
        <s-button
          type="button"
          onClick={() =>
            setRules([
              ...value.rules,
              {
                kind: "group",
                op: value.op === "and" ? "or" : "and",
                rules: [defaultRule("collection")],
              },
            ])
          }
          {...(disabled ? { disabled: true } : {})}
        >
          Add group
        </s-button>
      </s-stack>
    </s-stack>
  );
}

function GroupEditor({
  group,
  onChange,
  depth,
  facets,
  metafields,
  currency,
  disabled,
}: RuleBuilderProps & {
  group: RuleGroup;
  onChange: (next: RuleGroup) => void;
  depth: number;
}) {
  const update = (index: number, node: RuleNode) =>
    onChange({
      ...group,
      rules: group.rules.map((r, i) => (i === index ? node : r)),
    });
  const remove = (index: number) =>
    onChange({ ...group, rules: group.rules.filter((_, i) => i !== index) });

  return (
    <s-stack direction="block" gap="small-300">
      {group.rules.length > 1 || depth > 0 ? (
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-text color="subdued">
            {depth === 0 ? "Products where" : "Where"}
          </s-text>
          <s-box inlineSize="160px">
            <Dropdown
              name={`op-${depth}`}
              label="Match"
              hideLabel
              value={group.op}
              options={[
                { value: "and", label: "all of these" },
                { value: "or", label: "any of these" },
              ]}
              onChange={(op) =>
                onChange({ ...group, op: op === "or" ? "or" : "and" })
              }
              {...(disabled ? { disabled: true } : {})}
            />
          </s-box>
        </s-stack>
      ) : null}

      {group.rules.map((node, index) => (
        <s-box
          key={index}
          padding={node.kind === "group" ? "base" : "none"}
          {...(node.kind === "group"
            ? { border: "base", borderRadius: "base" }
            : {})}
        >
          <s-stack direction="block" gap="small-300">
            {index > 0 ? (
              <s-text color="subdued">
                {group.op === "and" ? "and" : "or"}
              </s-text>
            ) : null}
            {node.kind === "group" ? (
              <s-stack direction="block" gap="small-300">
                <GroupEditor
                  group={node}
                  onChange={(next) => update(index, next)}
                  depth={depth + 1}
                  facets={facets}
                  metafields={metafields}
                  currency={currency}
                  purpose="include"
                  value={node}
                  {...(disabled ? { disabled: true } : {})}
                />
                <s-stack direction="inline" gap="small-300">
                  <s-button
                    type="button"
                    icon="plus"
                    onClick={() =>
                      update(index, {
                        ...node,
                        rules: [...node.rules, defaultRule("vendor")],
                      })
                    }
                    {...(disabled ? { disabled: true } : {})}
                  >
                    Add rule
                  </s-button>
                  <s-button
                    type="button"
                    tone="critical"
                    onClick={() => remove(index)}
                    {...(disabled ? { disabled: true } : {})}
                  >
                    Remove group
                  </s-button>
                </s-stack>
              </s-stack>
            ) : (
              <RuleRow
                rule={node}
                onChange={(next) => update(index, next)}
                onRemove={() => remove(index)}
                facets={facets}
                metafields={metafields}
                currency={currency}
                {...(disabled ? { disabled: true } : {})}
              />
            )}
          </s-stack>
        </s-box>
      ))}
    </s-stack>
  );
}

function RuleRow({
  rule,
  onChange,
  onRemove,
  facets,
  metafields,
  currency,
  disabled,
}: {
  rule: Rule;
  onChange: (next: Rule) => void;
  onRemove: () => void;
  facets: RuleFacets;
  metafields: MetafieldDefinition[];
  currency: string;
  disabled?: boolean;
}) {
  const kind = valueKind(rule.field, rule.metafield?.type);
  const operators = operatorsForField(rule.field, rule.metafield?.type);
  const off = disabled ? { disabled: true } : {};

  const setField = (field: string) => {
    if (!RULE_FIELDS.includes(field as RuleField)) return;
    onChange(defaultRule(field as RuleField));
  };

  const setMetafield = (key: string) => {
    const definition = metafields.find(
      (d) => `${d.ownerType}:${d.namespace}.${d.key}` === key,
    );
    if (!definition) return;
    const metafield = {
      owner:
        definition.ownerType === "PRODUCTVARIANT"
          ? ("variant" as const)
          : ("product" as const),
      namespace: definition.namespace,
      key: definition.key,
      type: definition.type ?? "single_line_text_field",
    };
    const [operator = "eq"] = operatorsForField("metafield", metafield.type);
    onChange({ kind: "rule", field: "metafield", operator, metafield });
  };

  const setOperator = (operator: string) => {
    if (!operators.includes(operator as Operator)) return;
    const next = operator as Operator;
    const wantsList =
      isListOperator(next) || kind === "id" || kind === "reference_list";
    const current = rule.value;
    const value = wantsList
      ? Array.isArray(current)
        ? current
        : current === undefined || current === ""
          ? []
          : [String(current)]
      : Array.isArray(current)
        ? (current[0] ?? "")
        : current;
    onChange({
      ...rule,
      operator: next,
      ...(value === undefined ? {} : { value }),
    });
  };

  return (
    <s-grid
      gridTemplateColumns="@container (inline-size <= 700px) 1fr, minmax(150px, 1fr) minmax(150px, 1fr) minmax(200px, 2fr) auto"
      gap="small-300"
      alignItems="end"
    >
      <Dropdown
        name="field"
        label="Field"
        hideLabel
        value={rule.field}
        options={FIELD_ORDER.map((field) => ({
          value: field,
          label: FIELD_LABEL[field],
        }))}
        onChange={setField}
        {...off}
      />

      {rule.field === "metafield" ? (
        <Dropdown
          name="metafield"
          label="Metafield"
          hideLabel
          placeholder="Choose a metafield"
          value={
            rule.metafield
              ? `${rule.metafield.owner === "variant" ? "PRODUCTVARIANT" : "PRODUCT"}:${rule.metafield.namespace}.${rule.metafield.key}`
              : ""
          }
          options={metafields.map((d) => ({
            value: `${d.ownerType}:${d.namespace}.${d.key}`,
            label: `${d.name} (${d.ownerType === "PRODUCTVARIANT" ? "variant" : "product"} · ${d.namespace}.${d.key})`,
          }))}
          onChange={setMetafield}
          {...off}
        />
      ) : null}

      {kind !== "none" ? (
        <Dropdown
          name="operator"
          label="Condition"
          hideLabel
          value={rule.operator}
          options={operators.map((operator) => ({
            value: operator,
            label: operatorLabel(rule.field, operator),
          }))}
          onChange={setOperator}
          {...off}
        />
      ) : (
        <s-text color="subdued">Every product in the catalogue</s-text>
      )}

      {needsValue(rule.operator, kind) ? (
        <ValueInput
          rule={rule}
          kind={kind}
          onChange={onChange}
          facets={facets}
          currency={currency}
          {...off}
        />
      ) : kind !== "none" ? (
        <s-box />
      ) : null}

      <s-button
        type="button"
        icon="x"
        accessibilityLabel="Remove rule"
        onClick={onRemove}
        {...off}
      />
    </s-grid>
  );
}

function ValueInput({
  rule,
  kind,
  onChange,
  facets,
  currency,
  disabled,
}: {
  rule: Rule;
  kind: ValueKind;
  onChange: (next: Rule) => void;
  facets: RuleFacets;
  currency: string;
  disabled?: boolean;
}) {
  const off = disabled ? { disabled: true } : {};
  const list = isListOperator(rule.operator);
  const values = Array.isArray(rule.value)
    ? rule.value
    : rule.value === undefined
      ? []
      : [String(rule.value)];
  const single = values[0] ?? "";
  const setSingle = (value: string) => onChange({ ...rule, value });
  const setList = (next: string[], labels?: string[]) =>
    onChange({ ...rule, value: next, ...(labels ? { labels } : {}) });

  // A list typed by hand: comma-separated.
  const listField = (label: string) => (
    <s-text-field
      label={label}
      labelAccessibilityVisibility="exclusive"
      placeholder="One or more, separated by commas"
      value={values.join(", ")}
      onChange={(event) =>
        setList(
          event.currentTarget.value
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item !== ""),
        )
      }
      {...off}
    />
  );

  switch (kind) {
    case "id":
      return (
        <ResourcePick
          field={rule.field}
          ids={values}
          labels={rule.labels ?? []}
          categories={facets.categories}
          onChange={setList}
          {...off}
        />
      );
    case "tag":
      if (list) return listField("Tags");
      return (
        <Dropdown
          name="value"
          label="Tag"
          hideLabel
          placeholder="Choose a tag"
          value={single}
          options={facets.tags.map((tag) => ({ value: tag, label: tag }))}
          onChange={setSingle}
          {...off}
        />
      );
    case "money": {
      const shown =
        typeof rule.value === "number" ? formatAmountInput(rule.value) : single;
      return (
        <s-text-field
          label={`Amount in ${currency}`}
          labelAccessibilityVisibility="exclusive"
          placeholder="0.00"
          value={shown}
          onChange={(event) => {
            const text = event.currentTarget.value;
            const minor = parseAmount(text);
            onChange({ ...rule, value: minor ?? text });
          }}
          {...off}
        />
      );
    }
    case "number":
      return (
        <s-text-field
          label="Number"
          labelAccessibilityVisibility="exclusive"
          placeholder="0"
          value={single}
          onChange={(event) => setSingle(event.currentTarget.value)}
          {...off}
        />
      );
    case "date":
      return (
        <s-date-field
          label="Date"
          labelAccessibilityVisibility="exclusive"
          value={single}
          onChange={(event) => setSingle(event.currentTarget.value)}
          {...off}
        />
      );
    case "text": {
      const facet =
        rule.field === "vendor"
          ? facets.vendors
          : rule.field === "product_type"
            ? facets.productTypes
            : rule.field === "status"
              ? facets.statuses
              : null;
      if (list) return listField(FIELD_LABEL[rule.field]);
      if (
        facet &&
        facet.length > 0 &&
        (rule.operator === "eq" || rule.operator === "neq")
      ) {
        return (
          <Dropdown
            name="value"
            label={FIELD_LABEL[rule.field]}
            hideLabel
            placeholder={`Choose a ${FIELD_LABEL[rule.field].toLowerCase()}`}
            value={single}
            options={facet.map((item) => ({ value: item, label: item }))}
            onChange={setSingle}
            {...off}
          />
        );
      }
      return (
        <s-text-field
          label={FIELD_LABEL[rule.field]}
          labelAccessibilityVisibility="exclusive"
          value={single}
          onChange={(event) => setSingle(event.currentTarget.value)}
          {...off}
        />
      );
    }
    case "list":
      if (list) return listField("Values");
      return (
        <s-text-field
          label="Value"
          labelAccessibilityVisibility="exclusive"
          value={single}
          onChange={(event) => setSingle(event.currentTarget.value)}
          {...off}
        />
      );
    case "reference":
    case "reference_list":
      return (
        <ReferencePick
          type={rule.metafield?.type ?? ""}
          list={list || kind === "reference_list"}
          ids={values}
          labels={rule.labels ?? []}
          onChange={(ids, labels) =>
            list || kind === "reference_list"
              ? setList(ids, labels)
              : onChange({ ...rule, value: ids[0] ?? "", labels })
          }
          {...off}
        />
      );
    default:
      return null;
  }
}

type PickerType = "product" | "variant" | "collection";

/** The chips for chosen ids, and the button that opens Shopify's picker. */
function Chips({
  ids,
  labels,
  onRemove,
  disabled,
}: {
  ids: string[];
  labels: string[];
  onRemove: (index: number) => void;
  disabled?: boolean;
}) {
  if (ids.length === 0) return null;
  return (
    <s-stack direction="inline" gap="small-300">
      {ids.map((id, index) => (
        <s-clickable-chip
          key={id}
          onClick={() => {
            if (!disabled) onRemove(index);
          }}
          accessibilityLabel={`Remove ${labels[index] ?? id}`}
        >
          {labels[index] ?? id.replace(/^gid:\/\/shopify\/\w+\//, "#")}
        </s-clickable-chip>
      ))}
    </s-stack>
  );
}

async function pick(
  type: PickerType,
  selected: string[],
): Promise<Array<{ id: string; title: string }> | null> {
  if (typeof shopify === "undefined") return null;
  const payload = await shopify.resourcePicker({
    type,
    multiple: true,
    action: "select",
    selectionIds: selected.map((id) => ({ id })),
  });
  if (!payload) return null;
  return payload.map((item) => ({
    id: item.id,
    title: "displayName" in item ? item.displayName : item.title,
  }));
}

function ResourcePick({
  field,
  ids,
  labels,
  categories,
  onChange,
  disabled,
}: {
  field: RuleField;
  ids: string[];
  labels: string[];
  categories: Array<{ id: string; name: string }>;
  onChange: (ids: string[], labels: string[]) => void;
  disabled?: boolean;
}) {
  const off = disabled ? { disabled: true } : {};
  const remove = (index: number) =>
    onChange(
      ids.filter((_, i) => i !== index),
      labels.filter((_, i) => i !== index),
    );

  if (field === "category") {
    return (
      <s-stack direction="block" gap="small-300">
        <Dropdown
          name="category"
          label="Category"
          hideLabel
          placeholder="Add a category"
          value=""
          options={categories
            .filter((category) => !ids.includes(category.id))
            .map((category) => ({ value: category.id, label: category.name }))}
          onChange={(id) => {
            const category = categories.find((c) => c.id === id);
            if (category) onChange([...ids, id], [...labels, category.name]);
          }}
          {...off}
        />
        <Chips ids={ids} labels={labels} onRemove={remove} {...off} />
      </s-stack>
    );
  }

  const type: PickerType =
    field === "product"
      ? "product"
      : field === "variant"
        ? "variant"
        : "collection";
  return (
    <s-stack direction="block" gap="small-300">
      <s-stack direction="inline">
        <s-button
          type="button"
          onClick={() => {
            void pick(type, ids).then((chosen) => {
              if (!chosen) return;
              onChange(
                chosen.map((item) => item.id),
                chosen.map((item) => item.title),
              );
            });
          }}
          {...off}
        >
          {ids.length === 0 ? `Choose ${type}s` : `Change ${type}s`}
        </s-button>
      </s-stack>
      <Chips ids={ids} labels={labels} onRemove={remove} {...off} />
    </s-stack>
  );
}

function ReferencePick({
  type,
  list,
  ids,
  labels,
  onChange,
  disabled,
}: {
  type: string;
  list: boolean;
  ids: string[];
  labels: string[];
  onChange: (ids: string[], labels: string[]) => void;
  disabled?: boolean;
}) {
  const off = disabled ? { disabled: true } : {};
  const pickerType: PickerType | null = type.includes("collection_reference")
    ? "collection"
    : type.includes("variant_reference")
      ? "variant"
      : type.includes("product_reference")
        ? "product"
        : null;

  if (pickerType) {
    return (
      <s-stack direction="block" gap="small-300">
        <s-stack direction="inline">
          <s-button
            type="button"
            onClick={() => {
              void pick(pickerType, ids).then((chosen) => {
                if (!chosen) return;
                const kept = list ? chosen : chosen.slice(0, 1);
                onChange(
                  kept.map((item) => item.id),
                  kept.map((item) => item.title),
                );
              });
            }}
            {...off}
          >
            {ids.length === 0 ? "Choose" : "Change"}
          </s-button>
        </s-stack>
        <Chips
          ids={ids}
          labels={labels}
          onRemove={(index) =>
            onChange(
              ids.filter((_, i) => i !== index),
              labels.filter((_, i) => i !== index),
            )
          }
          {...off}
        />
      </s-stack>
    );
  }

  // Metaobjects and other references have no picker: the id, as Shopify shows it.
  return (
    <s-text-field
      label="Reference id"
      labelAccessibilityVisibility="exclusive"
      placeholder={
        list ? "gid://shopify/Metaobject/…, …" : "gid://shopify/Metaobject/…"
      }
      details="Copy the id from the metaobject's page in Shopify."
      value={ids.join(", ")}
      onChange={(event) =>
        onChange(
          event.currentTarget.value
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item !== ""),
          [],
        )
      }
      {...off}
    />
  );
}
