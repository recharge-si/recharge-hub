import { afterEach, expect, it } from "vitest";

import {
  purgeRigRequests,
  recentPlainShare,
  saveRigRequest,
} from "~/adapters/db/repositories/rig.server";
import { handlePurgeRigRequests } from "~/jobs/handlers/purge-rig-requests";
import type { Job } from "pg-boss";

import {
  createTenant,
  describeDatabase,
  destroyTenant,
  prisma,
  type TestTenant,
} from "./harness";

/**
 * rig_request (docs/rig-builder.md § Storage and privacy): no buyer text, no
 * customer link, purged after 90 days. Needs PostgreSQL (TEST_DATABASE_AVAILABLE=1).
 */
describeDatabase("rig_request", () => {
  const tenants: TestTenant[] = [];
  afterEach(async () => {
    for (const tenant of tenants.splice(0)) await destroyTenant(tenant);
  });

  const write = (shopId: string, id: string) => ({
    id,
    shopId,
    profile: { weightKg: 82 },
    variantIds: [45500000001, 45500000002],
    mode: "plain" as const,
    ipHash: "a".repeat(32),
    latencyMs: 12,
  });

  it("has no column that could hold the buyer's text or a customer", async () => {
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'rig_request'`;
    const names = columns.map((column) => column.column_name);
    expect(names).toEqual(
      expect.arrayContaining(["profile", "rig_variant_ids", "ip_hash"]),
    );
    expect(names.filter((name) => /text|message|customer|email/.test(name))).toEqual([]);
  });

  it("stores the variant ids as int8 and updates an existing row in place", async () => {
    const tenant = await createTenant("rig-save");
    tenants.push(tenant);
    await saveRigRequest(write(tenant.shopId, "rb_aaaaaaaaaaaaaaaaaaaaaaaa"), false);
    await saveRigRequest(
      { ...write(tenant.shopId, "rb_aaaaaaaaaaaaaaaaaaaaaaaa"), variantIds: [45500000009] },
      true,
    );
    const rows = await prisma.rigRequest.findMany({ where: { shopId: tenant.shopId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rigVariantIds).toEqual([45500000009n]);
  });

  it("purges rows older than 90 days and keeps the 89-day row", async () => {
    const tenant = await createTenant("rig-purge");
    tenants.push(tenant);
    const day = 24 * 60 * 60_000;
    for (const [id, age] of [
      ["rb_000000000000000000000089", 89],
      ["rb_000000000000000000000091", 91],
    ] as const) {
      await saveRigRequest(write(tenant.shopId, id), false);
      await prisma.rigRequest.update({
        where: { id },
        data: { createdAt: new Date(Date.now() - age * day) },
      });
    }
    await handlePurgeRigRequests({
      data: { shopDomain: tenant.domain },
    } as Job<unknown>);
    const left = await prisma.rigRequest.findMany({
      where: { shopId: tenant.shopId },
      select: { id: true },
    });
    expect(left.map((row) => row.id)).toEqual(["rb_000000000000000000000089"]);
    expect(await purgeRigRequests(tenant.shopId, new Date())).toBe(1);
  });

  it("counts plain mode over the last 50 explained requests", async () => {
    const tenant = await createTenant("rig-plain");
    tenants.push(tenant);
    await saveRigRequest(write(tenant.shopId, "rb_111111111111111111111111"), false);
    await saveRigRequest(
      { ...write(tenant.shopId, "rb_222222222222222222222222"), mode: "ai", explainedAt: new Date() },
      false,
    );
    await saveRigRequest(
      { ...write(tenant.shopId, "rb_333333333333333333333333"), explainedAt: new Date() },
      false,
    );
    expect(await recentPlainShare(tenant.shopId)).toEqual({ plain: 1, of: 2 });
  });
});
