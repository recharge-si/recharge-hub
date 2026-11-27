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

/**
 * Wholesale pricing is saved from its own form, says what it does once a
 * customer is set, and refuses a discount that is not a percentage.
 */
test("wholesale pricing is saved beside the fixed customer", async ({
  page,
  shop,
}) => {
  await seedConnectedShop(shop, {
    locations: { "gid://shopify/Location/1": "glavno" },
  });

  await page.goto("/app/orders/settings/customer");
  await page.getByLabel("Customer or company name").fill("LISA Windsurfing");
  await page.getByLabel("Street and number").fill("Rue du Port 1");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText(
      "Every new sales order is filed against LISA Windsurfing in MetaKocka, not the Shopify customer.",
    ),
  ).toBeVisible();

  const wholesale =
    "Every sales order to LISA Windsurfing is a wholesale order: each line at its net price on MetaKocka pricelist 4 less 20%, with no VAT.";

  await page.getByLabel("MetaKocka pricelist code").fill("4");
  await page.getByLabel("Line discount (%)").fill("120");
  await page.getByRole("button", { name: "Save pricing and title" }).click();
  await expect(
    page.getByText(
      "Enter the discount as a percentage from 0 to 99.99, such as 20, or leave it empty.",
    ),
  ).toBeVisible();

  await page.getByLabel("Line discount (%)").fill("20");
  await page.getByRole("button", { name: "Save pricing and title" }).click();
  await expect(page.getByText(wholesale)).toBeVisible();

  // Saving the customer again keeps the pricing.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(wholesale)).toBeVisible();
});
