import { prisma } from "~/adapters/db/client.server";
import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { metafieldsFrom } from "~/adapters/db/repositories/catalogue.server";
import type { AttributeSchema } from "~/domain/attributes/types";
import type { RigSnapshotProduct } from "~/domain/rig/candidates";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * What the rig builder reads and writes in the database (docs/rig-builder.md
 * § Storage and privacy). Tenant-scoped at this boundary like every
 * repository: every query carries the shop.
 */

export interface RigSource {
  shopId: string;
  plan: AttributeSchema;
  products: RigSnapshotProduct[];
  /** When the catalogue was last read whole. */
  snapshotAt: Date | null;
  /** The newest row the snapshot or a webhook touched. */
  observedAt: Date | null;
  enabled: boolean;
  currency: string;
}

export async function findRigShop(
  shopDomain: string,
): Promise<{ id: string; enabled: boolean; installed: boolean } | null> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true, rigBuilderEnabled: true, installState: true },
  });
  if (!shop) return null;
  return {
    id: shop.id,
    enabled: shop.rigBuilderEnabled,
    installed: shop.installState === "installed",
  };
}

/** The shop's catalogue as rig parts will be made from it, with the plan that names their roles. */
export async function loadRigSource(principal: Principal): Promise<RigSource> {
  const domain = shopDomainOf(principal);
  const shop = await prisma.shop.findUnique({
    where: { domain },
    select: {
      id: true,
      rigBuilderEnabled: true,
      catalogueSnapshotAt: true,
      currencyCode: true,
    },
  });
  if (!shop) throw new Error(`Unknown shop ${domain}`);

  const [{ schema }, assignments, rows] = await Promise.all([
    getAttributeSchema(principal),
    prisma.productTypeAssignment.findMany({
      where: { shopId: shop.id },
      select: { productId: true, typeId: true },
    }),
    prisma.catalogProduct.findMany({
      where: { shopId: shop.id },
      select: {
        shopifyProductId: true,
        title: true,
        handle: true,
        status: true,
        productType: true,
        categoryName: true,
        imageUrl: true,
        metafields: true,
        observedAt: true,
        variants: {
          select: {
            shopifyVariantId: true,
            title: true,
            priceMinor: true,
            currency: true,
            inventoryQuantity: true,
            availableForSale: true,
            metafields: true,
            observedAt: true,
          },
        },
      },
    }),
  ]);
  const chosen = new Map(assignments.map((a) => [a.productId, a.typeId]));

  let observedAt: Date | null = null;
  const products: RigSnapshotProduct[] = rows.map((row) => {
    if (!observedAt || row.observedAt > observedAt) observedAt = row.observedAt;
    return {
      shopId: shop.id,
      productId: row.shopifyProductId,
      title: row.title,
      handle: row.handle,
      status: row.status,
      productType: row.productType,
      categoryName: row.categoryName,
      chosenTypeId: chosen.get(row.shopifyProductId) ?? null,
      imageUrl: row.imageUrl,
      metafields: metafieldsFrom(row.metafields),
      variants: row.variants.map((variant) => ({
        variantId: variant.shopifyVariantId,
        title: variant.title,
        priceMinor: variant.priceMinor,
        currency: variant.currency,
        inventoryQuantity: variant.inventoryQuantity,
        // A row read before the column existed has no answer; not available.
        availableForSale: variant.availableForSale ?? false,
        metafields: metafieldsFrom(variant.metafields),
      })),
    };
  });

  return {
    shopId: shop.id,
    plan: schema,
    products,
    snapshotAt: shop.catalogueSnapshotAt,
    observedAt,
    enabled: shop.rigBuilderEnabled,
    currency: shop.currencyCode ?? "",
  };
}

export async function setRigBuilderEnabled(
  principal: Principal,
  enabled: boolean,
): Promise<void> {
  await prisma.shop.updateMany({
    where: { domain: shopDomainOf(principal) },
    data: { rigBuilderEnabled: enabled },
  });
}

