import { seedConnectedShop } from "../support/seed";
import { expect, test } from "../support/test";

/**
 * One MetaKocka customer for every order: set on its own page, stated on
 * Order settings, and turned off again.
 */
test("a fixed MetaKocka customer is saved, shown and cleared", async ({
  page,
  shop,
}) => {
  await seedConnectedShop(shop, {
    locations: { "gid://shopify/Location/1": "glavno" },
  });

  await page.goto("/app/orders/settings/customer");
  await expect(
    page.getByText(
      "Off. Each sales order is filed against its own Shopify customer.",
    ),
  ).toBeVisible();

  await page.getByLabel("Customer or company name").fill("Spletna prodaja");
  await page.getByLabel("Street and number").fill("Trzaska cesta 1");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText(
      "Every new sales order is filed against Spletna prodaja in MetaKocka, not the Shopify customer.",
    ),
  ).toBeVisible();

  await page.goto("/app/orders/settings");
  await expect(
    page.getByText("Every sales order is filed against Spletna prodaja."),
  ).toBeVisible();

  await page.goto("/app/orders/settings/customer");
  await page
    .getByRole("button", { name: "Turn off and use each order's customer" })
    .click();
  await expect(
    page.getByText(
      "Off. Each sales order is filed against its own Shopify customer.",
    ),
  ).toBeVisible();
});
