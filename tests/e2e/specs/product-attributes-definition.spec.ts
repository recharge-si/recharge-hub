import { saveAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import {
  SCHEMA_VERSION,
  type AttributeSchema,
} from "~/domain/attributes/types";

import { ownerOf } from "../support/seed";
import { expect, test } from "../support/test";

/**
 * docs/attributes.md, Metafield definitions: a value typed as 5,3 is saved
 * as 5.3 with the type of the store's definition, and read back as 5.3.
 */

const PRODUCT = "gid://shopify/Product/3001";

const plan: AttributeSchema = {
  version: SCHEMA_VERSION,
  types: [
    {
      id: "sails",
      name: "Sails",
      parentId: null,
      leaf: true,
      sortOrder: 1000,
      shopifyCategory: "",
      archetype: "",
    },
  ],
  sets: [],
  attributes: [
    {
      id: "size",
      name: "Sail size",
      setId: null,
      dataType: "decimal",
      unit: "",
      description: "",
      scope: "product",
      key: "recharge.sail_size",
      implementation: "custom",
      requiredDefault: false,
      filterable: false,
      searchable: false,
      comparable: false,
      valueListId: null,
    },
  ],
  setAssignments: [],
  attributeAssignments: [{ id: "a1", typeId: "sails", attributeId: "size" }],
  overrides: [],
  exclusions: [],
  valueLists: [],
};

test("a value is saved with the type of its definition", async ({
  page,
  shop,
}) => {
  await shop.resetServices({
    shopify: {
      metafieldDefinitions: [
        {
          ownerType: "PRODUCT",
          namespace: "recharge",
          key: "sail_size",
          name: "Sail size",
          type: "number_decimal",
        },
      ],
      products: [
        {
          id: PRODUCT,
          title: "Wave sail",
          handle: "wave-sail",
          status: "ACTIVE",
          vendor: "Point-7",
          productType: "Sails",
          tags: [],
          descriptionHtml: "",
          metafields: {},
          variants: [
            {
              id: "gid://shopify/ProductVariant/7001",
              title: "Default",
              sku: "SKU-1",
              price: "100.00",
              compareAtPrice: null,
              inventory: {},
              metafields: {},
            },
          ],
        },
      ],
    },
  });
  await saveAttributeSchema(ownerOf(shop), plan, 0);

  const field = () => page.locator('s-number-field[label="Sail size"]');
  await page.goto("/app/products/3001?tab=attributes");
  // Polaris hosts have no box of their own, so Playwright never calls them visible.
  await expect(field()).toBeAttached();
  await field().evaluate((el) => {
    (el as unknown as { value: string }).value = "5,3";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("ui-save-bar button", { hasText: "Save" }).click();
  await expect(page.locator("#e2e-toasts")).toContainText("Saved");

  await page.reload();
  await expect
    .poll(() =>
      field().evaluate((el) => (el as unknown as { value: string }).value),
    )
    .toBe("5.3");
  const { shopify } = await shop.services();
  expect(shopify.products[0]?.metafields["recharge.sail_size"]).toEqual({
    type: "number_decimal",
    value: "5.3",
  });
});