/* -------------------------------------------------------------------------- */
/* rig_request                                                                */
/* -------------------------------------------------------------------------- */

export interface RigRequestWrite {
  id: string;
  shopId: string;
  profile: Record<string, unknown>;
  variantIds: number[];
  mode: "plain" | "ai";
  ipHash: string;
  latencyMs: number;
  /** Set by the explain call. */
  explainedAt?: Date;
}

function rigRequestData(write: RigRequestWrite) {
  return {
    profile: write.profile as never,
    rigVariantIds: write.variantIds.map((id) => BigInt(id)),
    mode: write.mode,
    ipHash: write.ipHash,
    latencyMs: write.latencyMs,
    ...(write.explainedAt ? { explainedAt: write.explainedAt } : {}),
  };
}

/**
 * Stores what a build or an explain produced. A client that sends back the id
 * of an earlier request of its own (the live rig updates as answers change)
 * updates that row instead of adding one per keystroke; an id that is not this
 * shop's is the caller's cue to mint a new one (`rigRequestExists`).
 */
export async function saveRigRequest(
  write: RigRequestWrite,
  existing: boolean,
): Promise<void> {
  if (existing) {
    await prisma.rigRequest.updateMany({
      where: { id: write.id, shopId: write.shopId },
      data: rigRequestData(write),
    });
    return;
  }
  await prisma.rigRequest.create({
    data: { id: write.id, shopId: write.shopId, ...rigRequestData(write) },
  });
}

export async function rigRequestExists(
  shopId: string,
  id: string,
): Promise<boolean> {
  const row = await prisma.rigRequest.findFirst({
    where: { id, shopId },
    select: { id: true },
  });
  return row !== null;
}

/** Deletes the shop's requests created before `cutoff`; returns how many went. */
export async function purgeRigRequests(
  shopId: string,
  cutoff: Date,
): Promise<number> {
  const result = await prisma.rigRequest.deleteMany({
    where: { shopId, createdAt: { lt: cutoff } },
  });
  return result.count;
}

/** How many of the last `limit` explained requests were answered in plain mode. */
export async function recentPlainShare(
  shopId: string,
  limit = 50,
): Promise<{ plain: number; of: number }> {
  const rows = await prisma.rigRequest.findMany({
    where: { shopId, explainedAt: { not: null } },
    orderBy: { explainedAt: "desc" },
    take: limit,
    select: { mode: true },
  });
  return {
    plain: rows.filter((row) => row.mode === "plain").length,
    of: rows.length,
  };
}

/* -------------------------------------------------------------------------- */
/* ai_usage                                                                   */
/* -------------------------------------------------------------------------- */

export const RIG_PROVIDER = "claude-pool";

/** Calls to the pool today (UTC) for this shop: every spawn counts, successful or not. */
export async function poolCallsSince(
  shopId: string,
  since: Date,
): Promise<number> {
  return prisma.aiUsage.count({
    where: { shopId, provider: RIG_PROVIDER, createdAt: { gte: since } },
  });
}

export interface RigUsageWrite {
  shopId: string;
  purpose: "rig_profile" | "rig_why";
  promptVersion: string;
  locale: string;
  model: string;
  result: "ok" | "failed";
  /** The outcome: `ok`, `timeout`, `exhausted`, `error`. */
  outcome: string;
  latencyMs: number;
}

/** One `ai_usage` row for a spawn of claude-pool. Cost stays null: capacity, not euros. */
export async function recordRigUsage(write: RigUsageWrite): Promise<void> {
  await prisma.aiUsage.create({
    data: {
      shopId: write.shopId,
      provider: RIG_PROVIDER,
      purpose: write.purpose,
      promptVersion: write.promptVersion,
      sourceLocale: write.locale,
      targetLocale: write.locale,
      model: write.model,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      result: write.result,
      errorMessage: write.result === "ok" ? null : write.outcome,
      pricingVersion: null,
      estimatedCostMicros: null,
      latencyMs: write.latencyMs,
    },
  });
}
