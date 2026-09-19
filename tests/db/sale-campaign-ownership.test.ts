import { type Prisma } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  claimVariantBatch,
  countVariantStates,
  createCampaign,
  recordVariantOutcome,
  releaseStaleClaims,
  stageMembership,
  transitionCampaign,
  type Campaign,
} from "~/adapters/db/repositories/sale-campaign.server";
import {
  createTenant,
  describeDatabase,
  destroyTenant,
  prisma,
  type TestTenant,
} from "./harness";

/**
 * The two guarantees a sale campaign cannot demonstrate without PostgreSQL
 * (docs/sale-campaigns.md § Data model, § Idempotency):
 *
 *  - one live owner per variant, enforced by the partial unique index the
 *    migration creates by hand;
 *  - a batch claim that two workers cannot share, and a status transition
 *    that two callers cannot both make.
 */

let tenant: TestTenant;
let a: Campaign;
let b: Campaign;

/**
 * Variant ids are per test (`ns`), because the index under test is per
 * (shop, variant): a live row left by one test would rightly block the next.
 */
const variants = (n: number, ns: string) =>
  Array.from({ length: n }, (_, i) => ({
    productId: `gid://shopify/Product/${ns}-${Math.floor(i / 3) + 1}`,
    variantId: `gid://shopify/ProductVariant/${ns}-${i + 1}`,
    sku: `SKU-${ns}-${i + 1}`,
    title: `Variant ${i + 1}`,
  }));

beforeAll(async () => {
  tenant = await createTenant("sale-ownership");
  a = await createCampaign(
    tenant.principal,
    { name: "A", currency: "EUR" },
    null,
  );
  b = await createCampaign(
    tenant.principal,
    { name: "B", currency: "EUR" },
    null,
  );
});

afterAll(async () => {
  if (tenant) await destroyTenant(tenant);
  await prisma.$disconnect();
});

