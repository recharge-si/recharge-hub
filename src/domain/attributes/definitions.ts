import { MENU_TYPE_FIELD } from "~/domain/attributes/menu";
import {
  KEY_NAMESPACE,
  KEY_PATTERN,
  isSelect,
  type Attribute,
  type AttributeSchema,
} from "~/domain/attributes/types";
import { defaultShopifyType } from "~/domain/products/attribute-values";

/**
 * Which metafield definitions the plan implies, and what is already in
 * Shopify (docs/attributes.md § Metafield definitions). Pure: the preview and
 * the create action read the same rows.
 *
 * The Shopify type of an attribute is resolved by `defaultShopifyType`, the
 * function the product page falls back to when a value is written, so a
 * definition made here is the type a value would have been given anyway.
 */

export type OwnerType = "PRODUCT" | "PRODUCTVARIANT";

/** A definition as Shopify holds it (only what the planner compares). */
export interface ExistingDefinition {
  ownerType: OwnerType;
  namespace: string;
  key: string;
  /** Shopify's type name, `number_decimal`, `dimension`. */
  type: string;
  name?: string;
}

/** What `metafieldDefinitionCreate` is sent. */
export interface DefinitionDraft {
  ownerType: OwnerType;
  namespace: string;
  key: string;
  name: string;
  description: string;
  type: string;
  /** `[{ name: "choices", value: '["a","b"]' }]` for a choice attribute. */
  validations: Array<{ name: "choices"; value: string }>;
  /** `PUBLIC_READ` when the attribute is read through the Storefront API. */
  storefrontAccess: "PUBLIC_READ" | null;
}

export type DefinitionStatus =
  "create" | "unchanged" | "conflict" | "managed" | "skipped";

export interface DefinitionRow {
  attributeId: string;
  name: string;
  ownerType: OwnerType;
  /** `namespace.key`; empty for an unmapped attribute. */
  fullKey: string;
  status: DefinitionStatus;
  /** The type the plan implies; null when it cannot be created. */
  type: string | null;
  /** For a conflict, the type Shopify holds. */
  existingType: string | null;
  /** Why a row is skipped, or how a managed one is handled. */
  reason: string | null;
  /** False for a key outside the app's namespace: created if missing, never deleted. */
  owned: boolean;
  /** Present on `create` rows only. */
  draft: DefinitionDraft | null;
}

export interface DefinitionPlan {
  rows: DefinitionRow[];
  /** Existing definitions the plan does not mention, left alone. */
  foreign: ExistingDefinition[];
  counts: Record<DefinitionStatus, number>;
}

export function ownerTypeOf(attribute: Pick<Attribute, "scope">): OwnerType {
  return attribute.scope === "variant" ? "PRODUCTVARIANT" : "PRODUCT";
}

function split(fullKey: string): { namespace: string; key: string } {
  const dot = fullKey.indexOf(".");
  return { namespace: fullKey.slice(0, dot), key: fullKey.slice(dot + 1) };
}

/** `PRODUCT|recharge.sail_size`. */
function identity(ownerType: OwnerType, fullKey: string): string {
  return `${ownerType}|${fullKey}`;
}

const MENU_IDENTITY = identity(
  "PRODUCT",
  `${MENU_TYPE_FIELD.namespace}.${MENU_TYPE_FIELD.key}`,
);

/** The type a definition is created with, or why it cannot be. */
export function definitionType(
  attribute: Attribute,
): { ok: true; type: string } | { ok: false; reason: string } {
  const type = defaultShopifyType(attribute);
  if (type === null)
    return {
      ok: false,
      reason: "A link to another record is created in Shopify.",
    };
  return { ok: true, type };
}

export function planDefinitions(
  schema: AttributeSchema,
  existing: readonly ExistingDefinition[],
): DefinitionPlan {
  const have = new Map(
    existing.map((definition) => [
      identity(
        definition.ownerType,
        `${definition.namespace}.${definition.key}`,
      ),
      definition,
    ]),
  );
  const lists = new Map(schema.valueLists.map((list) => [list.id, list]));
  const planned = new Set<string>();
  const rows: DefinitionRow[] = [];

  for (const attribute of schema.attributes) {
    const fullKey = attribute.key.trim();
    const ownerType = ownerTypeOf(attribute);
    const row = (
      status: DefinitionStatus,
      extra: Partial<DefinitionRow> = {},
    ): DefinitionRow => ({
      attributeId: attribute.id,
      name: attribute.name,
      ownerType,
      fullKey,
      status,
      type: null,
      existingType: null,
      reason: null,
      owned: fullKey.startsWith(`${KEY_NAMESPACE}.`),
      draft: null,
      ...extra,
    });

    if (fullKey === "") {
      rows.push(row("skipped", { reason: "No Shopify field is planned." }));
      continue;
    }
    if (!KEY_PATTERN.test(fullKey)) {
      rows.push(
        row("skipped", {
          reason: `“${fullKey}” is not a Shopify field key.`,
        }),
      );
      continue;
    }
    const id = identity(ownerType, fullKey);
    if (id === MENU_IDENTITY) {
      rows.push(
        row("managed", {
          reason: "Managed by the store menu.",
          type: MENU_TYPE_FIELD.type,
        }),
      );
      planned.add(id);
      continue;
    }
    if (planned.has(id)) {
      rows.push(
        row("skipped", {
          reason: "Another attribute already uses this field.",
        }),
      );
      continue;
    }
    planned.add(id);

    const type = definitionType(attribute);
    if (!type.ok) {
      rows.push(row("skipped", { reason: type.reason }));
      continue;
    }

    let choices: string[] | null = null;
    if (isSelect(attribute.dataType)) {
      const items = attribute.valueListId
        ? (lists.get(attribute.valueListId)?.items ?? [])
        : [];
      if (items.length === 0) {
        rows.push(
          row("skipped", { reason: "Add options first.", type: type.type }),
        );
        continue;
      }
      choices = items.map((item) => item.code);
    }

    const found = have.get(id);
    if (found) {
      rows.push(
        found.type === type.type
          ? row("unchanged", { type: type.type, existingType: found.type })
          : row("conflict", {
              type: type.type,
              existingType: found.type,
              reason: `Shopify holds ${found.type}; a type cannot be changed.`,
            }),
      );
      continue;
    }

    const { namespace, key } = split(fullKey);
    rows.push(
      row("create", {
        type: type.type,
        draft: {
          ownerType,
          namespace,
          key,
          name: attribute.name,
          description: attribute.description,
          type: type.type,
          validations: choices
            ? [{ name: "choices", value: JSON.stringify(choices) }]
            : [],
          storefrontAccess: attribute.storefront ? "PUBLIC_READ" : null,
        },
      }),
    );
  }

  const foreign = existing.filter((definition) => {
    const id = identity(
      definition.ownerType,
      `${definition.namespace}.${definition.key}`,
    );
    return !planned.has(id) && id !== MENU_IDENTITY;
  });

  const counts: Record<DefinitionStatus, number> = {
    create: 0,
    unchanged: 0,
    conflict: 0,
    managed: 0,
    skipped: 0,
  };
  for (const row of rows) counts[row.status] += 1;
  return { rows, foreign, counts };
}
