import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { RIG_ATTRIBUTES } from "~/domain/attributes/rig-pack";

import { ownerOf } from "../support/seed";
import { expect, test } from "../support/test";

/**
 * docs/attributes.md, Rig-ready attributes: Add rig attributes puts the pack
 * in the plan once; pressing it again says it is already there.
 */
test("Add rig attributes adds the pack once", async ({ page, shop }) => {
  await page.goto("/app/product-setup/settings");
  const add = page.getByText("Add rig attributes", { exact: true });
  await add.click();
  await expect(page.locator("#e2e-toasts")).toContainText(
    /Added \d+ rig attributes/,
  );

  const owner = ownerOf(shop);
  const first = await getAttributeSchema(owner);
  expect(first.schema.attributes).toHaveLength(RIG_ATTRIBUTES.length);

  await add.click();
  await expect(page.locator("#e2e-toasts")).toContainText(
    "Already in the plan",
  );
  const second = await getAttributeSchema(owner);
  expect(second.revision).toBe(first.revision);
  expect(second.schema.attributes).toHaveLength(RIG_ATTRIBUTES.length);

  // The new types are in the tree.
  await page.goto("/app/product-setup/types");
  for (const name of ["Boards", "Sails", "Masts", "Booms", "Fins", "Harnesses"])
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
});
