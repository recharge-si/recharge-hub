import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CATALOGUE_BULK_QUERY,
  DESCRIPTION_LIMIT,
  parseCatalogueJsonl,
  plainDescription,
} from "~/adapters/shopify/catalogue";
import { parseProductUpdate } from "~/adapters/shopify/product-payload";
import { FIXTURES } from "../support/rig-fixtures";

describe("catalogue bulk query", () => {
  it("also reads options, stock, address and description", () => {
    for (const field of [
      "selectedOptions { name value }",
      "inventoryQuantity",
      "availableForSale",
      "onlineStoreUrl",
      "descriptionHtml",
      "handle",
    ]) {
      expect(CATALOGUE_BULK_QUERY).toContain(field);
    }
  });
});

describe("recorded bulk operation (3 products, 7 variants)", () => {
  const text = readFileSync(join(FIXTURES, "bulk-catalogue.jsonl"), "utf8");
  const products = parseCatalogueJsonl(text);

  it("round-trips options, stock, address, image and plain description", () => {
    expect(products).toHaveLength(3);
    expect(products.flatMap((p) => p.variants)).toHaveLength(7);
    const sail = products[0];
    expect(sail?.handle).toBe("aero-ride-sail");
    expect(sail?.onlineStoreUrl).toBe("https://recharge.si/products/aero-ride-sail");
    expect(sail?.imageUrl).toBe("https://cdn.example.test/9001.jpg");
    expect(sail?.description).toBe("Fast & stable. Made for freeride.");
    expect(sail?.variants.map((v) => v.options)).toEqual([
      [{ name: "Size", value: "5.8" }],
      [{ name: "Size", value: "6.2" }],
      [{ name: "Size", value: "6.6" }],
    ]);
    expect(sail?.variants.map((v) => [v.inventoryQuantity, v.availableForSale])).toEqual([
      [4, true],
      [0, false],
      [null, true],
    ]);
    const mast = products[1];
    expect(mast?.onlineStoreUrl).toBeNull();
    expect(mast?.description).toBeNull();
    expect(mast?.variants[0]?.options).toEqual([
      { name: "Length", value: "430" },
      { name: "Base", value: "Tendon" },
    ]);
    expect(products[2]?.status).toBe("ARCHIVED");
  });
});

describe("plainDescription", () => {
  it("drops tags and scripts, decodes entities, collapses space", () => {
    expect(plainDescription("<p>A&nbsp;&lt;b&gt; &#8211; <em>x</em></p><style>p{}</style>")).toBe(
      "A <b> – x",
    );
  });
  it("caps at 2000 characters and returns null for nothing", () => {
    expect(plainDescription("x".repeat(5000))).toHaveLength(DESCRIPTION_LIMIT);
    expect(plainDescription("<br>")).toBeNull();
    expect(plainDescription(null)).toBeNull();
  });
});

describe("products/update payload", () => {
  const payload = JSON.parse(
    readFileSync(join(FIXTURES, "products-update.json"), "utf8"),
  ) as unknown;
  const update = parseProductUpdate(payload);

  it("carries options paired with the product option names", () => {
    expect(update.variants[0]?.options).toEqual([
      { name: "Size", value: "5.8" },
      { name: "Colour", value: "Red" },
    ]);
    expect(update.description).toBe("Fast & stable.");
  });

  it("reads stock the way Shopify sells", () => {
    expect(update.variants.map((v) => [v.inventoryQuantity, v.availableForSale])).toEqual([
      [3, true],
      [0, false],
      // Inventory is not tracked: always available, quantity meaningless.
      [null, true],
    ]);
  });
});
