import { describe, expect, it } from "vitest";

import { parseCatalogueJsonl } from "~/adapters/shopify/catalogue";
import { fromMinorUnits } from "~/adapters/shopify/variant-prices";

/**
 * The bulk operation's JSONL, taken apart the way Shopify emits it: one
 * object per line, nested connections flattened with `__parentId`, and the
 * type of each line told by its id (docs/sale-campaigns.md § Data model).
 */
const JSONL = [
  {
    id: "gid://shopify/Product/1",
    title: "Patrik 5-Wave",
    handle: "patrik-5-wave",
    vendor: "Patrik",
    productType: "Sail",
    status: "ACTIVE",
    tags: ["windsurf", "wave"],
    updatedAt: "2026-09-01T10:00:00Z",
    category: { id: "gid://shopify/TaxonomyCategory/sg-4", name: "Sails" },
    featuredMedia: { preview: { image: { url: "https://cdn/x.jpg" } } },
  },
  { id: "gid://shopify/Collection/10", __parentId: "gid://shopify/Product/1" },
  {
    id: "gid://shopify/Metafield/100",
    __parentId: "gid://shopify/Product/1",
    namespace: "custom",
    key: "year",
    type: "number_integer",
    value: "2025",
  },
  {
    id: "gid://shopify/ProductVariant/11",
    __parentId: "gid://shopify/Product/1",
    sku: " PAT-5W-47 ",
    barcode: null,
    title: "4.7",
    price: "899.00",
    compareAtPrice: null,
  },
  {
    id: "gid://shopify/Metafield/101",
    __parentId: "gid://shopify/ProductVariant/11",
    namespace: "custom",
    key: "size",
    type: "number_decimal",
    value: "4.7",
  },
  {
    id: "gid://shopify/ProductVariant/12",
    __parentId: "gid://shopify/Product/1",
    sku: "PAT-5W-50",
    barcode: "4001",
    title: "5.0",
    price: "899.00",
    compareAtPrice: "999.00",
  },
  {
    id: "gid://shopify/Product/2",
    title: "Bare",
    tags: [],
  },
]
  .map((line) => JSON.stringify(line))
  .join("\n");

describe("parseCatalogueJsonl", () => {
  it("rebuilds each product with its variants, collections and metafields", () => {
    const [sail, bare] = parseCatalogueJsonl(`${JSONL}\n\n`);

    expect(sail).toMatchObject({
      productId: "gid://shopify/Product/1",
      title: "Patrik 5-Wave",
      vendor: "Patrik",
      tags: ["windsurf", "wave"],
      collectionIds: ["gid://shopify/Collection/10"],
      categoryId: "gid://shopify/TaxonomyCategory/sg-4",
      categoryName: "Sails",
      imageUrl: "https://cdn/x.jpg",
      shopifyUpdatedAt: "2026-09-01T10:00:00Z",
      metafields: { "custom.year": { type: "number_integer", value: "2025" } },
    });
    expect(sail?.variants).toEqual([
      {
        variantId: "gid://shopify/ProductVariant/11",
        productId: "gid://shopify/Product/1",
        sku: "PAT-5W-47",
        barcode: null,
        title: "4.7",
        priceMinor: 89_900,
        compareAtMinor: null,
        metafields: { "custom.size": { type: "number_decimal", value: "4.7" } },
      },
      {
        variantId: "gid://shopify/ProductVariant/12",
        productId: "gid://shopify/Product/1",
        sku: "PAT-5W-50",
        barcode: "4001",
        title: "5.0",
        priceMinor: 89_900,
        compareAtMinor: 99_900,
        metafields: {},
      },
    ]);

    expect(bare).toMatchObject({
      productId: "gid://shopify/Product/2",
      handle: null,
      vendor: null,
      collectionIds: [],
      variants: [],
      imageUrl: null,
    });
  });

  it("refuses a malformed line rather than shortening the catalogue", () => {
    expect(() =>
      parseCatalogueJsonl(
        '{"id":"gid://shopify/ProductVariant/1","__parentId":"gid://shopify/Product/1"}',
      ),
    ).toThrow();
  });
});

describe("fromMinorUnits", () => {
  it("writes the decimal string Shopify takes", () => {
    expect(fromMinorUnits(175_920)).toBe("1759.20");
    expect(fromMinorUnits(5)).toBe("0.05");
    expect(fromMinorUnits(0)).toBe("0.00");
    expect(fromMinorUnits(179_999)).toBe("1799.99");
  });
});
