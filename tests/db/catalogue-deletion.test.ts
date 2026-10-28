import { afterEach, expect, it } from "vitest";

import { prisma } from "~/adapters/db/client.server";
import {
  applyProductUpdate,
  removeCatalogueProduct,
  replaceCatalogue,
  type ProductUpdate,
} from "~/adapters/db/repositories/catalogue.server";
import {
  countReadyAutofills,
  forgetAutofill,
  readyAutofillProductIds,
} from "~/adapters/db/repositories/product-autofill.server";
import type { CatalogueProductRecord } from "~/adapters/shopify/catalogue";

import {
  createTenant,
  describeDatabase,
  destroyTenant,
  type TestTenant,
} from "./harness";

/**
 * A product deleted in Shopify leaves the catalogue snapshot and stays out:
 * a `products/update` handled after the delete, or a bulk read that started
 * before it, does not bring it back (docs/sale-campaigns.md § catalog_product).
 */
describeDatabase("catalogue deletion", () => {
  const tenants: TestTenant[] = [];

  afterEach(async () => {
    for (const tenant of tenants.splice(0)) await destroyTenant(tenant);
  });

  const productId = "gid://shopify/Product/1";

  const update: ProductUpdate = {
    productId,
    title: "Board",
    handle: "board",
    vendor: null,
    productType: null,
    status: "ACTIVE",
    tags: [],
    imageUrl: null,
    description: null,
    shopifyUpdatedAt: null,
    variants: [
      {
        variantId: "gid://shopify/ProductVariant/11",
        sku: "B-1",
        barcode: null,
        title: null,
        priceMinor: 1000,
        compareAtMinor: null,
        options: [],
        inventoryQuantity: null,
        availableForSale: true,
      },
    ],
  };

  function record(id: string): CatalogueProductRecord {
    return {
      productId: id,
      title: `Product ${id}`,
      handle: null,
      onlineStoreUrl: null,
      description: null,
      vendor: null,
      productType: null,
      status: "ACTIVE",
      tags: [],
      collectionIds: [],
      categoryId: null,
      categoryName: null,
      imageUrl: null,
      shopifyUpdatedAt: null,
      metafields: {},
      variants: [
        {
          variantId: `${id}/variant`,
          productId: id,
          sku: null,
          barcode: null,
          title: null,
          priceMinor: 500,
          compareAtMinor: null,
          options: [],
          inventoryQuantity: null,
          availableForSale: true,
          metafields: {},
        },
      ],
    };
  }

  async function productIds(tenant: TestTenant): Promise<string[]> {
    const rows = await prisma.catalogProduct.findMany({
      where: { shopId: tenant.shopId },
      select: { shopifyProductId: true },
      orderBy: { shopifyProductId: "asc" },
    });
    return rows.map((row) => row.shopifyProductId);
  }

  it("ignores a products/update that arrives after the delete", async () => {
    const tenant = await createTenant("catalogue-deletion-late-update");
    tenants.push(tenant);

    await applyProductUpdate(tenant.principal, update, new Date());
    expect(await productIds(tenant)).toEqual([productId]);

    await removeCatalogueProduct(tenant.principal, productId);
    expect(await productIds(tenant)).toEqual([]);

    const late = await applyProductUpdate(
      tenant.principal,
      { ...update, title: "Board (late)" },
      new Date(),
    );
    expect(late).toEqual({ changed: false });
    expect(await productIds(tenant)).toEqual([]);
  });

  it("leaves a deleted product out of a bulk read that still lists it", async () => {
    const tenant = await createTenant("catalogue-deletion-bulk");
    tenants.push(tenant);

    await removeCatalogueProduct(tenant.principal, productId);
    const counts = await replaceCatalogue(
      tenant.principal,
      [record(productId), record("gid://shopify/Product/2")],
      "EUR",
      new Date(),
    );

    expect(counts).toEqual({ products: 1, variants: 1 });
    expect(await productIds(tenant)).toEqual(["gid://shopify/Product/2"]);
  });

  it("forgets old deletions when the catalogue is read again", async () => {
    const tenant = await createTenant("catalogue-deletion-prune");
    tenants.push(tenant);

    await prisma.catalogProductDeletion.create({
      data: {
        shopId: tenant.shopId,
        shopifyProductId: productId,
        deletedAt: new Date("2026-01-01"),
      },
    });
    await replaceCatalogue(tenant.principal, [], "EUR", new Date("2026-03-01"));

    expect(
      await prisma.catalogProductDeletion.count({
        where: { shopId: tenant.shopId },
      }),
    ).toBe(0);
  });

  it("does not count AI suggestions for products no longer in the catalogue", async () => {
    const tenant = await createTenant("catalogue-deletion-autofill");
    tenants.push(tenant);

    await applyProductUpdate(tenant.principal, update, new Date());
    const gone = "gid://shopify/Product/2";
    for (const id of [productId, gone]) {
      await prisma.productAutofill.create({
        data: { shopId: tenant.shopId, productId: id, status: "ready" },
      });
    }

    expect(await countReadyAutofills(tenant.principal)).toBe(1);
    expect(await readyAutofillProductIds(tenant.principal)).toEqual([
      productId,
    ]);

    await removeCatalogueProduct(tenant.principal, productId);
    await forgetAutofill(tenant.principal, productId);
    expect(await countReadyAutofills(tenant.principal)).toBe(0);
    expect(
      await prisma.productAutofill.count({
        where: { shopId: tenant.shopId, productId },
      }),
    ).toBe(0);
  });
});
