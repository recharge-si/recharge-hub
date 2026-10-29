import { afterEach, expect, it } from "vitest";

import { prisma } from "~/adapters/db/client.server";
import {
  claimApply,
  createImport,
  discardImport,
  getImport,
  importProblems,
  latestImport,
  loadValuesProducts,
  mirrorMetafields,
  saveProgress,
  startRun,
} from "~/adapters/db/repositories/bulk-values.server";
import {
  emptyCounts,
  type ImportPlan,
  type PlannedChange,
} from "~/domain/values/import";

import {
  createTenant,
  describeDatabase,
  destroyTenant,
  type TestTenant,
} from "./harness";

/**
 * Stored previews of bulk attribute values (docs/attributes.md § Bulk
 * values): shop A cannot read, apply, discard or mirror into shop B's, a
 * preview is applied once and only while it lives, and one import is
 * applied at a time per shop.
 */

const change: PlannedChange = {
  row: 2,
  ownerId: "gid://shopify/ProductVariant/1",
  productId: "gid://shopify/Product/1",
  scope: "variant",
  attributeId: "a1",
  name: "Luff",
  namespace: "recharge",
  key: "luff_cm",
  kind: "measurement",
  shopifyType: "dimension",
  op: "set",
  value: '{"value":400,"unit":"CENTIMETERS"}',
  before: null,
  beforeCanon: "",
  afterCanon: "400",
  beforeText: "",
  afterText: "400 cm",
  defined: true,
};

function plan(overrides: Partial<ImportPlan> = {}): ImportPlan {
  return {
    fileErrors: [],
    rowsRead: 1,
    rowsMatched: 1,
    counts: { ...emptyCounts(), set: 1 },
    perAttribute: [],
    errors: [],
    errorTotal: 0,
    skipped: [],
    sample: [],
    changes: [change],
    unknownColumns: [],
    hintColumns: [],
    untyped: [],
    safeToApply: true,
    ...overrides,
  };
}

