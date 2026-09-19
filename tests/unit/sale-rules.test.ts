import { describe, expect, it } from "vitest";

import {
  EMPTY_GROUP,
  isoToMs,
  lintRuleGroup,
  matchesGroup,
  metafieldValueKind,
  operatorsFor,
  parseRuleGroup,
  productsOf,
  selectVariants,
  type CatalogueVariantFacts,
  type Rule,
  type RuleGroup,
} from "~/domain/sales";

/**
 * docs/sale-campaigns.md § Targeting and rule evaluation.
 *
 * The rules a merchant builds are evaluated against the catalogue snapshot,
 * one variant at a time, include first and exclusions after. Every field and
 * every metafield type the builder offers has a case here, because a rule
 * that silently matches nothing is a sale that silently does not happen.
 */

function variant(over: Partial<CatalogueVariantFacts>): CatalogueVariantFacts {
  return {
    variantId: "gid://shopify/ProductVariant/1",
    productId: "gid://shopify/Product/1",
    sku: "PAT-5W-50",
    barcode: "4001",
    variantTitle: "5.0",
    priceMinor: 89_900,
    compareAtMinor: null,
    variantMetafields: {},
    productTitle: "Patrik 5-Wave",
    handle: "patrik-5-wave",
    vendor: "Patrik",
    productType: "Sail",
    status: "ACTIVE",
    tags: ["windsurf", "wave"],
    collectionIds: ["gid://shopify/Collection/10"],
    categoryId: "gid://shopify/TaxonomyCategory/sg-4",
    productMetafields: {
      "custom.brand": { type: "single_line_text_field", value: "Patrik" },
      "custom.year": { type: "number_integer", value: "2025" },
      "custom.discipline": { type: "single_line_text_field", value: "wave" },
      "custom.clearance": { type: "boolean", value: "true" },
      "custom.launched": { type: "date", value: "2025-03-01" },
      "custom.sizes": {
        type: "list.single_line_text_field",
        value: '["4.7","5.0"]',
      },
      "custom.related": {
        type: "list.product_reference",
        value: '["gid://shopify/Product/2"]',
      },
      "custom.brand_ref": {
        type: "metaobject_reference",
        value: "gid://shopify/Metaobject/77",
      },
      "custom.weight": {
        type: "weight",
        value: '{"value":3.2,"unit":"KILOGRAMS"}',
      },
      "custom.rrp": {
        type: "money",
        value: '{"amount":"899.0","currency_code":"EUR"}',
      },
    },
    ...over,
  };
}

function rule(over: Partial<Rule>): Rule {
  return { kind: "rule", field: "vendor", operator: "eq", ...over };
}

function all(...rules: Rule[]): RuleGroup {
  return { kind: "group", op: "and", rules };
}

