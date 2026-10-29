import { saveAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";

import { valuesPlan } from "../../support/values-fixtures";
import { ownerOf, seedCatalogueSnapshot } from "../support/seed";
import { expect, test } from "../support/test";

/**
 * docs/attributes.md § Bulk values, end to end: export the masts, upload the
 * filled file, see the preview without anything reaching Shopify, apply it
 * as a background job, and see the values in the store and the page's result.
 */

const MUTATIONS = /Create|Update|Delete|Set\b/;

function masts() {
  const variant = (id: number, size: string) => ({
    id: `gid://shopify/ProductVariant/${id}`,
    title: size,
    sku: `MAST-${size}`,
    price: "500.00",
    compareAtPrice: null,
    inventory: {},
    metafields: {},
  });
  return [
    {
      id: "gid://shopify/Product/9100",
      title: "Loftsails Team Edition III C100 RDM",
      handle: "team-edition",
      status: "ACTIVE" as const,
      vendor: "Loftsails",
      productType: "Masts",
      tags: [],
      descriptionHtml: "",
      metafields: {},
      variants: [variant(91001, "370"), variant(91002, "430"), variant(91003, "460")],
    },
  ];
}

const HEADER =
  "product_id,variant_id,Length [recharge.length_cm] (cm),Mast diameter [recharge.mast_diameter]";
const row = (variant: number, length: string, diameter: string) =>
  `gid://shopify/Product/9100,gid://shopify/ProductVariant/${variant},${length},${diameter}`;

test.beforeEach(async ({ shop }) => {
  await shop.resetServices({ shopify: { products: masts() } });
  await seedCatalogueSnapshot(shop);
  await saveAttributeSchema(ownerOf(shop), valuesPlan(), 0);
});

test("exports the masts with hints for the empty lengths", async ({ page }) => {
  await page.goto("/app/product-setup/values");
  await expect(page.getByText("Upload filled file")).toBeVisible();
  await expect(page.getByText("How to")).toBeVisible();

  const csv = await page.evaluate(async () => {
    const response = await fetch(
      "/app/product-setup/values.csv?attributes=rig&types=masts",
    );
    return { status: response.status, text: await response.text() };
  });
  expect(csv.status).toBe(200);
  expect(csv.text).toContain("Length [recharge.length_cm] (cm)");
  expect(csv.text).toContain("hint_length_cm");
  expect(csv.text.split(/\r?\n/).filter(Boolean)).toHaveLength(4);
});

test("previews without writing, then applies in the background", async ({
  page,
  shop,
}) => {
  await page.goto("/app/product-setup/values");
  await page.setInputFiles('input[type="file"]', {
    name: "masts.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      [HEADER, row(91001, "370", "RDM"), row(91002, "430,5", "rdm"), row(91003, "460", "")].join("\n"),
    ),
  });
  await expect(page.getByText("5 values would be written")).toBeVisible();
  await expect(page.getByText(/Nothing has been written yet/)).toBeVisible();
  await expect(page.getByText(/Untyped until definitions are created/)).toBeVisible();

  // Previewing is read-only: not one mutation reached the store.
  const preview = await shop.calls();
  expect(preview.filter((call) => MUTATIONS.test(call.operation))).toEqual([]);

  await page.locator('s-button[slot="primary-action"]').dispatchEvent("click");
  await expect
    .poll(
      async () =>
        (await shop.services()).shopify.products[0]?.variants.filter(
          (v) => v.metafields["recharge.length_cm"],
        ).length,
      { timeout: 45_000 },
    )
    .toBe(3);
  await shop.settleJobs();

  const { shopify } = await shop.services();
  const variants = shopify.products[0]?.variants ?? [];
  expect(variants[1]?.metafields["recharge.length_cm"]).toMatchObject({
    type: "dimension",
    value: '{"value":430.5,"unit":"CENTIMETERS"}',
  });
  expect(variants[0]?.metafields["recharge.mast_diameter"]?.value).toBe("rdm");

  await page.reload();
  await expect(page.getByText(/^Done/)).toBeVisible();
});

test("lists the errors of a file and offers no apply", async ({ page, shop }) => {
  await page.goto("/app/product-setup/values");
  await page.setInputFiles('input[type="file"]', {
    name: "bad.csv",
    mimeType: "text/csv",
    buffer: Buffer.from([HEADER, row(91001, "430-460", "xdm")].join("\n")),
  });
  await expect(page.getByText("2 errors to fix before anything can be applied")).toBeVisible();
  await expect(page.getByText(/not one number/)).toBeVisible();
  await expect(page.locator('s-button[slot="primary-action"]')).toHaveText(
    "Upload another file",
  );
  const calls = await shop.calls();
  expect(calls.filter((call) => MUTATIONS.test(call.operation))).toEqual([]);
});

test("refuses a file that is not a CSV with a sentence", async ({ page }) => {
  await page.goto("/app/product-setup/values");
  await page.setInputFiles('input[type="file"]', {
    name: "values.csv",
    mimeType: "text/csv",
    buffer: Buffer.from('{"not":"a csv"}'),
  });
  await expect(page.getByText(/not a CSV file/)).toBeVisible();
});
