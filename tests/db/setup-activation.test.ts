import { afterAll, beforeAll, expect, it } from "vitest";

import { getReadiness } from "~/adapters/db/repositories/readiness.server";
import {
  getSetupState,
  isSyncActivated,
  markSetupComplete,
  saveSetupStep,
} from "~/adapters/db/repositories/shop.server";
import { componentOf } from "~/domain/readiness";

import {
  createTenant,
  describeDatabase,
  destroyTenant,
  prisma,
  type TestTenant,
} from "./harness";

/**
 * The activation boundary (the product UX brief, section 11).
 *
 * Guided setup saves each answer as it is given, so a shop can be connected and
 * half-configured at the same moment. `shop.setup_completed_at` is what says a
 * person pressed Finish, and both MetaKocka writers read it. The two properties
 * that matter are that it is idempotent — pressing Finish twice must not
 * activate twice or move the timestamp — and that it stays separate from
 * whether the shop is *configured*, which `domain/readiness` answers from the
 * configuration itself.
 *
 * A real database, because `markSetupComplete` is a conditional update and
 * "only the first caller wins" is a question about PostgreSQL, not about the
 * TypeScript around it.
 */
describeDatabase("setup activation", () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant("setup");
  });

  afterAll(async () => {
    await destroyTenant(tenant);
  });

  it("starts inactive, whatever else is configured", async () => {
    expect(await isSyncActivated(tenant.principal)).toBe(false);
    expect((await getSetupState(tenant.principal)).completedAt).toBeNull();
  });

  it("remembers the step without deciding anything", async () => {
    await saveSetupStep(tenant.principal, "orders");

    expect((await getSetupState(tenant.principal)).step).toBe("orders");
    // Still not activated: the step is UI state and nothing more.
    expect(await isSyncActivated(tenant.principal)).toBe(false);
  });

  it("activates once, and says so only the first time", async () => {
    const first = new Date("2026-08-26T10:00:00Z");
    const second = new Date("2026-08-26T11:00:00Z");

    expect(await markSetupComplete(tenant.principal, first)).toBe(true);
    expect(await markSetupComplete(tenant.principal, second)).toBe(false);

    const state = await getSetupState(tenant.principal);
    expect(state.completedAt?.toISOString()).toBe(first.toISOString());
    // The step is cleared on completion, so reopening the guide starts fresh.
    expect(state.step).toBeNull();
    expect(await isSyncActivated(tenant.principal)).toBe(true);
  });

  it("survives concurrent presses of Finish setup", async () => {
    const other = await createTenant("setup-race");
    try {
      const now = new Date("2026-08-26T12:00:00Z");
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          markSetupComplete(other.principal, now),
        ),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
    } finally {
      await destroyTenant(other);
    }
  });
});

/**
 * Readiness reads the configuration, never the activation flag, so a shop that
 * was configured before guided setup existed is not reported as unconfigured
 * (the product UX brief, section 12).
 */
describeDatabase("readiness against a real shop", () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant("readiness");
  });

  afterAll(async () => {
    await destroyTenant(tenant);
  });

  it("reports a bare install as needing the connection", async () => {
    const readiness = await getReadiness(tenant.principal);

    expect(componentOf(readiness, "metakocka").status).toBe("needs_attention");
    expect(componentOf(readiness, "warehouses").status).toBe("needs_attention");
    expect(readiness.activated).toBe(false);
  });

  it("reports a fully configured shop as ready before it is ever activated", async () => {
    await prisma.metakockaCredential.create({
      data: {
        shopId: tenant.shopId,
        companyId: "6789",
        // Never decrypted by readiness: it only asks whether a row exists and
        // when it last worked.
        secretKeyEncrypted: "not-a-real-key",
        lastVerifiedAt: new Date(),
      },
    });
    await prisma.supplySource.update({
      where: { id: tenant.supplySourceId },
      data: {
        shopifyLocationId: "gid://shopify/Location/1",
        stockDirection: "mk_to_shopify",
        inventoryWriter: "metakocka",
      },
    });
    await prisma.paymentSetting.create({
      data: { shopId: tenant.shopId, fallbackPaymentType: "Kartica" },
    });

    const readiness = await getReadiness(tenant.principal);

    expect(readiness.overall).toBe("ready");
    expect(componentOf(readiness, "orders").summary).toBe("Automatic");
    // Configuration and activation are separate answers, and this shop has
    // only the first of them.
    expect(readiness.activated).toBe(false);
  });
});
