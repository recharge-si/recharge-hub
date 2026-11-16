import type { Job } from "pg-boss";
import { afterEach, expect, it } from "vitest";

import {
  claimExceptionAlert,
  releaseExceptionAlert,
} from "~/adapters/db/repositories/exception.server";
import {
  countPaidOrdersWithoutDocument,
  listWatchdogOrders,
} from "~/adapters/db/repositories/order-watchdog.server";
import { markSetupComplete } from "~/adapters/db/repositories/shop.server";
import { handleWatchOrders } from "~/jobs/handlers/watch-orders";

import {
  createOrder,
  createTenant,
  describeDatabase,
  destroyTenant,
  prisma,
  type TestTenant,
} from "./harness";

/**
 * The order watchdog against a real database (docs/project-status.md T-11):
 * the candidate query, the exception it raises through the ordinary dedupe
 * path, the app closing it, and the one-shot alert claim.
 */
describeDatabase("order watchdog", () => {
  let tenant: TestTenant | null = null;
  const HOUR = 60 * 60_000;

  afterEach(async () => {
    if (tenant) await destroyTenant(tenant);
    tenant = null;
  });

  const jobFor = (t: TestTenant) =>
    ({ data: { shopDomain: t.domain } }) as Job<unknown>;

  it("raises one exception per quiet order, and closes it when transfer is turned off", async () => {
    tenant = await createTenant("watchdog");
    await markSetupComplete(tenant.principal, new Date(Date.now() - 24 * HOUR));
    const orderId = await createOrder(tenant, { number: "#1006" });
    await prisma.order.update({
      where: { id: orderId },
      data: { financialStatus: "paid" },
    });
    const later = new Date(Date.now() + 3 * HOUR);

    // Twice: the second run updates the open row rather than adding one.
    expect(
      (await handleWatchOrders(jobFor(tenant), { now: later })).raised,
    ).toBe(1);
    expect(
      (await handleWatchOrders(jobFor(tenant), { now: later })).raised,
    ).toBe(0);

    const open = await prisma.exception.findMany({
      where: { shopId: tenant.shopId, kind: "order_not_transferred" },
    });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      orderId,
      status: "open",
      dedupeKey: `order:${orderId}`,
    });

    expect(await countPaidOrdersWithoutDocument(tenant.principal)).toBe(1);

    await prisma.salesOrderSetting.create({
      data: { shopId: tenant.shopId, transferOrders: false },
    });
    expect(
      (await handleWatchOrders(jobFor(tenant), { now: later })).cleared,
    ).toBe(1);

    const closed = await prisma.exception.findFirstOrThrow({
      where: { id: open[0]!.id },
    });
    expect(closed).toMatchObject({ status: "resolved", resolvedBy: "app" });
  });

  it("does not look at an order that is written and verified, or cancelled", async () => {
    tenant = await createTenant("watchdog-ok");
    const written = await createOrder(tenant, { number: "#2001" });
    const cancelled = await createOrder(tenant, { number: "#2002" });
    await prisma.order.update({
      where: { id: written },
      data: { syncState: "in_sync" },
    });
    await prisma.metakockaDocument.create({
      data: {
        shopId: tenant.shopId,
        orderId: written,
        supplySourceId: tenant.supplySourceId,
        countCode: `SH-2001-${tenant.shopId.slice(-4)}`,
        status: "written",
      },
    });
    await prisma.order.update({
      where: { id: cancelled },
      data: { cancelledAt: new Date() },
    });

    const rows = await listWatchdogOrders(tenant.principal, {
      receivedAfter: new Date(Date.now() - 24 * HOUR),
      receivedBefore: new Date(Date.now() + HOUR),
      limit: 50,
    });
    expect(rows).toEqual([]);
  });

  it("claims an alert once, and again only after it is given back", async () => {
    tenant = await createTenant("watchdog-alert");
    await markSetupComplete(tenant.principal, new Date(Date.now() - 24 * HOUR));
    await createOrder(tenant, { number: "#3001" });
    await handleWatchOrders(jobFor(tenant), {
      now: new Date(Date.now() + 3 * HOUR),
    });
    const row = await prisma.exception.findFirstOrThrow({
      where: { shopId: tenant.shopId, kind: "order_not_transferred" },
    });

    const options = {
      now: new Date(),
      repeatWindowMs: 24 * HOUR,
      perShopHourly: 20,
    };
    const first = await claimExceptionAlert(tenant.principal, row.id, options);
    expect(first).toEqual({
      claimed: true,
      alert: expect.objectContaining({
        kind: "order_not_transferred",
        orderNumber: "#3001",
      }),
    });
    expect(
      await claimExceptionAlert(tenant.principal, row.id, options),
    ).toEqual({
      claimed: false,
      why: "already_alerted",
    });

    await releaseExceptionAlert(tenant.principal, row.id);
    expect(
      (await claimExceptionAlert(tenant.principal, row.id, options)).claimed,
    ).toBe(true);
  });
});
