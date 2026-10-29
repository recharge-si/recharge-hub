import { activeAttributes, pathOf } from "~/domain/attributes/resolve";
import {
  KEY_PATTERN,
  isSelect,
  type Attribute,
  type AttributeSchema,
  type DataType,
  type Scope,
} from "~/domain/attributes/types";
import type { MetafieldMap } from "~/domain/sales/types";
import { compareCodepoints } from "~/domain/types";

/**
 * Entering a product's attribute values by hand (docs/attributes.md § On
 * the product page): which field each attribute of the product's type is,
 * what it holds now as something a form can show, and what a person's
 * entry becomes as a Shopify metafield.
 *
 * The plan names a Shopify field per attribute; Shopify decides its type.
 * A metafield definition, when the shop has one, is the authority, then a
 * value already stored under that key, and only then the attribute's own
 * format. A Shopify type this page cannot enter faithfully — a reference,
 * rich text, JSON — is shown as one to change in Shopify instead.
 *
 * Pure: the page and the action reach the same fields from the same reads.
 */

/* -------------------------------------------------------------------------- */
/* Assignable types                                                           */
/* -------------------------------------------------------------------------- */

export interface AssignableType {
  id: string;
  name: string;
  /** From the root to the type itself. */
  path: string[];
}

/** Every type products can use, in the order of their full paths. */
export function assignableTypes(schema: AttributeSchema): AssignableType[] {
  return schema.types
    .filter((type) => type.leaf)
    .map((type) => ({
      id: type.id,
      name: type.name,
      path: pathOf(schema, type.id),
    }))
    .sort((a, b) => compareCodepoints(a.path.join(" › "), b.path.join(" › ")));
}

/* -------------------------------------------------------------------------- */
/* Fields                                                                     */
/* -------------------------------------------------------------------------- */

export type InputKind =
  | "text"
  | "multiline"
  | "integer"
  | "decimal"
  | "boolean"
  | "date"
  | "choice"
  | "choices"
  | "measurement";

export interface FieldOption {
  code: string;
  label: string;
}

export type FieldEdit =
  | {
      kind: InputKind;
      shopifyType: string;
      /** Shown beside a number; for a measurement, Shopify's unit. */
      unit: string;
      /** A measurement's Shopify unit, as stored (`CENTIMETERS`). */
      measurementUnit: string | null;
      options: FieldOption[];
    }
  | { kind: "blocked"; reason: string };

export interface AttributeField {
  attributeId: string;
  name: string;
  description: string;
  required: boolean;
  scope: Scope;
  dataType: DataType;
  /** The set it belongs to, or null. */
  group: string | null;
  namespace: string;
  key: string;
  edit: FieldEdit;
}

/** Definition types by owner and key: `PRODUCT|custom.material`. */
export type DefinitionTypes = ReadonlyMap<string, string>;

export function definitionKey(scope: Scope, key: string): string {
  return `${scope === "variant" ? "PRODUCTVARIANT" : "PRODUCT"}|${key}`;
}

type MeasurementType = "dimension" | "weight" | "volume";

/** The units a person writes beside an attribute, as Shopify names them. */
const UNITS: Record<string, { type: MeasurementType; unit: string }> = {
  mm: { type: "dimension", unit: "MILLIMETERS" },
  cm: { type: "dimension", unit: "CENTIMETERS" },
  m: { type: "dimension", unit: "METERS" },
  in: { type: "dimension", unit: "INCHES" },
  '"': { type: "dimension", unit: "INCHES" },
  ft: { type: "dimension", unit: "FEET" },
  yd: { type: "dimension", unit: "YARDS" },
  g: { type: "weight", unit: "GRAMS" },
  kg: { type: "weight", unit: "KILOGRAMS" },
  lb: { type: "weight", unit: "POUNDS" },
  lbs: { type: "weight", unit: "POUNDS" },
  oz: { type: "weight", unit: "OUNCES" },
  ml: { type: "volume", unit: "MILLILITERS" },
  cl: { type: "volume", unit: "CENTILITERS" },
  l: { type: "volume", unit: "LITERS" },
  m3: { type: "volume", unit: "CUBIC_METERS" },
};

const DEFAULT_UNIT: Record<MeasurementType, string> = {
  dimension: "CENTIMETERS",
  weight: "KILOGRAMS",
  volume: "LITERS",
};