describeDatabase("stored bulk value previews", () => {
  const tenants: TestTenant[] = [];

  afterEach(async () => {
    for (const tenant of tenants.splice(0)) await destroyTenant(tenant);
  });

  async function two() {
    const a = await createTenant("values-a");
    const b = await createTenant("values-b");
    tenants.push(a, b);
    return { a, b };
  }

  it("keeps shop B out of shop A's preview", async () => {
    const { a, b } = await two();
    const id = await createImport(a.principal, {
      fileName: "a.csv",
      createdBy: null,
      plan: plan(),
    });

    expect(await getImport(a.principal, id)).toMatchObject({ id, status: "previewed", total: 1 });
    expect(await getImport(b.principal, id)).toBeNull();
    expect(await latestImport(b.principal)).toBeNull();
    expect(await importProblems(b.principal, id)).toBeNull();
    expect(await claimApply(b.principal, id, null)).toEqual({ ok: false, reason: "unknown" });
    expect(await discardImport(b.principal, id)).toBe(false);
    expect(await startRun(b.domain, id)).toBeNull();

    // Nothing of B's attempts touched A's.
    expect(await getImport(a.principal, id)).toMatchObject({ status: "previewed" });
    expect(await claimApply(a.principal, id, "staff:1")).toEqual({ ok: true });
  });

  it("applies a preview once, and only while it lives", async () => {
    const { a } = await two();
    const id = await createImport(a.principal, { fileName: "a.csv", createdBy: null, plan: plan() });
    expect(await claimApply(a.principal, id, null)).toEqual({ ok: true });
    expect(await claimApply(a.principal, id, null)).toEqual({ ok: false, reason: "already" });

    const old = await createImport(a.principal, { fileName: "b.csv", createdBy: null, plan: plan() });
    await prisma.bulkValueImport.update({
      where: { id: old },
      data: { status: "previewed", expiresAt: new Date(Date.now() - 1000) },
    });
    // The first is queued, so a second cannot start either way.
    expect((await claimApply(a.principal, old, null)).ok).toBe(false);
  });

  it("refuses an expired preview, one with errors and one with nothing to write", async () => {
    const { a } = await two();
    const expired = await createImport(a.principal, { fileName: "e.csv", createdBy: null, plan: plan() });
    await prisma.bulkValueImport.update({
      where: { id: expired },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await claimApply(a.principal, expired, null)).toEqual({ ok: false, reason: "expired" });
    expect(await latestImport(a.principal)).toBeNull();

    const errors = await createImport(a.principal, {
      fileName: "x.csv",
      createdBy: null,
      plan: plan({ safeToApply: false, errorTotal: 1 }),
    });
    expect(await claimApply(a.principal, errors, null)).toEqual({ ok: false, reason: "nothing" });
  });

  it("applies one import at a time per shop", async () => {
    const { a, b } = await two();
    const first = await createImport(a.principal, { fileName: "1.csv", createdBy: null, plan: plan() });
    const second = await createImport(a.principal, { fileName: "2.csv", createdBy: null, plan: plan() });
    expect(await claimApply(a.principal, first, null)).toEqual({ ok: true });
    expect(await claimApply(a.principal, second, null)).toEqual({ ok: false, reason: "busy" });
    // Another shop is not held up by it.
    const other = await createImport(b.principal, { fileName: "3.csv", createdBy: null, plan: plan() });
    expect(await claimApply(b.principal, other, null)).toEqual({ ok: true });
  });

  it("keeps outcomes per change and counts them", async () => {
    const { a } = await two();
    const id = await createImport(a.principal, {
      fileName: "a.csv",
      createdBy: null,
      plan: plan({ changes: [change, { ...change, row: 3 }] }),
    });
    await claimApply(a.principal, id, null);
    const run = await startRun(a.domain, id);
    expect(run?.outcomes).toEqual([null, null]);
    await saveProgress(a.domain, id, ["written", "changed_meanwhile"]);
    const problems = await importProblems(a.principal, id);
    expect(problems?.counts).toMatchObject({ written: 1, changedMeanwhile: 1 });
    expect(problems?.problems).toHaveLength(1);
    expect(await getImport(a.principal, id)).toMatchObject({ status: "running", done: 2 });
    // A run that is picked up again keeps what it has.
    expect((await startRun(a.domain, id))?.outcomes).toEqual(["written", "changed_meanwhile"]);
  });

  it("reads and mirrors only the shop's own catalogue", async () => {
    const { a, b } = await two();
    for (const tenant of [a, b]) {
      const product = await prisma.catalogProduct.create({
        data: {
          shopId: tenant.shopId,
          shopifyProductId: "gid://shopify/Product/1",
          title: `Product of ${tenant.domain}`,
        },
      });
      await prisma.catalogVariant.create({
        data: {
          shopId: tenant.shopId,
          productId: product.id,
          shopifyVariantId: "gid://shopify/ProductVariant/1",
          priceMinor: 100,
          currency: "EUR",
          metafields: { "recharge.luff_cm": { type: "dimension", value: "{}" } },
        },
      });
    }

    const aOnly = await loadValuesProducts(a.principal, {
      variantIds: ["gid://shopify/ProductVariant/1"],
    });
    expect(aOnly).toHaveLength(1);
    expect(aOnly[0]?.title).toBe(`Product of ${a.domain}`);

    await mirrorMetafields(a.domain, [
      {
        ownerId: "gid://shopify/ProductVariant/1",
        scope: "variant",
        name: "recharge.luff_cm",
        stored: { type: "dimension", value: '{"value":400,"unit":"CENTIMETERS"}' },
      },
    ]);
    const rows = await prisma.catalogVariant.findMany({
      where: { shopifyVariantId: "gid://shopify/ProductVariant/1", shopId: { in: [a.shopId, b.shopId] } },
      select: { shopId: true, metafields: true },
    });
    const mirrored = (shopId: string) =>
      JSON.stringify(rows.find((row) => row.shopId === shopId)?.metafields);
    expect(mirrored(a.shopId)).toContain("400");
    expect(mirrored(b.shopId)).not.toContain("400");

    await mirrorMetafields(a.domain, [
      {
        ownerId: "gid://shopify/ProductVariant/1",
        scope: "variant",
        name: "recharge.luff_cm",
        stored: null,
      },
    ]);
    const cleared = await prisma.catalogVariant.findFirst({
      where: { shopId: a.shopId },
      select: { metafields: true },
    });
    expect(cleared?.metafields).toEqual({});
  });
});
