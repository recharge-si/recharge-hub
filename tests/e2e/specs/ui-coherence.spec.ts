import { seedConnectedShop } from "../support/seed";
import { expect, test } from "../support/test";

/**
 * PRD 3 (tasks/prd-03-ui-coherence.md): one name for the area, the same
 * process header on every page that owns a process, and no green for a
 * normal state. Written without a browser to run it in; the unit rules in
 * tests/unit/ui-rules.test.ts are what has run.
 */
const LOCATION = "gid://shopify/Location/1";

async function seed(shop: Parameters<typeof seedConnectedShop>[0]) {
  await seedConnectedShop(shop, { locations: { [LOCATION]: "glavno" } });
}

test("Product setup is one name in the menu, the heading and the address", async ({
  page,
  shop,
}) => {
  await seed(shop);
  await page.goto("/app");
  const nav = page.locator("s-app-nav");
  await expect(nav.locator('s-link[href="/app/product-setup"]')).toHaveText(
    "Product setup",
  );
  await expect(nav.getByText("Metafields")).toHaveCount(0);

  await page.goto("/app/product-setup");
  await expect(page).toHaveURL(/\/app\/product-setup\/types/);
  await expect(page.locator("s-page").first()).toHaveAttribute(
    "heading",
    "Product setup",
  );
  await expect(
    page.locator('s-box[accessibilityLabel="Product setup sections"]'),
  ).toBeAttached();
});

test("an old bookmark into Product setup still opens", async ({
  page,
  shop,
}) => {
  await seed(shop);
  const response = await page.goto("/app/product-setup/attributes");
  expect(response?.status()).toBe(200);
});

const WITH_HEADER = [
  "/app/metakocka/products",
  "/app/metakocka/locations",
  "/app/product-setup/menu",
];

for (const path of WITH_HEADER) {
  test(`${path} opens with the process header`, async ({ page, shop }) => {
    await shop.resetServices({
      shopify: { locations: [{ id: LOCATION, name: "Glavno skladišče" }] },
    });
    await seed(shop);
    await page.goto(path);
    const header = page
      .getByText(/^(Healthy|Needs attention|Never run|Off) · /)
      .first();
    await expect(header).toBeVisible();
    await expect(header).not.toContainText("T00:");
  });
}

const NO_GREEN = [
  "/app/metakocka/locations/settings",
  "/app/orders/settings/payments",
  "/app/settings/metakocka",
  "/app/sources/review",
  "/app/translations",
  "/app/product-setup/menu",
];

for (const path of NO_GREEN) {
  test(`${path} has nothing green on a calm page`, async ({ page, shop }) => {
    await seed(shop);
    await page.goto(path);
    await expect(page.locator("s-page").first()).toBeAttached();
    await expect(page.locator('[tone="success"]')).toHaveCount(0);
  });
}

test("Sources pages share one tab row and mark the current one", async ({
  page,
  shop,
}) => {
  await seed(shop);
  await page.goto("/app/sources/review");
  const tabs = page.locator('s-box[accessibilityLabel="Sources sections"]');
  await expect(tabs.locator('[aria-current="page"]')).toHaveText(/Review/);
  for (const label of ["Sources", "AI categorization", "Connection"])
    await expect(tabs.getByText(label, { exact: true })).toBeVisible();
});

test("after setup, Order settings own the transfer switch and the reference", async ({
  page,
  shop,
}) => {
  await seed(shop);
  await page.goto("/app/setup?step=orders");
  await expect(page.getByText(/^Order transfer is (on|off)\.$/)).toBeVisible();
  await expect(
    page.locator('s-link[href="/app/orders/settings"]').first(),
  ).toBeVisible();
  await expect(
    page.locator('s-checkbox[label="Transfer orders to MetaKocka"]'),
  ).toHaveCount(0);
  await expect(page.locator("s-text-field[label*='Reference pattern']")).toHaveCount(0);
});

test("the MetaKocka catalogue page is headed MetaKocka products", async ({
  page,
  shop,
}) => {
  await seed(shop);
  await page.goto("/app/products");
  await page.getByText("MetaKocka products").first().click();
  await expect(page).toHaveURL(/\/app\/metakocka\/products/);
  await expect(page.locator("s-page").first()).toHaveAttribute(
    "heading",
    "MetaKocka products",
  );
});
