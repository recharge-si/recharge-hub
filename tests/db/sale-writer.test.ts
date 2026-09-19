import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  claimVariantBatch,
  createCampaign,
  listHeldPendingRows,
  stageMembership,
  updateCampaign,
  type Campaign,
} from "~/adapters/db/repositories/sale-campaign.server";
import {
  applyRows,
  handleExternalChange,
  resolveHeldRows,
  restoreRows,
} from "~/adapters/sales/writer.server";
import {
  createTenant,
  describeDatabase,
  destroyTenant,
  prisma,
  type TestTenant,
} from "./harness";

/**
 * The price writer against a fake Shopify and a real database
 * (docs/sale-campaigns.md § Idempotency, § Failure and recovery).
 *
 * The fake holds each variant's pair and answers the two operations the
 * writer uses — the live read and `productVariantsBulkUpdate` — so every
 * promise about snapshots, retries and restores is checked against what
 * "Shopify" actually ends up holding, not against what the code meant.
 */

interface Pair {
  price: string;
  compareAtPrice: string | null;
}

class FakeShopify {
  variants = new Map<string, Pair & { productId: string }>();
  writes: Array<{ productId: string; variants: unknown[] }> = [];
  rejectNext: string | null = null;

  set(
    variantId: string,
    productId: string,
    price: string,
    compareAtPrice: string | null,
  ) {
    this.variants.set(variantId, { productId, price, compareAtPrice });
  }

  get admin(): AdminApiContext {
    const graphql = async (
      query: string,
      options?: { variables?: Record<string, unknown> },
    ) => {
      const variables = options?.variables ?? {};
      let data: unknown;
      if (query.includes("OrchestratorVariantPrices")) {
        const ids = variables.ids as string[];
        data = {
          nodes: ids.map((id) => {
            const v = this.variants.get(id);
            return v
              ? {
                  id,
                  sku: null,
                  title: "T",
                  price: v.price,
                  compareAtPrice: v.compareAtPrice,
                  product: { id: v.productId, title: "P" },
                }
              : null;
          }),
        };
      } else if (query.includes("OrchestratorWriteVariantPrices")) {
        const productId = variables.productId as string;
        const inputs = variables.variants as Array<{
          id: string;
          price: string;
          compareAtPrice: string | null;
        }>;
        this.writes.push({ productId, variants: inputs });
        if (this.rejectNext) {
          const message = this.rejectNext;
          this.rejectNext = null;
          data = {
            productVariantsBulkUpdate: {
              productVariants: [],
              userErrors: [{ field: null, message, code: "INVALID" }],
            },
          };
        } else {
          for (const input of inputs) {
            const current = this.variants.get(input.id);
            if (current)
              this.variants.set(input.id, {
                ...current,
                price: input.price,
                compareAtPrice: input.compareAtPrice,
              });
          }
          data = {
            productVariantsBulkUpdate: {
              productVariants: inputs.map((input) => ({
                id: input.id,
                price: input.price,
                compareAtPrice: input.compareAtPrice,
              })),
              userErrors: [],
            },
          };
        }
      } else {
        throw new Error(`Unexpected query: ${query.slice(0, 60)}`);
      }
      return { json: async () => ({ data }) } as unknown as Response;
    };
    return { graphql } as unknown as AdminApiContext;
  }
}

let tenant: TestTenant;
const V1 = "gid://shopify/ProductVariant/w-1";
const V2 = "gid://shopify/ProductVariant/w-2";
const P1 = "gid://shopify/Product/w-1";

async function campaignWith(
  name: string,
  over: Partial<
    Pick<
      Campaign,
      "discountValue" | "conflictStrategy" | "basePriceChangePolicy"
    >
  > = {},
): Promise<Campaign> {
  const created = await createCampaign(
    tenant.principal,
    { name, currency: "EUR", discountType: "percentage", discountValue: 2000 },
    null,
  );
  await prisma.saleCampaign.update({
    where: { id: created.id },
    data: { status: "active", ...over },
  });
  return prisma.saleCampaign.findUniqueOrThrow({ where: { id: created.id } });
}

beforeAll(async () => {
  tenant = await createTenant("sale-writer");
});

afterAll(async () => {
  if (tenant) await destroyTenant(tenant);
  await prisma.$disconnect();
});

