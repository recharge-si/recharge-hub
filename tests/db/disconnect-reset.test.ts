import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { isSyncActivated, resetShop } from "~/adapters/db/repositories/shop.server";

import {
  createOrder,
  createTenant,
  describeDatabase,
  prisma,
  type TestTenant,
} from "./harness";

/**
 * Disconnecting erases this app's data for the store and nothing else.
 *
 * A real database because the guarantee is PostgreSQL's, not TypeScript's:
 * `resetShop` deletes one row and relies on `ON DELETE CASCADE` to take every
 * shop-scoped table with it. A hand-written list of tables would pass a mock
 * and still miss whichever table was added last, which is the whole reason it
 * is written as a single delete.
 *
 * The two things keyed by shop domain rather than by foreign key are the point
 * of the last two assertions: `idempotency_key` does not cascade and must go
 * by name, and `session` does not cascade and must **stay**, because the
 * merchant is looking at the page and the app is still installed.
 */
describeDatabase("disconnecting a store", () => {
  let tenant: TestTenant;
  let sessionId: string;

  beforeAll(async () => {
    tenant = await createTenant("disconnect");
    sessionId = `offline_${tenant.domain}`;

    await createOrder(tenant, { number: "2001" });

    await prisma.$transaction([
      prisma.metakockaCredential.create({
        data: {
          shopId: tenant.shopId,
          companyId: "6789",
          secretKeyEncrypted: "not-a-real-key",
        },
      }),
      prisma.metakockaWarehouse.create({
        data: {
          shopId: tenant.shopId,
          mkId: "678900000004",
          mark: "glavno",
          name: "Main warehouse",
        },
      }),
      prisma.sku.create({
        data: {
          shopId: tenant.shopId,
          sku: "SKU-A",
          metakockaCode: "SKU-A",
          status: "matched",
        },
      }),
      prisma.idempotencyKey.create({
        data: {
          shopDomain: tenant.domain,
          scope: "orders",
          key: randomUUID(),
        },
      }),
      prisma.session.create({
        data: {
          id: sessionId,
          shop: tenant.domain,
          state: "",
          accessToken: "not-a-real-token",
        },
      }),
      prisma.shop.update({
        where: { id: tenant.shopId },
        data: { setupCompletedAt: new Date(), setupStep: "review" },
      }),
    ]);
  });

  afterAll(async () => {
    // By domain, not by the id in `tenant`: reset gives the shop a new row, so
    // the id the harness captured no longer exists.
    await prisma.session.deleteMany({ where: { shop: tenant.domain } });
    await prisma.idempotencyKey.deleteMany({
      where: { shopDomain: tenant.domain },
    });
    await prisma.shop.deleteMany({ where: { domain: tenant.domain } });
  });

  it("leaves the store installed, with nothing configured and setup unfinished", async () => {
    await resetShop(tenant.principal);

    const shop = await prisma.shop.findUnique({
      where: { domain: tenant.domain },
      select: { id: true, installState: true, setupCompletedAt: true, setupStep: true },
    });

    expect(shop).not.toBeNull();
    expect(shop?.installState).toBe("installed");
    expect(shop?.setupCompletedAt).toBeNull();
    expect(shop?.setupStep).toBeNull();
    // A new row, so nothing that referenced the old one survived by accident.
    expect(shop?.id).not.toBe(tenant.shopId);

    // Both MetaKocka writers read this, and it is what makes guided setup run
    // again rather than the store carrying on with half a configuration.
    expect(await isSyncActivated(tenant.principal)).toBe(false);
  });

  it("takes every shop-scoped table with it", async () => {
    const [credentials, warehouses, skus, sources, orders] = await Promise.all([
      prisma.metakockaCredential.count({ where: { shop: { domain: tenant.domain } } }),
      prisma.metakockaWarehouse.count({ where: { shop: { domain: tenant.domain } } }),
      prisma.sku.count({ where: { shop: { domain: tenant.domain } } }),
      prisma.supplySource.count({ where: { shop: { domain: tenant.domain } } }),
      prisma.order.count({ where: { shop: { domain: tenant.domain } } }),
    ]);

    expect({ credentials, warehouses, skus, sources, orders }).toEqual({
      credentials: 0,
      warehouses: 0,
      skus: 0,
      sources: 0,
      orders: 0,
    });
  });

  it("removes idempotency keys, which do not cascade", async () => {
    // They guard replays of webhooks for orders that no longer exist here.
    // Keeping them would suppress the re-delivery that would rebuild them.
    expect(
      await prisma.idempotencyKey.count({
        where: { shopDomain: tenant.domain },
      }),
    ).toBe(0);
  });

  it("keeps the Shopify session, because the app is still installed", async () => {
    expect(
      await prisma.session.count({ where: { shop: tenant.domain } }),
    ).toBe(1);
  });
});