describe("matchesGroup: Shopify organisation", () => {
  const sail = variant({});

  it("matches collections, vendor, type, tags, category and status", () => {
    expect(
      matchesGroup(
        all(
          rule({
            field: "collection",
            operator: "in",
            value: ["gid://shopify/Collection/10"],
          }),
        ),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(
        all(
          rule({
            field: "collection",
            operator: "in",
            value: ["gid://shopify/Collection/99"],
          }),
        ),
        sail,
      ),
    ).toBe(false);
    expect(
      matchesGroup(
        all(rule({ field: "vendor", operator: "eq", value: "patrik" })),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(
        all(rule({ field: "product_type", operator: "neq", value: "Sail" })),
        sail,
      ),
    ).toBe(false);
    expect(
      matchesGroup(
        all(rule({ field: "tag", operator: "eq", value: "wave" })),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(
        all(rule({ field: "tag", operator: "neq", value: "no-discount" })),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(
        all(
          rule({ field: "tag", operator: "in", value: ["clearance", "wave"] }),
        ),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(
        all(
          rule({
            field: "tag",
            operator: "not_in",
            value: ["clearance", "wave"],
          }),
        ),
        sail,
      ),
    ).toBe(false);
    expect(
      matchesGroup(
        all(
          rule({
            field: "category",
            operator: "in",
            value: ["gid://shopify/TaxonomyCategory/sg-4"],
          }),
        ),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(
        all(rule({ field: "status", operator: "eq", value: "active" })),
        sail,
      ),
    ).toBe(true);
  });

  it("matches product data by SKU, prefix, contains, barcode, title and handle", () => {
    expect(
      matchesGroup(
        all(rule({ field: "sku", operator: "eq", value: "PAT-5W-50" })),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(
        all(rule({ field: "sku", operator: "starts_with", value: "PAT-" })),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(
        all(rule({ field: "sku", operator: "contains", value: "5w" })),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(
        all(rule({ field: "barcode", operator: "eq", value: "4001" })),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(
        all(rule({ field: "title", operator: "contains", value: "wave" })),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(
        all(rule({ field: "handle", operator: "ends_with", value: "-wave" })),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(
        all(rule({ field: "sku", operator: "is_empty" })),
        variant({ sku: null }),
      ),
    ).toBe(true);
  });

  it("matches prices in minor units and the on-sale state", () => {
    expect(
      matchesGroup(
        all(rule({ field: "price", operator: "gte", value: 89_900 })),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(
        all(rule({ field: "price", operator: "lt", value: 89_900 })),
        sail,
      ),
    ).toBe(false);
    expect(
      matchesGroup(
        all(rule({ field: "compare_at_price", operator: "is_empty" })),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(all(rule({ field: "on_sale", operator: "is_false" })), sail),
    ).toBe(true);
    expect(
      matchesGroup(
        all(rule({ field: "on_sale", operator: "is_true" })),
        variant({ compareAtMinor: 99_900 }),
      ),
    ).toBe(true);
  });

  it("matches specific products and variants by id", () => {
    expect(
      matchesGroup(
        all(
          rule({
            field: "product",
            operator: "in",
            value: ["gid://shopify/Product/1"],
          }),
        ),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(
        all(
          rule({
            field: "variant",
            operator: "not_in",
            value: ["gid://shopify/ProductVariant/1"],
          }),
        ),
        sail,
      ),
    ).toBe(false);
    expect(
      matchesGroup(all(rule({ field: "all_products", operator: "eq" })), sail),
    ).toBe(true);
  });
});

describe("matchesGroup: metafields", () => {
  const sail = variant({});
  const mf = (
    namespace: string,
    key: string,
    type: string,
    operator: Rule["operator"],
    value?: Rule["value"],
  ) =>
    all(
      rule({
        field: "metafield",
        operator,
        value,
        metafield: { owner: "product", namespace, key, type },
      }),
    );

  it("compares text, numbers, booleans and dates by the definition's type", () => {
    expect(
      matchesGroup(
        mf("custom", "brand", "single_line_text_field", "eq", "Patrik"),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(mf("custom", "year", "number_integer", "gte", 2025), sail),
    ).toBe(true);
    expect(
      matchesGroup(mf("custom", "year", "number_integer", "lte", "2024"), sail),
    ).toBe(false);
    expect(
      matchesGroup(
        mf("custom", "discipline", "single_line_text_field", "eq", "wave"),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(mf("custom", "clearance", "boolean", "is_true"), sail),
    ).toBe(true);
    expect(
      matchesGroup(mf("custom", "launched", "date", "gt", "2025-01-01"), sail),
    ).toBe(true);
    expect(
      matchesGroup(mf("custom", "launched", "date", "lt", "2025-01-01"), sail),
    ).toBe(false);
  });

  it("handles lists, references, measurements and money", () => {
    expect(
      matchesGroup(
        mf("custom", "sizes", "list.single_line_text_field", "contains", "5.0"),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(
        mf("custom", "sizes", "list.single_line_text_field", "in", [
          "6.0",
          "4.7",
        ]),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(
        mf(
          "custom",
          "related",
          "list.product_reference",
          "contains",
          "gid://shopify/Product/2",
        ),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(
        mf(
          "custom",
          "brand_ref",
          "metaobject_reference",
          "eq",
          "gid://shopify/Metaobject/77",
        ),
        sail,
      ),
    ).toBe(true);
    expect(
      matchesGroup(
        mf(
          "custom",
          "brand_ref",
          "metaobject_reference",
          "neq",
          "gid://shopify/Metaobject/78",
        ),
        sail,
      ),
    ).toBe(true);
    expect(matchesGroup(mf("custom", "weight", "weight", "gt", 3), sail)).toBe(
      true,
    );
    expect(
      matchesGroup(mf("custom", "rrp", "money", "gte", 89_900), sail),
    ).toBe(true);
  });

  it("treats a missing metafield as empty and nothing else", () => {
    expect(
      matchesGroup(mf("custom", "missing", "boolean", "is_false"), sail),
    ).toBe(false);
    expect(
      matchesGroup(mf("custom", "missing", "boolean", "is_empty"), sail),
    ).toBe(true);
    expect(
      matchesGroup(
        mf("custom", "missing", "single_line_text_field", "neq", "x"),
        sail,
      ),
    ).toBe(false);
  });

  it("never matches a comparison on a value it cannot parse", () => {
    const odd = variant({
      productMetafields: {
        "custom.year": { type: "number_integer", value: "twenty" },
      },
    });
    expect(
      matchesGroup(mf("custom", "year", "number_integer", "gte", 2000), odd),
    ).toBe(false);
    expect(
      matchesGroup(mf("custom", "year", "number_integer", "is_not_empty"), odd),
    ).toBe(true);
  });
});

describe("groups", () => {
  const patrikWave = variant({});
  const duotoneClearance = variant({
    variantId: "gid://shopify/ProductVariant/2",
    productId: "gid://shopify/Product/2",
    vendor: "Duotone",
    tags: ["clearance"],
    productMetafields: {
      "custom.year": { type: "number_integer", value: "2023" },
    },
  });
  const other = variant({
    variantId: "gid://shopify/ProductVariant/3",
    productId: "gid://shopify/Product/3",
    vendor: "Severne",
    collectionIds: [],
    tags: [],
  });

  const tree: RuleGroup = {
    kind: "group",
    op: "or",
    rules: [
      all(
        rule({
          field: "collection",
          operator: "in",
          value: ["gid://shopify/Collection/10"],
        }),
        rule({ field: "vendor", operator: "eq", value: "Patrik" }),
      ),
      all(
        rule({ field: "tag", operator: "eq", value: "clearance" }),
        rule({
          field: "metafield",
          operator: "lte",
          value: 2024,
          metafield: {
            owner: "product",
            namespace: "custom",
            key: "year",
            type: "number_integer",
          },
        }),
      ),
    ],
  };

  it("nests AND inside OR", () => {
    expect(matchesGroup(tree, patrikWave)).toBe(true);
    expect(matchesGroup(tree, duotoneClearance)).toBe(true);
    expect(matchesGroup(tree, other)).toBe(false);
  });

  it("matches nothing when empty, so a blank include never selects the catalogue", () => {
    expect(matchesGroup(EMPTY_GROUP, patrikWave)).toBe(false);
    expect(
      matchesGroup(
        { kind: "group", op: "and", rules: [EMPTY_GROUP] },
        patrikWave,
      ),
    ).toBe(false);
  });

  it("selects include first and exclusions after", () => {
    const include = all(
      rule({
        field: "collection",
        operator: "in",
        value: ["gid://shopify/Collection/10"],
      }),
    );
    const exclude: RuleGroup = {
      kind: "group",
      op: "or",
      rules: [rule({ field: "vendor", operator: "eq", value: "Duotone" })],
    };

    const selection = selectVariants(include, exclude, [
      patrikWave,
      duotoneClearance,
      other,
    ]);
    expect(selection.included).toEqual([
      "gid://shopify/ProductVariant/1",
      "gid://shopify/ProductVariant/2",
    ]);
    expect(selection.excluded).toEqual(["gid://shopify/ProductVariant/2"]);
    expect(selection.final).toEqual(["gid://shopify/ProductVariant/1"]);

    const byVariant = new Map(
      [patrikWave, duotoneClearance, other].map((v) => [v.variantId, v]),
    );
    expect(productsOf(selection.final, byVariant)).toEqual(
      new Set(["gid://shopify/Product/1"]),
    );
  });
});

describe("parsing and linting", () => {
  it("falls back to the empty group for anything malformed", () => {
    expect(parseRuleGroup(null)).toEqual(EMPTY_GROUP);
    expect(
      parseRuleGroup({
        kind: "group",
        op: "and",
        rules: [{ kind: "rule", field: "nope" }],
      }),
    ).toEqual(EMPTY_GROUP);
    expect(parseRuleGroup({ kind: "group", op: "or", rules: [] })).toEqual({
      kind: "group",
      op: "or",
      rules: [],
    });
  });

  it("reports rules that cannot run", () => {
    expect(
      lintRuleGroup(all(rule({ field: "vendor", operator: "eq", value: "" }))),
    ).toEqual(["rules[0]: enter a value."]);
    expect(
      lintRuleGroup(
        all(rule({ field: "metafield", operator: "eq", value: "x" })),
      ),
    ).toEqual(["rules[0]: choose a metafield."]);
    expect(
      lintRuleGroup(
        all(rule({ field: "price", operator: "contains", value: "1" })),
      ),
    ).toEqual(["rules[0]: the operator does not fit the field."]);
    expect(
      lintRuleGroup(all(rule({ field: "all_products", operator: "eq" }))),
    ).toEqual([]);
  });

  it("offers operators by value kind", () => {
    expect(operatorsFor("boolean")).toEqual([
      "is_true",
      "is_false",
      "is_empty",
      "is_not_empty",
    ]);
    expect(metafieldValueKind("list.collection_reference")).toBe(
      "reference_list",
    );
    expect(metafieldValueKind("rich_text_field")).toBe("text");
  });

  it("orders ISO dates without the Date global", () => {
    expect(isoToMs("1970-01-01")).toBe(0);
    expect(isoToMs("2025-03-01T00:00:00Z")).toBe(1_740_787_200_000);
    expect(isoToMs("2025-03-01T02:00:00+02:00")).toBe(1_740_787_200_000);
    expect(isoToMs("not a date")).toBeNull();
  });
});
