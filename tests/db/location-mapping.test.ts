import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import {
  getSupplyDefaults,
  saveSupplyDefaults,
} from "~/adapters/db/repositories/supply-setting.server";
import { listSupplySources } from "~/adapters/db/repositories/supply-source.server";
import { INHERIT } from "~/web/lib/locations";
import { saveLocationMapping } from "~/web/lib/locations.server";

import {
  createTenant,
  describeDatabase,
  destroyTenant,
  prisma,
  type TestTenant,
} from "./harness";

/**
 * Connecting a Shopify location to a MetaKocka warehouse.
 *
 * This moved into `web/lib/locations.server` so guided setup and the locations
 * page share one implementation, and the reason it is worth a database test is
 * the invariant it carries: docs/BUILD_SPEC.md section 7 allows exactly one app
 * writing stock into a Shopify location, and a second writer means two systems
 * overwriting each other's quantities in a live store.
 *
 * The inheritance rules are here too, because a merchant's explicit override
 * surviving a change to the shop default is a promise section 7 makes and
 * nothing else checks end to end.
 */
const LOCATION_A = "gid://shopify/Location/1";
const LOCATION_B = "gid://shopify/Location/2";

describeDatabase("saveLocationMapping", () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant("locations");

    await prisma.metakockaWarehouse.createMany({
      data: [
        {
          shopId: tenant.shopId,
          mkId: "1",
          mark: "MAIN",
          name: "Main warehouse",
          isMain: true,
          isActive: true,
        },
        {
          shopId: tenant.shopId,
          mkId: "2",
          mark: "PARTNER",
          name: "Partner supply",
          isMain: false,
          isActive: true,
        },
      ],
    });
  });

  beforeEach(async () => {
    // Each test starts from "nothing connected, MetaKocka is counted".
    await prisma.supplySource.updateMany({
      where: { shopId: tenant.shopId },
      data: {
        shopifyLocationId: null,
        stockDirection: "none",
        stockDirectionInherited: true,
        inventoryWriter: "external",
      },
    });
    await saveSupplyDefaults(tenant.principal, {
      defaultStockDirection: "mk_to_shopify",
      defaultProfitCenter: null,
    });
  });

  afterAll(async () => {
    await destroyTenant(tenant);
  });

  async function sourceFor(mark: string) {
    const sources = await listSupplySources(tenant.principal);
    return sources.find((source) => source.metakockaWarehouse === mark) ?? null;
  }

  it("takes the shop default when the location inherits", async () => {
    const outcome = await saveLocationMapping(tenant.principal, {
      shopifyLocationId: LOCATION_A,
      warehouseMark: "MAIN",
      direction: INHERIT,
      profitCenter: INHERIT,
    });

    expect(outcome.ok).toBe(true);

    const source = await sourceFor("MAIN");
    expect(source?.stockDirection).toBe("mk_to_shopify");
    expect(source?.stockDirectionInherited).toBe(true);
    // Section 7: the writer follows from the direction, never chosen separately.
    expect(source?.inventoryWriter).toBe("metakocka");
  });

  it("records an explicit choice as an override, not as the default", async () => {
    await saveLocationMapping(tenant.principal, {
      shopifyLocationId: LOCATION_A,
      warehouseMark: "MAIN",
      direction: "shopify_to_mk",
      profitCenter: INHERIT,
    });

    const source = await sourceFor("MAIN");
    expect(source?.stockDirection).toBe("shopify_to_mk");
    expect(source?.stockDirectionInherited).toBe(false);
    // Shopify is counted here, so this app never writes into that Shopify
    // location: the quantities there are the ones being read from.
    expect(source?.inventoryWriter).toBe("manual");
  });

  it("leaves an explicit override alone when the default changes", async () => {
    await saveLocationMapping(tenant.principal, {
      shopifyLocationId: LOCATION_A,
      warehouseMark: "MAIN",
      direction: "shopify_to_mk",
      profitCenter: INHERIT,
    });
    await saveLocationMapping(tenant.principal, {
      shopifyLocationId: LOCATION_B,
      warehouseMark: "PARTNER",
      direction: INHERIT,
      profitCenter: INHERIT,
    });

    await saveSupplyDefaults(tenant.principal, {
      defaultStockDirection: "none",
      defaultProfitCenter: null,
    });

    expect((await sourceFor("MAIN"))?.stockDirection).toBe("shopify_to_mk");
    expect((await sourceFor("PARTNER"))?.stockDirection).toBe("none");
  });

  it("refuses a second warehouse writing stock into one Shopify location", async () => {
    await saveLocationMapping(tenant.principal, {
      shopifyLocationId: LOCATION_A,
      warehouseMark: "MAIN",
      direction: "mk_to_shopify",
      profitCenter: INHERIT,
    });

    const outcome = await saveLocationMapping(tenant.principal, {
      shopifyLocationId: LOCATION_A,
      warehouseMark: "PARTNER",
      direction: "mk_to_shopify",
      profitCenter: INHERIT,
      viaConnect: true,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("already");
    // Nothing was moved: the first warehouse still holds the location.
    expect((await sourceFor("MAIN"))?.shopifyLocationId).toBe(LOCATION_A);
    expect((await sourceFor("PARTNER"))?.shopifyLocationId).toBeNull();
  });

  it("lets a second warehouse share a location when it does not write stock", async () => {
    await saveLocationMapping(tenant.principal, {
      shopifyLocationId: LOCATION_A,
      warehouseMark: "MAIN",
      direction: "mk_to_shopify",
      profitCenter: INHERIT,
    });

    // Editing the location to point at another warehouse is a request to change
    // what it uses, so the first one lets go rather than being refused.
    const outcome = await saveLocationMapping(tenant.principal, {
      shopifyLocationId: LOCATION_A,
      warehouseMark: "PARTNER",
      direction: "shopify_to_mk",
      profitCenter: INHERIT,
    });

    expect(outcome.ok).toBe(true);
    expect((await sourceFor("MAIN"))?.shopifyLocationId).toBeNull();
    expect((await sourceFor("PARTNER"))?.shopifyLocationId).toBe(LOCATION_A);
  });

  it("disconnects a location without deleting its supply source", async () => {
    await saveLocationMapping(tenant.principal, {
      shopifyLocationId: LOCATION_A,
      warehouseMark: "MAIN",
      direction: INHERIT,
      profitCenter: INHERIT,
    });

    const outcome = await saveLocationMapping(tenant.principal, {
      shopifyLocationId: LOCATION_A,
      warehouseMark: "",
    });

    expect(outcome.ok).toBe(true);
    const source = await sourceFor("MAIN");
    expect(source).not.toBeNull();
    expect(source?.shopifyLocationId).toBeNull();
    expect(source?.stockDirection).toBe("none");
  });

  it("refuses a warehouse MetaKocka no longer has", async () => {
    const outcome = await saveLocationMapping(tenant.principal, {
      shopifyLocationId: LOCATION_A,
      warehouseMark: "DELETED",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("no longer in the list");
  });

  it("keeps the default profit centre when a location inherits it", async () => {
    await saveSupplyDefaults(tenant.principal, {
      defaultStockDirection: "mk_to_shopify",
      defaultProfitCenter: "Webshop",
    });

    await saveLocationMapping(tenant.principal, {
      shopifyLocationId: LOCATION_A,
      warehouseMark: "MAIN",
      direction: INHERIT,
      profitCenter: INHERIT,
    });

    const source = await sourceFor("MAIN");
    expect(source?.metakockaProfitCenter).toBe("Webshop");
    expect(source?.profitCenterInherited).toBe(true);
    expect(
      (await getSupplyDefaults(tenant.principal)).defaultProfitCenter,
    ).toBe("Webshop");
  });
});
