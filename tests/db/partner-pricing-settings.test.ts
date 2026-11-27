import { afterEach, expect, it } from "vitest";

import {
  getFixedPartner,
  getPartnerDocumentSettings,
  saveFixedPartner,
  savePartnerDocumentSettings,
} from "~/adapters/db/repositories/sales-order-setting.server";

import {
  createTenant,
  describeDatabase,
  destroyTenant,
  type TestTenant,
} from "./harness";

/**
 * Partner pricing and the sales order title are stored beside the fixed
 * partner and saved from their own form: neither save may clear the other, and
 * pricing is only in force with a fixed partner.
 */
describeDatabase("partner pricing settings", () => {
  let tenant: TestTenant | null = null;

  afterEach(async () => {
    if (tenant) await destroyTenant(tenant);
    tenant = null;
  });

  it("is off for a shop that never set it", async () => {
    tenant = await createTenant("pricing-none");
    expect(await getPartnerDocumentSettings(tenant.principal)).toEqual({
      pricelistCode: null,
      discountPercent: null,
      titleTemplate: null,
      pricing: null,
    });
  });

  it("is in force only together with a fixed partner, and saves keep each other", async () => {
    tenant = await createTenant("pricing-fixed");
    await savePartnerDocumentSettings(tenant.principal, {
      pricelistCode: "4",
      discountPercent: "20",
      titleTemplate: "LISA {order.name}",
    });

    const alone = await getPartnerDocumentSettings(tenant.principal);
    expect(alone.pricelistCode).toBe("4");
    expect(alone.titleTemplate).toBe("LISA {order.name}");
    expect(alone.pricing).toBeNull();

    await saveFixedPartner(tenant.principal, {
      customer: "LISA Windsurfing",
      street: "Rue du Port 1",
      postNumber: null,
      place: null,
      country: "France",
      isBusiness: true,
      taxNumber: null,
      email: null,
      phone: null,
    });

    expect(
      (await getPartnerDocumentSettings(tenant.principal)).pricing,
    ).toEqual({ pricelistCode: "4", discountPercent: "20" });

    // Saving pricing again keeps the partner.
    await savePartnerDocumentSettings(tenant.principal, {
      pricelistCode: "4",
      discountPercent: null,
      titleTemplate: null,
    });
    expect((await getFixedPartner(tenant.principal))?.partner.customer).toBe(
      "LISA Windsurfing",
    );
    expect(
      (await getPartnerDocumentSettings(tenant.principal)).pricing,
    ).toEqual({ pricelistCode: "4", discountPercent: null });
  });
});
