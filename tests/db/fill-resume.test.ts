import { afterEach, expect, it } from "vitest";

import { prisma } from "~/adapters/db/client.server";
import {
  failAutofill,
  getAutofill,
  nextUnaskedProducts,
  recordNothingSuggested,
  saveAutofillSuggestion,
} from "~/adapters/db/repositories/product-autofill.server";
import { catalogueForFill } from "~/adapters/db/repositories/rig-catalogue.server";

import {
  createTenant,
  describeDatabase,
  destroyTenant,
  type TestTenant,
} from "./harness";

/**
 * docs/attributes.md, Bulk filling with claude-pool: progress is the
 * `product_autofill` table. A restart asks only products with no row or a
 * failed one, every suggestion carries its source and model, and one shop's
 * rows and catalogue never appear in another's.
 */
describeDatabase("bulk fill progress", () => {
  const tenants: TestTenant[] = [];
  afterEach(async () => {
    for (const tenant of tenants.splice(0)) await destroyTenant(tenant);
  });

  async function product(tenant: TestTenant, n: number) {
    await prisma.catalogProduct.create({
      data: {
        shopId: tenant.shopId,
        shopifyProductId: `gid://shopify/Product/${n}`,
        title: `Sail ${n}`,
        tags: [],
        collectionIds: [],
      },
    });
  }

  const suggestion = {
    typeId: "sails",
    typeOrigin: "kept" as const,
    typeConfidence: null,
    typeReason: null,
    values: [],
    engine: "claude-pool",
    source: "claude-pool",
    model: "claude-fake-1",
  };

  it("asks only products without a row or with a failed one", async () => {
    const tenant = await createTenant("fill-resume");
    tenants.push(tenant);
    for (const n of [1, 2, 3, 4, 5]) await product(tenant, n);
    const id = (n: number) => `gid://shopify/Product/${n}`;

    await saveAutofillSuggestion(tenant.principal, id(1), suggestion);
    await recordNothingSuggested(
      tenant.principal,
      id(2),
      { source: "claude-pool", model: "claude-fake-1" },
      "sails",
    );
    await failAutofill(tenant.principal, id(3), "No answer", "claude-pool");

    const walk = await nextUnaskedProducts(tenant.principal, null, 50);
    expect(walk.ids).toEqual([id(3), id(4), id(5)]);
  });

  it("stores the source and model with the suggestion", async () => {
    const tenant = await createTenant("fill-source");
    tenants.push(tenant);
    await product(tenant, 1);
    await saveAutofillSuggestion(
      tenant.principal,
      "gid://shopify/Product/1",
      suggestion,
    );
    const state = await getAutofill(
      tenant.principal,
      "gid://shopify/Product/1",
    );
    expect(state).toMatchObject({
      status: "ready",
      source: "claude-pool",
      model: "claude-fake-1",
    });
  });

  it("keeps each shop's catalogue and rows apart", async () => {
    const a = await createTenant("fill-a");
    const b = await createTenant("fill-b");
    tenants.push(a, b);
    await product(a, 1);
    await product(b, 2);
    await saveAutofillSuggestion(
      a.principal,
      "gid://shopify/Product/1",
      suggestion,
    );

    expect((await nextUnaskedProducts(a.principal, null, 50)).ids).toEqual([]);
    expect((await nextUnaskedProducts(b.principal, null, 50)).ids).toEqual([
      "gid://shopify/Product/2",
    ]);
    expect(
      (await catalogueForFill(a.principal, ["gid://shopify/Product/2"])).length,
    ).toBe(0);
    expect(
      await getAutofill(b.principal, "gid://shopify/Product/1"),
    ).toBeNull();
  });
});