describeDatabase("sale writer", () => {
  it("snapshots once, writes the sale, and a retry never discounts twice", async () => {
    const shopify = new FakeShopify();
    shopify.set(V1, P1, "2199.00", null);
    const campaign = await campaignWith("Autumn");
    await stageMembership(
      tenant.principal,
      campaign.id,
      [{ productId: P1, variantId: V1, sku: null, title: "T" }],
      "EUR",
    );

    const first = await claimVariantBatch(
      campaign.id,
      "pending",
      "applying",
      10,
    );
    expect(
      await applyRows(
        shopify.admin,
        tenant.principal,
        campaign,
        first,
        new Date(),
      ),
    ).toEqual({ done: 1, failed: 0 });
    expect(shopify.variants.get(V1)).toMatchObject({
      price: "1759.20",
      compareAtPrice: "2199.00",
    });

    const row = await prisma.saleCampaignVariant.findFirstOrThrow({
      where: { campaignId: campaign.id },
    });
    expect(row).toMatchObject({
      state: "applied",
      originalPriceMinor: 219_900,
      originalCompareAtMinor: null,
      basePriceMinor: 219_900,
      salePriceMinor: 175_920,
      saleCompareAtMinor: 219_900,
    });

    // The job dies after the write and the row is claimed again: the live
    // read finds the sale already there and nothing is written or recomputed.
    await prisma.saleCampaignVariant.update({
      where: { id: row.id },
      data: { state: "applying" },
    });
    const again = await claimVariantBatch(
      campaign.id,
      "applying",
      "applying",
      10,
    );
    expect(
      await applyRows(
        shopify.admin,
        tenant.principal,
        campaign,
        again,
        new Date(),
      ),
    ).toEqual({ done: 1, failed: 0 });
    expect(shopify.writes).toHaveLength(1);
    expect(shopify.variants.get(V1)).toMatchObject({
      price: "1759.20",
      compareAtPrice: "2199.00",
    });
    expect(
      await prisma.saleCampaignVariant.findUniqueOrThrow({
        where: { id: row.id },
      }),
    ).toMatchObject({
      state: "applied",
      salePriceMinor: 175_920,
      originalPriceMinor: 219_900,
    });

    // Restore puts both values back exactly, then a second restore is a no-op.
    const restoring = await claimVariantBatch(
      campaign.id,
      "applied",
      "restoring",
      10,
    );
    expect(
      await restoreRows(
        shopify.admin,
        tenant.principal,
        campaign,
        restoring,
        new Date(),
      ),
    ).toEqual({ done: 1, failed: 0 });
    expect(shopify.variants.get(V1)).toMatchObject({
      price: "2199.00",
      compareAtPrice: null,
    });
    expect(
      await prisma.saleCampaignVariant.findUniqueOrThrow({
        where: { id: row.id },
      }),
    ).toMatchObject({ state: "restored" });
  });

  it("records Shopify's rejection per row and leaves the snapshot for the retry", async () => {
    const shopify = new FakeShopify();
    shopify.set(V2, P1, "100.00", null);
    const campaign = await campaignWith("Rejected");
    await stageMembership(
      tenant.principal,
      campaign.id,
      [{ productId: P1, variantId: V2, sku: null, title: "T" }],
      "EUR",
    );
    shopify.rejectNext = "Compare at price must be greater than price";

    const rows = await claimVariantBatch(
      campaign.id,
      "pending",
      "applying",
      10,
    );
    expect(
      await applyRows(
        shopify.admin,
        tenant.principal,
        campaign,
        rows,
        new Date(),
      ),
    ).toEqual({ done: 0, failed: 1 });
    const row = await prisma.saleCampaignVariant.findFirstOrThrow({
      where: { campaignId: campaign.id },
    });
    expect(row).toMatchObject({
      state: "failed",
      lastError: "Compare at price must be greater than price",
      originalPriceMinor: 10_000,
      salePriceMinor: 8_000,
      attempts: 1,
    });
    expect(shopify.variants.get(V2)).toMatchObject({
      price: "100.00",
      compareAtPrice: null,
    });

    // Retry: back to pending, claimed again, this time it goes through — from the recorded snapshot.
    await prisma.saleCampaignVariant.update({
      where: { id: row.id },
      data: { state: "pending" },
    });
    const retry = await claimVariantBatch(
      campaign.id,
      "pending",
      "applying",
      10,
    );
    expect(
      await applyRows(
        shopify.admin,
        tenant.principal,
        campaign,
        retry,
        new Date(),
      ),
    ).toEqual({ done: 1, failed: 0 });
    expect(shopify.variants.get(V2)).toMatchObject({
      price: "80.00",
      compareAtPrice: "100.00",
    });
  });

  it("refuses to restore over somebody else's newer price", async () => {
    const shopify = new FakeShopify();
    const V3 = "gid://shopify/ProductVariant/w-3";
    shopify.set(V3, P1, "2000.00", null);
    const campaign = await campaignWith("External");
    await stageMembership(
      tenant.principal,
      campaign.id,
      [{ productId: P1, variantId: V3, sku: null, title: "T" }],
      "EUR",
    );
    const rows = await claimVariantBatch(
      campaign.id,
      "pending",
      "applying",
      10,
    );
    await applyRows(
      shopify.admin,
      tenant.principal,
      campaign,
      rows,
      new Date(),
    );
    expect(shopify.variants.get(V3)).toMatchObject({
      price: "1600.00",
      compareAtPrice: "2000.00",
    });

    // The ERP writes its new list price straight into `price`.
    shopify.set(V3, P1, "2100.00", "2000.00");

    const restoring = await claimVariantBatch(
      campaign.id,
      "applied",
      "restoring",
      10,
    );
    expect(
      await restoreRows(
        shopify.admin,
        tenant.principal,
        campaign,
        restoring,
        new Date(),
      ),
    ).toEqual({ done: 1, failed: 0 });
    // Nothing written; the row asks a person; the ERP's price stands.
    expect(shopify.variants.get(V3)).toMatchObject({
      price: "2100.00",
      compareAtPrice: "2000.00",
    });
    const row = await prisma.saleCampaignVariant.findFirstOrThrow({
      where: { campaignId: campaign.id },
    });
    expect(row).toMatchObject({
      state: "review",
      reviewReason: "changed_before_restore",
      lastObservedPriceMinor: 210_000,
      originalPriceMinor: 200_000,
    });
    const exception = await prisma.exception.findFirst({
      where: {
        shopId: tenant.shopId,
        kind: "sale_price_conflict",
        dedupeKey: `variant:${V3}`,
      },
    });
    expect(exception?.status).toBe("open");
  });

  it("applies the base-price policy to an external change and does not loop on its own write", async () => {
    const shopify = new FakeShopify();
    const V4 = "gid://shopify/ProductVariant/w-4";
    shopify.set(V4, P1, "2000.00", null);
    const campaign = await campaignWith("Recalc", {
      basePriceChangePolicy: "recalculate",
    });
    await stageMembership(
      tenant.principal,
      campaign.id,
      [{ productId: P1, variantId: V4, sku: null, title: "T" }],
      "EUR",
    );
    const rows = await claimVariantBatch(
      campaign.id,
      "pending",
      "applying",
      10,
    );
    await applyRows(
      shopify.admin,
      tenant.principal,
      campaign,
      rows,
      new Date(),
    );

    // Our own write echoing back: nothing happens.
    const row = await prisma.saleCampaignVariant.findFirstOrThrow({
      where: { campaignId: campaign.id },
    });
    await handleExternalChange(
      shopify.admin,
      tenant.principal,
      campaign,
      row,
      { priceMinor: 160_000, compareAtMinor: 200_000 },
      new Date(),
    );
    expect(shopify.writes).toHaveLength(1);

    // The ERP raises the base to 2,100: recalculated to 1,680 with 2,100 as compare-at,
    // and 2,100 becomes what restore will put back.
    shopify.set(V4, P1, "2100.00", "2000.00");
    await handleExternalChange(
      shopify.admin,
      tenant.principal,
      campaign,
      row,
      { priceMinor: 210_000, compareAtMinor: 200_000 },
      new Date(),
    );
    expect(shopify.variants.get(V4)).toMatchObject({
      price: "1680.00",
      compareAtPrice: "2100.00",
    });
    expect(
      await prisma.saleCampaignVariant.findUniqueOrThrow({
        where: { id: row.id },
      }),
    ).toMatchObject({
      state: "applied",
      originalPriceMinor: 210_000,
      originalCompareAtMinor: null,
      basePriceMinor: 210_000,
      salePriceMinor: 168_000,
      saleCompareAtMinor: 210_000,
    });

    // Under "preserve" the sale price stays and only the compare-at follows.
    const preserving = await updateCampaign(tenant.principal, campaign.id, {
      basePriceChangePolicy: "preserve",
    });
    shopify.set(V4, P1, "2200.00", "2100.00");
    const fresh = await prisma.saleCampaignVariant.findUniqueOrThrow({
      where: { id: row.id },
    });
    await handleExternalChange(
      shopify.admin,
      tenant.principal,
      preserving!,
      fresh,
      { priceMinor: 220_000, compareAtMinor: 210_000 },
      new Date(),
    );
    expect(shopify.variants.get(V4)).toMatchObject({
      price: "1680.00",
      compareAtPrice: "2200.00",
    });
    expect(
      await prisma.saleCampaignVariant.findUniqueOrThrow({
        where: { id: row.id },
      }),
    ).toMatchObject({
      originalPriceMinor: 220_000,
      salePriceMinor: 168_000,
      saleCompareAtMinor: 220_000,
    });

    // Restore now writes the ERP's price, not the stale 2,000.
    const restoring = await claimVariantBatch(
      campaign.id,
      "applied",
      "restoring",
      10,
    );
    await restoreRows(
      shopify.admin,
      tenant.principal,
      preserving!,
      restoring,
      new Date(),
    );
    expect(shopify.variants.get(V4)).toMatchObject({
      price: "2200.00",
      compareAtPrice: null,
    });
  });

  it("skips a variant another campaign holds under 'prevent', and takes it over under 'newest'", async () => {
    const shopify = new FakeShopify();
    const V5 = "gid://shopify/ProductVariant/w-5";
    shopify.set(V5, P1, "1000.00", null);
    const holder = await campaignWith("Holder");
    await stageMembership(
      tenant.principal,
      holder.id,
      [{ productId: P1, variantId: V5, sku: null, title: "T" }],
      "EUR",
    );
    await applyRows(
      shopify.admin,
      tenant.principal,
      holder,
      await claimVariantBatch(holder.id, "pending", "applying", 10),
      new Date(),
    );
    expect(shopify.variants.get(V5)).toMatchObject({
      price: "800.00",
      compareAtPrice: "1000.00",
    });

    const cautious = await campaignWith("Cautious", { discountValue: 3000 });
    await stageMembership(
      tenant.principal,
      cautious.id,
      [{ productId: P1, variantId: V5, sku: null, title: "T" }],
      "EUR",
    );
    // The held row is not claimable while the holder has it.
    expect(
      await claimVariantBatch(cautious.id, "pending", "applying", 10),
    ).toEqual([]);
    const heldByHolder = await listHeldPendingRows(
      tenant.principal,
      cautious.id,
      10,
    );
    expect(heldByHolder).toHaveLength(1);
    expect(
      await resolveHeldRows(
        shopify.admin,
        tenant.principal,
        cautious,
        heldByHolder,
        new Date(),
      ),
    ).toEqual({ released: 0, skipped: 1 });
    expect(
      await prisma.saleCampaignVariant.findFirstOrThrow({
        where: { campaignId: cautious.id },
      }),
    ).toMatchObject({
      state: "skipped",
      skipReason: "conflict",
    });
    // Still the holder's price: nothing stacked.
    expect(shopify.variants.get(V5)).toMatchObject({
      price: "800.00",
      compareAtPrice: "1000.00",
    });

    const newest = await campaignWith("Newest", {
      discountValue: 3000,
      conflictStrategy: "newest",
    });
    await stageMembership(
      tenant.principal,
      newest.id,
      [{ productId: P1, variantId: V5, sku: null, title: "T" }],
      "EUR",
    );
    const held = await listHeldPendingRows(tenant.principal, newest.id, 10);
    expect(
      await resolveHeldRows(
        shopify.admin,
        tenant.principal,
        newest,
        held,
        new Date(),
      ),
    ).toEqual({ released: 1, skipped: 0 });
    // The holder's price is back before the challenger reads it.
    expect(shopify.variants.get(V5)).toMatchObject({
      price: "1000.00",
      compareAtPrice: null,
    });
    await applyRows(
      shopify.admin,
      tenant.principal,
      newest,
      await claimVariantBatch(newest.id, "pending", "applying", 10),
      new Date(),
    );
    // The holder was restored first, then the new sale was taken from the restored price.
    expect(shopify.variants.get(V5)).toMatchObject({
      price: "700.00",
      compareAtPrice: "1000.00",
    });
    expect(
      await prisma.saleCampaignVariant.findFirstOrThrow({
        where: { campaignId: holder.id },
      }),
    ).toMatchObject({
      state: "released",
      skipReason: `superseded:${newest.id}`,
    });
    expect(
      await prisma.saleCampaignVariant.findFirstOrThrow({
        where: { campaignId: newest.id },
      }),
    ).toMatchObject({
      state: "applied",
      originalPriceMinor: 100_000,
      originalCompareAtMinor: null,
      basePriceMinor: 100_000,
      salePriceMinor: 70_000,
    });
  });
});
