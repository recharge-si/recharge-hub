import { afterEach, expect, it } from "vitest";

import { markSetupComplete } from "~/adapters/db/repositories/shop.server";
import { writeMetakockaOrderFor } from "~/jobs/handlers/write-metakocka-order";

import {
  createOrder,
  createTenant,
  describeDatabase,
  destroyTenant,
  prisma,
  type TestTenant,
} from "./harness";

/**
 * Nothing reaches the ERP before a person presses Finish setup (the product UX
 * brief, section 11).
 *
 * Guided setup saves the MetaKocka credentials at its second step, so between
 * there and the end a shop is connected without having chosen its warehouses or
 * its payment types. A sales order filed in that window is filed against
 * answers nobody finished giving, and nothing in this system deletes a
 * MetaKocka document afterwards.
 *
 * The gate lives in the one executor every write goes through, and this is what
 * proves it: the same call is refused before activation and reaches the ERP
 * step after it.
 */
describeDatabase("MetaKocka writes before setup is finished", () => {
  let tenant: TestTenant | null = null;

  afterEach(async () => {
    if (tenant) await destroyTenant(tenant);
    tenant = null;
  });

  it("writes nothing, and reports nothing, while setup is unfinished", async () => {
    tenant = await createTenant("gate-off");
    const orderId = await createOrder(tenant);

    await writeMetakockaOrderFor(tenant.principal, {
      orderId,
      supplySourceId: tenant.supplySourceId,
    });

    expect(
      await prisma.metakockaDocument.count({
        where: { shopId: tenant.shopId },
      }),
    ).toBe(0);
    // Not an exception either: a merchant partway through setup has done
    // nothing wrong, and the home page is already saying setup is unfinished.
    expect(
      await prisma.exception.count({ where: { shopId: tenant.shopId } }),
    ).toBe(0);
  });

  it("gets as far as the connection once setup is finished", async () => {
    tenant = await createTenant("gate-on");
    const orderId = await createOrder(tenant);

    await markSetupComplete(tenant.principal, new Date());

    await writeMetakockaOrderFor(tenant.principal, {
      orderId,
      supplySourceId: tenant.supplySourceId,
    });

    // This shop has no credentials, so the next thing the writer checks is the
    // one that fails -- which is exactly the point: the gate is no longer what
    // stops it.
    const raised = await prisma.exception.findMany({
      where: { shopId: tenant.shopId },
      select: { kind: true, message: true },
    });

    expect(raised).toHaveLength(1);
    expect(raised[0]?.kind).toBe("metakocka_write_failed");
    expect(raised[0]?.message).toContain("not connected");
    expect(
      await prisma.metakockaDocument.count({
        where: { shopId: tenant.shopId },
      }),
    ).toBe(0);
  });
});
