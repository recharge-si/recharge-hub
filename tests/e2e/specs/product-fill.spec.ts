import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { runFill } from "~/adapters/products/fill-runner.server";
import { mergeRigPack } from "~/domain/attributes/rig-pack";
import { emptySchema } from "~/domain/attributes/types";

import {
  envelope,
  installFakeClaude,
  scripted,
} from "../../support/fake-claude-pool";
import { ownerOf, seedCatalogueSnapshot } from "../support/seed";
import { expect, test } from "../support/test";

/**
 * docs/attributes.md, Bulk filling with claude-pool, end to end with a fake
 * `claude-pool` executable (never the real pool): a run over a 14-product
 * catalogue leaves suggestions for the 11 sails in the AI review, *Apply all*
 * writes metafields for those and for nothing else, and a second run asks no
 * one again.
 */

function catalogue() {
  const product = (i: number, productType: string) => ({
    id: `gid://shopify/Product/${2000 + i}`,
    title: `${productType} ${i}`,
    handle: `p-${i}`,
    status: "ACTIVE" as const,
    vendor: "Point-7",
    productType,
    tags: [],
    descriptionHtml: "",
    metafields: {},
    variants: [
      {
        id: `gid://shopify/ProductVariant/${6000 + i}`,
        title: "Default",
        sku: `SKU-${i}`,
        price: "100.00",
        compareAtPrice: null,
        inventory: {},
        metafields: {},
      },
    ],
  });
  return [
    ...Array.from({ length: 11 }, (_, i) => product(i + 1, "Sails")),
    ...Array.from({ length: 3 }, (_, i) => product(i + 12, "Mystery gear")),
  ];
}

test("fills the sails through the pool, reviews them and applies them", async ({
  page,
  shop,
}) => {
  const fake = installFakeClaude();
  const work = mkdtempSync(join(tmpdir(), "e2e-fill-"));
  const script = join(work, "script");
  writeFileSync(
    script,
    scripted(
      0,
      envelope(
        JSON.stringify({
          values: [{ attributeId: "rig_sail_category", value: "freeride" }],
        }),
        "claude-fake-1",
      ),
    ) + "\n",
  );
  fake.set("script", script);
  const originalPath = process.env["PATH"];
  process.env["PATH"] = fake.pathWith();

  try {
    await shop.resetServices({ shopify: { products: catalogue() } });
    await seedCatalogueSnapshot(shop);
    await saveAttributeSchema(
      ownerOf(shop),
      mergeRigPack(emptySchema()).schema,
      0,
    );

    const first = await runFill({
      shopDomain: shop.domain,
      types: null,
      limit: null,
      concurrency: 1,
      log: () => undefined,
    });
    expect(first).toMatchObject({ asked: 11, suggested: 11, noType: 3 });

    await page.goto("/app/products?view=review");
    await expect(page.getByText("Apply all (11)")).toBeVisible();
    await expect(page.getByText(/^AI suggestion:/)).toHaveCount(11);
    await expect(page.getByText(/Mystery gear/)).toHaveCount(0);

    await page.getByText("Apply all (11)").click();
    await page.getByRole("button", { name: "Apply all", exact: true }).click();
    // Applying is a background job queued by the click; wait for its writes
    // rather than for jobs that may not have been queued yet.
    const freeride = async () =>
      (await shop.services()).shopify.products.filter(
        (p) => p.metafields["recharge.sail_category"]?.value === "freeride",
      );
    await expect
      .poll(async () => (await freeride()).length, { timeout: 45_000 })
      .toBe(11);
    await shop.settleJobs();

    const { shopify } = await shop.services();
    const written = await freeride();
    expect(written).toHaveLength(11);
    expect(written.every((p) => p.productType === "Sails")).toBe(true);
    expect(
      shopify.products
        .filter((p) => p.productType === "Mystery gear")
        .every((p) => Object.keys(p.metafields).length === 0),
    ).toBe(true);

    // Resuming asks no one again.
    const second = await runFill({
      shopDomain: shop.domain,
      types: null,
      limit: null,
      concurrency: 1,
      log: () => undefined,
    });
    expect(second.asked).toBe(0);
  } finally {
    process.env["PATH"] = originalPath;
  }
});