describeDatabase("sale campaign ownership", () => {
  it("lets two campaigns hold pending rows for one variant, but only one live row", async () => {
    await stageMembership(tenant.principal, a.id, variants(3, "ab"), "EUR");
    await stageMembership(tenant.principal, b.id, variants(3, "ab"), "EUR");

    const rowsA = await prisma.saleCampaignVariant.findMany({
      where: { campaignId: a.id },
    });
    const rowsB = await prisma.saleCampaignVariant.findMany({
      where: { campaignId: b.id },
    });
    expect(rowsA).toHaveLength(3);
    expect(rowsB).toHaveLength(3);

    // A takes the first variant live.
    await recordVariantOutcome(rowsA[0]!.id, {
      state: "applied",
      now: new Date(),
    });

    // B cannot take the same variant live: the partial unique index refuses.
    await expect(
      prisma.saleCampaignVariant.update({
        where: { id: rowsB[0]!.id },
        data: { state: "applying" },
      }),
    ).rejects.toMatchObject({
      code: "P2002",
    } satisfies Partial<Prisma.PrismaClientKnownRequestError>);

    // Once A has restored it, B may.
    await recordVariantOutcome(rowsA[0]!.id, {
      state: "restored",
      now: new Date(),
    });
    await expect(
      prisma.saleCampaignVariant.update({
        where: { id: rowsB[0]!.id },
        data: { state: "applying" },
      }),
    ).resolves.toMatchObject({ state: "applying" });
  });

  it("hands each pending row to exactly one of two concurrent claims", async () => {
    const campaign = await createCampaign(
      tenant.principal,
      { name: "C", currency: "EUR" },
      null,
    );
    await stageMembership(
      tenant.principal,
      campaign.id,
      variants(30, "c"),
      "EUR",
    );

    const [first, second] = await Promise.all([
      claimVariantBatch(campaign.id, "pending", "applying", 20),
      claimVariantBatch(campaign.id, "pending", "applying", 20),
    ]);

    const ids = [...first, ...second].map((row) => row.id);
    expect(new Set(ids).size).toBe(30);
    expect(first.length + second.length).toBe(30);
    expect(await countVariantStates(campaign.id)).toEqual({ applying: 30 });

    // A third claim finds nothing left.
    expect(
      await claimVariantBatch(campaign.id, "pending", "applying", 20),
    ).toEqual([]);
  });

  it("claims only rows carrying the release marker when asked", async () => {
    const campaign = await createCampaign(
      tenant.principal,
      { name: "D", currency: "EUR" },
      null,
    );
    await stageMembership(
      tenant.principal,
      campaign.id,
      variants(4, "d"),
      "EUR",
    );
    const rows = await prisma.saleCampaignVariant.findMany({
      where: { campaignId: campaign.id },
    });
    for (const row of rows) {
      await recordVariantOutcome(row.id, { state: "applied", now: new Date() });
    }
    await prisma.saleCampaignVariant.update({
      where: { id: rows[1]!.id },
      data: { reviewReason: "no_longer_matches" },
    });

    const claimed = await claimVariantBatch(
      campaign.id,
      "applied",
      "restoring",
      10,
      "no_longer_matches",
    );
    expect(claimed.map((row) => row.id)).toEqual([rows[1]!.id]);
  });

  it("puts back only claims older than the lease", async () => {
    const campaign = await createCampaign(
      tenant.principal,
      { name: "E", currency: "EUR" },
      null,
    );
    await stageMembership(
      tenant.principal,
      campaign.id,
      variants(2, "e"),
      "EUR",
    );
    const claimed = await claimVariantBatch(
      campaign.id,
      "pending",
      "applying",
      10,
    );
    expect(claimed).toHaveLength(2);

    // Fresh claims belong to a live job and stay.
    expect(
      await releaseStaleClaims(campaign.id, new Date(Date.now() - 60_000)),
    ).toEqual({
      applying: 0,
      restoring: 0,
    });
    // A claim older than the lease belongs to nobody.
    await prisma.$executeRawUnsafe(
      `UPDATE "sale_campaign_variant" SET updated_at = NOW() - interval '1 hour' WHERE id = $1`,
      claimed[0]!.id,
    );
    expect(
      await releaseStaleClaims(campaign.id, new Date(Date.now() - 60_000)),
    ).toEqual({
      applying: 1,
      restoring: 0,
    });
    expect(await countVariantStates(campaign.id)).toEqual({
      pending: 1,
      applying: 1,
    });
  });

  it("makes one transition when two callers race", async () => {
    const campaign = await createCampaign(
      tenant.principal,
      { name: "F", currency: "EUR" },
      null,
    );
    const now = new Date();
    const results = await Promise.all([
      transitionCampaign(tenant.principal, campaign.id, "draft", "active", now),
      transitionCampaign(tenant.principal, campaign.id, "draft", "active", now),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await transitionCampaign(
        tenant.principal,
        campaign.id,
        "draft",
        "active",
        now,
      ),
    ).toBe(false);
  });

  it("keeps a live row's snapshot when membership is staged again, and resets a settled one", async () => {
    const campaign = await createCampaign(
      tenant.principal,
      { name: "G", currency: "EUR" },
      null,
    );
    await stageMembership(
      tenant.principal,
      campaign.id,
      variants(2, "g"),
      "EUR",
    );
    const [live, settled] = await prisma.saleCampaignVariant.findMany({
      where: { campaignId: campaign.id },
      orderBy: { variantId: "asc" },
    });
    const now = new Date();
    await recordVariantOutcome(live!.id, {
      state: "applied",
      original: { priceMinor: 200_000, compareAtMinor: null },
      sale: { priceMinor: 160_000, compareAtMinor: 200_000 },
      now,
    });
    await recordVariantOutcome(settled!.id, {
      state: "restored",
      original: { priceMinor: 100_000, compareAtMinor: null },
      sale: { priceMinor: 80_000, compareAtMinor: 100_000 },
      now,
    });

    const { staged, kept } = await stageMembership(
      tenant.principal,
      campaign.id,
      variants(2, "g"),
      "EUR",
    );
    expect({ staged, kept }).toEqual({ staged: 1, kept: 1 });

    const after = await prisma.saleCampaignVariant.findMany({
      where: { campaignId: campaign.id },
      orderBy: { variantId: "asc" },
    });
    expect(after[0]).toMatchObject({
      state: "applied",
      originalPriceMinor: 200_000,
      salePriceMinor: 160_000,
    });
    expect(after[1]).toMatchObject({
      state: "pending",
      originalPriceMinor: null,
      salePriceMinor: null,
    });
  });
});
