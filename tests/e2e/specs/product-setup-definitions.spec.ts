import { saveAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import {
  emptySchema,
  type Attribute,
  type AttributeSchema,
} from "~/domain/attributes/types";

import { EXISTING_DEFINITIONS } from "../support/rig-fixtures";
import { ownerOf } from "../support/seed";
import { expect, test } from "../support/test";

/**
 * docs/attributes.md, Metafield definitions: the Definitions tab previews
 * what the plan needs against what the store holds, writes nothing until the
 * button, and then creates exactly the missing ones.
 */

function attribute(
  id: string,
  name: string,
  dataType: Attribute["dataType"],
  key: string,
  extra: Partial<Attribute> = {},
): Attribute {
  return {
    id,
    name,
    setId: null,
    dataType,
    unit: "",
    description: "",
    scope: "product",
    key,
    implementation: "custom",
    requiredDefault: false,
    filterable: false,
    searchable: false,
    comparable: false,
    valueListId: null,
    ...extra,
  };
}

/** Six attributes: against the store's three definitions, 4 are missing, 1 matches, 1 conflicts. */
function plan(): AttributeSchema {
  return {
    ...emptySchema(),
    attributes: [
      attribute("size", "Sail size", "decimal", "recharge.sail_size", {
        scope: "variant",
      }),
      attribute(
        "skill",
        "Skill level",
        "single_select",
        "recharge.skill_level",
        {
          valueListId: "skill",
        },
      ),
      attribute("year", "Model year", "integer", "recharge.model_year"),
      attribute("brand", "Brand", "text", "recharge.brand"),
      attribute("luff", "Luff length", "measurement", "recharge.luff_cm", {
        unit: "cm",
        scope: "variant",
      }),
      attribute("used", "Used", "boolean", "recharge.used"),
    ],
    valueLists: [
      {
        id: "skill",
        items: [
          { code: "beginner", en: "Beginner", si: "" },
          { code: "advanced", en: "Advanced", si: "" },
        ],
      },
    ],
  };
}

const MUTATIONS = /Create|Update|Delete|Set\b/;

test("previews 4 to create, 1 existing and 1 conflict without writing, then creates the 4", async ({
  page,
  shop,
}) => {
  await shop.resetServices({
    shopify: { metafieldDefinitions: EXISTING_DEFINITIONS },
  });
  await saveAttributeSchema(ownerOf(shop), plan(), 0);

  await page.goto("/app/product-setup/definitions");
  await expect(page.getByText("4 to create").first()).toBeVisible();
  await expect(page.getByText("1 exist").first()).toBeVisible();
  await expect(page.getByText("1 conflict").first()).toBeVisible();
  await expect(page.getByText("1 other definition")).toBeVisible();

  // Previewing is read-only: not one mutation reached the store.
  const preview = await shop.calls();
  expect(preview.filter((call) => MUTATIONS.test(call.operation))).toEqual([]);

  // A slotted primary action has no box of its own; fire the click as sales.spec does.
  await page.locator('s-button[slot="primary-action"]').dispatchEvent("click");
  await expect(page.getByText("0 to create").first()).toBeVisible();
  await expect(page.getByText("Created", { exact: true })).toHaveCount(4);

  const { shopify } = await shop.services();
  expect(
    shopify.metafieldDefinitions
      .filter((d) => d.namespace === "recharge")
      .map((d) => d.key)
      .sort(),
  ).toEqual([
    "brand",
    "luff_cm",
    "model_year",
    "sail_size",
    "skill_level",
    "used",
  ]);
  const made = shopify.metafieldDefinitions.find((d) => d.key === "luff_cm");
  expect(made).toMatchObject({
    ownerType: "PRODUCTVARIANT",
    type: "dimension",
  });

  // Reloading shows the round trip: nothing left to create, the conflict still stated.
  await page.reload();
  await expect(page.getByText("0 to create").first()).toBeVisible();
  await expect(page.getByText("1 conflict").first()).toBeVisible();
});