const UNIT_LABEL: Record<string, string> = {
  MILLIMETERS: "mm",
  CENTIMETERS: "cm",
  METERS: "m",
  INCHES: "in",
  FEET: "ft",
  YARDS: "yd",
  GRAMS: "g",
  KILOGRAMS: "kg",
  POUNDS: "lb",
  OUNCES: "oz",
  MILLILITERS: "ml",
  CENTILITERS: "cl",
  LITERS: "l",
  CUBIC_METERS: "m³",
};

function isMeasurementType(type: string): type is MeasurementType {
  return type === "dimension" || type === "weight" || type === "volume";
}

function mappedUnit(unit: string) {
  return UNITS[unit.trim().toLowerCase()] ?? null;
}

/** The Shopify type an attribute's format is written as when nothing says otherwise. */
export function defaultShopifyType(attribute: Attribute): string | null {
  switch (attribute.dataType) {
    case "text":
    case "single_select":
      return "single_line_text_field";
    case "multi_select":
      return "list.single_line_text_field";
    case "integer":
      return "number_integer";
    case "decimal":
      return "number_decimal";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "measurement":
      return mappedUnit(attribute.unit)?.type ?? "number_decimal";
    case "reference":
      return null;
  }
}

function storedUnit(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && "unit" in parsed) {
      const unit = (parsed as { unit: unknown }).unit;
      return typeof unit === "string" ? unit : null;
    }
  } catch {
    return null;
  }
  return null;
}

function editFor(
  attribute: Attribute,
  shopifyType: string | null,
  options: FieldOption[],
  stored: { type: string; value: string } | undefined,
): FieldEdit {
  if (shopifyType === null)
    return {
      kind: "blocked",
      reason: "A link to another record is chosen in Shopify.",
    };
  const base = {
    shopifyType,
    unit: attribute.unit.trim(),
    measurementUnit: null,
    options,
  };
  switch (shopifyType) {
    case "single_line_text_field":
      return {
        ...base,
        kind:
          isSelect(attribute.dataType) && options.length > 0
            ? "choice"
            : "text",
      };
    case "multi_line_text_field":
      return { ...base, kind: "multiline" };
    case "list.single_line_text_field":
      return options.length > 0
        ? { ...base, kind: "choices" }
        : {
            kind: "blocked",
            reason:
              "Shopify holds this as a list, and the plan gives it no options to choose from.",
          };
    case "number_integer":
      return { ...base, kind: "integer" };
    case "number_decimal":
      return { ...base, kind: "decimal" };
    case "boolean":
      return { ...base, kind: "boolean" };
    case "date":
      return { ...base, kind: "date" };
  }
  if (isMeasurementType(shopifyType)) {
    const mapped = mappedUnit(attribute.unit);
    const unit =
      (stored && stored.type === shopifyType
        ? storedUnit(stored.value)
        : null) ??
      (mapped?.type === shopifyType ? mapped.unit : null) ??
      DEFAULT_UNIT[shopifyType];
    return {
      ...base,
      kind: "measurement",
      unit: UNIT_LABEL[unit] ?? unit.toLowerCase(),
      measurementUnit: unit,
    };
  }
  return {
    kind: "blocked",
    reason: `Shopify holds this as ${shopifyType.replace(/_/g, " ")}, which is changed in Shopify.`,
  };
}

/**
 * The type's active attributes as fields, in the plan's order: required
 * first, then by name, as `activeAttributes` resolves them.
 */
