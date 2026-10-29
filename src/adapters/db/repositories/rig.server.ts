import { prisma } from "~/adapters/db/client.server";
import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { metafieldsFrom } from "~/adapters/db/repositories/catalogue.server";
import type { AttributeSchema } from "~/domain/attributes/types";
import { classifyProduct, type RigSnapshotProduct } from "~/domain/rig/candidates";
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

/** Shopify selectedOptions as stored (a list of name and value); anything else reads as none. */
function optionsFrom(raw: unknown): Array<{ name: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const { name, value } = entry as { name?: unknown; value?: unknown };
    return typeof name === "string" && typeof value === "string"
      ? [{ name, value }]
      : [];
  });
}

/** The shop catalogue as rig parts will be made from it, with the plan that names their roles. */
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

  // Two reads, so the heavy columns (metafields, variants) are read only for
  // the products the plan makes rig parts: a catalogue of 1,300 products holds
  // about 250 of them, and reading the rest took most of the 3 seconds a
  // Shopify App Proxy request cannot spare.
  const [{ schema }, assignments, light] = await Promise.all([
    getAttributeSchema(principal),
    prisma.productTypeAssignment.findMany({
      where: { shopId: shop.id },
      select: { productId: true, typeId: true },
    }),
    prisma.catalogProduct.findMany({
      where: { shopId: shop.id },
      select: {
        shopifyProductId: true,
        productType: true,
        categoryName: true,
      },
    }),
  ]);
  const chosen = new Map(assignments.map((a) => [a.productId, a.typeId]));
  const partIds = light
    .filter(
      (row) =>
        classifyProduct(schema, {
          productType: row.productType,
          categoryName: row.categoryName,
          chosenTypeId: chosen.get(row.shopifyProductId) ?? null,
        }) !== null,
    )
    .map((row) => row.shopifyProductId);
  const rows =
    partIds.length === 0
      ? []
      : await prisma.catalogProduct.findMany({
          where: { shopId: shop.id, shopifyProductId: { in: partIds } },
          select: {
            shopifyProductId: true,
            title: true,
            handle: true,
            vendor: true,
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
                options: true,
                priceMinor: true,
                currency: true,
                inventoryQuantity: true,
                availableForSale: true,
                metafields: true,
                observedAt: true,
              },
            },
          },
        });

  let observedAt: Date | null = null;
  const products: RigSnapshotProduct[] = rows.map((row) => {
    if (!observedAt || row.observedAt > observedAt) observedAt = row.observedAt;
    return {
      shopId: shop.id,
      productId: row.shopifyProductId,
      title: row.title,
      handle: row.handle,
      vendor: row.vendor,
      status: row.status,
      productType: row.productType,
      categoryName: row.categoryName,
      chosenTypeId: chosen.get(row.shopifyProductId) ?? null,
      imageUrl: row.imageUrl,
      metafields: metafieldsFrom(row.metafields),
      variants: row.variants.map((variant) => ({
        variantId: variant.shopifyVariantId,
        title: variant.title,
        options: optionsFrom(variant.options),
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
/* Home page                                                                  */
/* -------------------------------------------------------------------------- */

export const RIG_PROVIDER = "claude-pool";

export interface RigHomeFacts {
  /** Requests stored since 00:00 UTC (a build and its explain are one row). */
  buildsToday: number;
  plain: { plain: number; of: number };
  /** The last time the pool answered "every account is full". */
  lastExhaustedAt: Date | null;
}

/**
 * What the Home page's Rig builder line states, or null when the builder is
 * off (then there is no line). Reads only: `rig_request` and `ai_usage`.
 */
export async function getRigHomeFacts(
  principal: Principal,
  now: Date,
): Promise<RigHomeFacts | null> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: { id: true, rigBuilderEnabled: true },
  });
  if (!shop?.rigBuilderEnabled) return null;
  const startOfDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const [buildsToday, plain, exhausted] = await Promise.all([
    prisma.rigRequest.count({
      where: { shopId: shop.id, createdAt: { gte: startOfDay } },
    }),
    recentPlainShare(shop.id),
    prisma.aiUsage.findFirst({
      where: {
        shopId: shop.id,
        provider: RIG_PROVIDER,
        errorMessage: "exhausted",
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  return {
    buildsToday,
    plain,
    lastExhaustedAt: exhausted?.createdAt ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* ai_usage                                                                   */
/* -------------------------------------------------------------------------- */

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
