import type { Job } from "pg-boss";

import { prisma } from "~/adapters/db/client.server";
import {
  applyProductUpdate,
  loadCatalogueFacts,
  removeCatalogueProduct,
} from "~/adapters/db/repositories/catalogue.server";
import {
  listDynamicActiveCampaigns,
  listLiveVariantsForProduct,
  recordVariantOutcome,
} from "~/adapters/db/repositories/sale-campaign.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { recordVariantEvent } from "~/adapters/sales/events.server";
import { reconcileDynamicMembership } from "~/adapters/sales/membership.server";
import { handleExternalChange } from "~/adapters/sales/writer.server";
import { webhookJobSchema } from "~/adapters/shopify/compliance-payloads";
import {
  normaliseTopic,
  parseProductDelete,
  parseProductUpdate,
} from "~/adapters/shopify/product-payload";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import { readVariantPrices } from "~/adapters/shopify/variant-prices";
import { serviceToken } from "~/domain/types";

/**
 * A product changed in Shopify (docs/sale-campaigns.md § Live product
 * changes, § Dynamic membership, § Loop prevention).
 *
 * Three things, in order:
 *
 *  1. The catalogue snapshot takes what the payload carries, so the next
 *     preview and the next membership evaluation see today's product.
 *  2. Every variant of the product that a campaign owns is compared with
 *     what the campaign wrote. Our own write echoing back matches and does
 *     nothing; anything else is an external change and goes through the
 *     campaign's base-price policy.
 *  3. Every active dynamic campaign re-evaluates this product.
 *
 * A deleted product cannot be restored: its rows are released, and the
 * snapshot forgets it.
 */
export async function handleSaleProductEvent(job: Job<unknown>): Promise<void> {
  const { shopDomain, topic, payload } = webhookJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "sale-product-event");
  const log = getLogger();
  const now = new Date();

  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });
  if (!shop) return;

  if (normaliseTopic(topic) === "products/delete") {
    const { productId } = parseProductDelete(payload);
    const owned = await listLiveVariantsForProduct(principal, productId);
    for (const row of owned) {
      await recordVariantOutcome(row.id, {
        state: "released",
        skipReason: "variant_missing",
        now,
      });
      await recordVariantEvent(
        principal,
        row.variantId,
        "sale_variant.released",
        {
          campaignId: row.campaignId,
          reason: "product_deleted",
        },
      );
    }
    await removeCatalogueProduct(principal, productId);
    log.info(
      { shop: shopDomain, productId, released: owned.length },
      "Product deleted",
    );
    return;
  }

  const update = parseProductUpdate(payload);
  const { changed } = await applyProductUpdate(principal, update, now);

  /*
   * 2. Owned variants: is the price still what the campaign wrote?
   *
   * The payload is only a hint. Webhooks arrive late and out of order, and
   * the stock sync makes Shopify send one for every quantity it moves, so a
   * payload that shows the campaign's own pair is taken as no news, and one
   * that shows anything else is confirmed with a live read before it is
   * called somebody else's change.
   */
  const owned = (
    await listLiveVariantsForProduct(principal, update.productId)
  ).filter((row) => row.state === "applied");
  const reported = new Map(update.variants.map((v) => [v.variantId, v]));
  const suspicious = owned.filter((row) => {
    const seen = reported.get(row.variantId);
    if (!seen) return false;
    return (
      seen.priceMinor !== row.salePriceMinor ||
      seen.compareAtMinor !== row.saleCompareAtMinor
    );
  });
  if (suspicious.length > 0) {
    const { admin } = await unauthenticated.admin(shopDomain);
    const live = await readVariantPrices(
      admin,
      suspicious.map((row) => row.variantId),
    );
    for (const row of suspicious) {
      const current = live.get(row.variantId);
      if (!current) continue;
      await handleExternalChange(
        admin,
        principal,
        row.campaign,
        row,
        {
          priceMinor: current.priceMinor,
          compareAtMinor: current.compareAtMinor,
        },
        now,
      );
    }
  }

  // 3. Dynamic campaigns: does this product still belong, or newly belong?
  // Only when something a rule reads has moved; a quantity change is not that.
  const dynamic = changed ? await listDynamicActiveCampaigns(principal) : [];
  if (dynamic.length > 0) {
    const facts = await loadCatalogueFacts(principal, {
      productIds: [update.productId],
    });
    for (const campaign of dynamic) {
      await reconcileDynamicMembership(
        principal,
        campaign,
        facts,
        { productIds: [update.productId] },
        now,
      );
    }
  }
}
