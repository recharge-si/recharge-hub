import { saveAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { mergeRigPack } from "~/domain/attributes/rig-pack";
import { emptySchema } from "~/domain/attributes/types";

import { RIG_COUNTS, rigProducts } from "../support/rig-fixtures";
import { ownerOf, seedCatalogueSnapshot } from "../support/seed";
import { expect, test } from "../support/test";

/**
 * docs/rig-builder.md, Readiness: one stated line per rig role on the keys the
 * engine reads, and the link counts the same products the line does (12 of 20
 * ready, the 8 missing a canopy_area, not all 20).
 */
test("the rig readiness line states 12 of 20 and links to the 8", async ({
  page,
  shop,
}) => {
  await shop.resetServices({ shopify: { products: rigProducts() } });
  await seedCatalogueSnapshot(shop);
  await saveAttributeSchema(
    ownerOf(shop),
    mergeRigPack(emptySchema()).schema,
    0,
  );

  await page.goto("/app/product-setup/types");
  const sails = page.getByText(/^12 of 20 ready/);
  await expect(sails).toBeVisible();
  await expect(sails).toContainText("canopy_area (8)");
  // The seeded snapshot holds no stock levels yet, and the line says so.
  await expect(sails).toContainText("stock not read yet");
  // Masts: 6, two without a mast_diameter.
  await expect(
    page.getByText(
      `${RIG_COUNTS.masts - RIG_COUNTS.mastsWithoutDiameter} of ${RIG_COUNTS.masts} ready`,
    ),
  ).toBeVisible();

  await page.getByRole("link", { name: "Show the 8" }).first().click();
  await expect(page).toHaveURL(/incomplete=sails/);
  await expect(page.getByText("8 products still missing data")).toBeVisible();
  await expect(page.getByText(/^Sail \d+$/)).toHaveCount(8);
});

test("a rig role with no products has no line", async ({ page, shop }) => {
  await shop.resetServices({
    shopify: { products: rigProducts({ ...RIG_COUNTS, fins: 0 }) },
  });
  await seedCatalogueSnapshot(shop);
  await saveAttributeSchema(
    ownerOf(shop),
    mergeRigPack(emptySchema()).schema,
    0,
  );

  await page.goto("/app/product-setup/types");
  // Booms, bases and fins have none in this fixture: only sails, masts and
  // boards get a line.
  await expect(page.getByText(/ready \u00b7 missing/)).toHaveCount(3);
  await expect(page.getByText("No products", { exact: true })).toHaveCount(0);
});