export function attributeFields(
  schema: AttributeSchema,
  typeId: string,
  read: {
    definitions: DefinitionTypes;
    product: MetafieldMap;
    variants: readonly MetafieldMap[];
  },
): AttributeField[] {
  const lists = new Map(schema.valueLists.map((list) => [list.id, list]));
  const sets = new Map(schema.sets.map((set) => [set.id, set.name]));
  return activeAttributes(schema, typeId).map(({ attribute, required }) => {
    const fullKey = attribute.key.trim();
    const dot = fullKey.indexOf(".");
    const namespace = dot > 0 ? fullKey.slice(0, dot) : "";
    const key = dot > 0 ? fullKey.slice(dot + 1) : "";
    const options = (
      attribute.valueListId
        ? (lists.get(attribute.valueListId)?.items ?? [])
        : []
    ).map((item) => ({ code: item.code, label: item.en || item.code }));
    const stored =
      attribute.scope === "variant"
        ? read.variants.map((map) => map[fullKey]).find(Boolean)
        : read.product[fullKey];

    let edit: FieldEdit;
    if (fullKey === "")
      edit = { kind: "blocked", reason: "No Shopify field is planned yet." };
    else if (!KEY_PATTERN.test(fullKey))
      edit = {
        kind: "blocked",
        reason: `“${fullKey}” is not a Shopify field key the plan can write to.`,
      };
    else
      edit = editFor(
        attribute,
        read.definitions.get(definitionKey(attribute.scope, fullKey)) ??
          stored?.type ??
          defaultShopifyType(attribute),
        options,
        stored,
      );

    return {
      attributeId: attribute.id,
      name: attribute.name,
      description: attribute.description,
      required,
      scope: attribute.scope,
      dataType: attribute.dataType,
      group: attribute.setId ? (sets.get(attribute.setId) ?? null) : null,
      namespace,
      key,
      edit,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

/** What a form holds for one value: text, or the codes of a multi-select. */
export type AttributeInput = string | string[];

/** One input per product attribute, one per variant and variant attribute. */
export type AttributeInputs = Record<string, AttributeInput>;

export function inputKey(attributeId: string, variantId: string | null) {
  return variantId === null ? attributeId : `${attributeId}@${variantId}`;
}

export function isEmptyInput(input: AttributeInput | undefined): boolean {
  if (input === undefined) return true;
  return typeof input === "string" ? input.trim() === "" : input.length === 0;
}

export function sameInput(
  a: AttributeInput | undefined,
  b: AttributeInput | undefined,
): boolean {
  if (isEmptyInput(a) && isEmptyInput(b)) return true;
  if (typeof a === "string" || typeof b === "string")
    return (
      typeof a === "string" && typeof b === "string" && a.trim() === b.trim()
    );
  if (!a || !b || a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a].sort().every((code, index) => code === sorted[index]);
}

/** What a stored value is as a form holds it (the codes of a list, a measurement's number). */
export function storedInput(
  edit: FieldEdit,
  stored: { type: string; value: string } | undefined,
): AttributeInput {
  if (edit.kind === "choices") {
    if (!stored) return [];
    try {
      const parsed: unknown = JSON.parse(stored.value);
      return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch {
      return [];
    }
  }
  if (!stored) return "";
  if (edit.kind === "measurement") {
    try {
      const parsed: unknown = JSON.parse(stored.value);
      if (parsed && typeof parsed === "object" && "value" in parsed)
        return String((parsed as { value: unknown }).value);
    } catch {
      return "";
    }
    return "";
  }
  return stored.value;
}

/** What each field holds now, keyed by `inputKey`. Blocked fields have none. */
export function inputsFrom(
  fields: readonly AttributeField[],
  product: MetafieldMap,
  variants: ReadonlyArray<{ variantId: string; metafields: MetafieldMap }>,
): AttributeInputs {
  const inputs: AttributeInputs = {};
  for (const field of fields) {
    if (field.edit.kind === "blocked") continue;
    const fullKey = `${field.namespace}.${field.key}`;
    if (field.scope === "variant")
      for (const variant of variants)
        inputs[inputKey(field.attributeId, variant.variantId)] = storedInput(
          field.edit,
          variant.metafields[fullKey],
        );
    else
      inputs[inputKey(field.attributeId, null)] = storedInput(
        field.edit,
        product[fullKey],
      );
  }
  return inputs;
}

/* -------------------------------------------------------------------------- */
/* What an entry becomes                                                      */
/* -------------------------------------------------------------------------- */

export type ValueOutcome =
  { ok: true; value: string | null } | { ok: false; error: string };

/** `YYYY-MM-DD` naming a day that exists, leap years included. */
function isCalendarDate(text: string): boolean {
  const parts = DATE.exec(text);
  if (!parts) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
}

const INTEGER = /^-?\d+$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The metafield value for one entry, null to clear it, or why it cannot be. */
export function metafieldValue(
  edit: FieldEdit,
  input: AttributeInput,
): ValueOutcome {
  if (edit.kind === "blocked") return { ok: false, error: edit.reason };

  if (edit.kind === "choices") {
    const codes = typeof input === "string" ? [input] : input;
    const known = new Set(edit.options.map((option) => option.code));
    const chosen = [...new Set(codes.filter((code) => code.trim() !== ""))];
    const unknown = chosen.find((code) => !known.has(code));
    if (unknown !== undefined)
      return { ok: false, error: `"${unknown}" is not one of the options.` };
    return {
      ok: true,
      value: chosen.length > 0 ? JSON.stringify(chosen) : null,
    };
  }

  if (typeof input !== "string")
    return { ok: false, error: "Enter one value." };
  const text = input.trim();
  if (text === "") return { ok: true, value: null };

  switch (edit.kind) {
    case "text":
      return { ok: true, value: text.replace(/\s*\n\s*/g, " ") };
    case "multiline":
      return { ok: true, value: text };
    case "integer":
      return INTEGER.test(text)
        ? { ok: true, value: String(Number.parseInt(text, 10)) }
        : { ok: false, error: "Enter a whole number." };
    case "decimal": {
      const number = text.replace(",", ".");
      return DECIMAL.test(number)
        ? { ok: true, value: number }
        : { ok: false, error: "Enter a number." };
    }
    case "measurement": {
      const number = text.replace(",", ".");
      if (!DECIMAL.test(number) || edit.measurementUnit === null)
        return { ok: false, error: "Enter a number." };
      return {
        ok: true,
        value: JSON.stringify({
          value: Number(number),
          unit: edit.measurementUnit,
        }),
      };
    }
    case "boolean":
      return text === "true" || text === "false"
        ? { ok: true, value: text }
        : { ok: false, error: "Choose yes or no." };
    case "date": {
      return isCalendarDate(text)
        ? { ok: true, value: text }
        : { ok: false, error: "Enter a date as YYYY-MM-DD." };
    }
    case "choice":
      return edit.options.some((option) => option.code === text)
        ? { ok: true, value: text }
        : { ok: false, error: `"${text}" is not one of the options.` };
  }
}

export interface PlannedWrite {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}

export interface PlannedClear {
  ownerId: string;
  namespace: string;
  key: string;
}

export interface AttributeChanges {
  writes: PlannedWrite[];
  clears: PlannedClear[];
  /** Input keys that changed, so the caller can check them for staleness. */
  changed: string[];
  errors: Record<string, string>;
}

/**
 * What a save of attribute values does: each input that differs from what
 * the page read becomes a write, or a clear when it was emptied. An input
 * for no field, or for a field this page cannot write, is ignored.
 */
export function attributeChanges(
  fields: readonly AttributeField[],
  owners: { productId: string; variantIds: readonly string[] },
  before: AttributeInputs,
  after: AttributeInputs,
): AttributeChanges {
  const result: AttributeChanges = {
    writes: [],
    clears: [],
    changed: [],
    errors: {},
  };
  for (const field of fields) {
    const { edit } = field;
    if (edit.kind === "blocked") continue;
    const targets =
      field.scope === "variant"
        ? owners.variantIds.map((id) => ({
            ownerId: id,
            input: inputKey(field.attributeId, id),
          }))
        : [
            {
              ownerId: owners.productId,
              input: inputKey(field.attributeId, null),
            },
          ];
    for (const target of targets) {
      const next = after[target.input];
      const was = before[target.input];
      if (next === undefined || sameInput(was, next)) continue;
      result.changed.push(target.input);
      const outcome = metafieldValue(edit, next);
      if (!outcome.ok) {
        result.errors[target.input] = outcome.error;
        continue;
      }
      const where = {
        ownerId: target.ownerId,
        namespace: field.namespace,
        key: field.key,
      };
      if (outcome.value === null) {
        if (!isEmptyInput(was)) result.clears.push(where);
      } else
        result.writes.push({
          ...where,
          type: edit.shopifyType,
          value: outcome.value,
        });
    }
  }
  return result;
}

/**
 * Shopify's objections to a save of attribute values, each naming the
 * attribute it concerns instead of the raw field key: `Sail size: Value must
 * be a decimal.` An objection that did not say which write it meant is kept
 * as Shopify worded it.
 */
export function namedWriteErrors(
  errors: ReadonlyArray<{ message: string; index?: number | null }>,
  writes: ReadonlyArray<{ namespace: string; key: string }>,
  fields: ReadonlyArray<{ name: string; namespace: string; key: string }>,
): string[] {
  const names = new Map(
    fields.map((field) => [`${field.namespace}.${field.key}`, field.name]),
  );
  return errors.map((error) => {
    const write = error.index == null ? undefined : writes[error.index];
    const name = write
      ? names.get(`${write.namespace}.${write.key}`)
      : undefined;
    return name ? `${name}: ${error.message}` : error.message;
  });
}
