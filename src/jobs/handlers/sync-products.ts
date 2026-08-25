import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getCredential } from "~/adapters/db/repositories/metakocka-credential.server";
import {
  getProductSyncSetting,
  markProductSyncRun,
  savePricelistBasis,
} from "~/adapters/db/repositories/product-sync-setting.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import { MetakockaError } from "~/adapters/metakocka/errors";
import {
  addProduct,
  taxFactorFromPercent,
  updateProduct,
  type PriceInput,
  type ProductTypeFlags,
} from "~/adapters/metakocka/products";
import { minorToDecimalString } from "~/adapters/metakocka/documents";
import { listProducts } from "~/adapters/metakocka/stock";
import { toMinorUnits } from "~/adapters/metakocka/values";
import { toPriceBasis } from "~/domain/money/tax";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  getShopPricing,
  listVariantDetails,
} from "~/adapters/shopify/products";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import { pricingIsTheProblem } from "~/domain/products/pricing-failures";
import {
  nameFor,
  settingsFromTemplate,
  usesMetafields,
} from "~/domain/products/template";
import { serviceToken } from "~/domain/types";

export const syncProductsJobSchema = z.object({
  shopDomain: z.string().min(1),
});

/**
 * Pushes Shopify product names into MetaKocka, and optionally creates the
 * products that do not exist yet (CLAUDE.md §8.9).
 *
 * The rules this obeys:
 *
 *  - nothing is written unless the merchant turned it on. Every switch defaults
 *    to off, because this is the one job in the app that writes into the ERP's
 *    catalogue.
 *  - §8.9 gives Shopify the customer-facing title and nothing else, so an
 *    update sends `name` alone by default. Price is the one exception, and it
 *    takes two switches: `sendPricing` puts a price on products this app
 *    creates, and `updatePricing` — separate, and off unless the merchant says
 *    otherwise — also writes it onto products MetaKocka already holds. Without
 *    the second one the pricing setting looked broken to anyone whose
 *    catalogue already existed, because nothing was ever created.
 *  - MetaKocka has no bulk endpoint, so this is one call per product, in a
 *    background job, never in a request (§2.5).
 *  - one failed product does not stop the run. It is counted, logged, and the
 *    rest continue, because a single bad product should not block a catalogue.
 */
export async function handleSyncProducts(job: Job<unknown>): Promise<void> {
  const { shopDomain } = syncProductsJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "sync-products");
  const log = getLogger();

  const settings = await getProductSyncSetting(principal);
  if (!settings.enabled) {
    await appendEvent(principal, {
      entityType: "product_sync",
      event: "products.sync_skipped",
      detail: { reason: "disabled" },
    });
    return;
  }

  const credential = await getCredential(principal);
  if (!credential) {
    await appendEvent(principal, {
      entityType: "product_sync",
      event: "products.sync_skipped",
      detail: { reason: "not_connected" },
    });
    return;
  }

  if (settings.sendPricing && !settings.pricelistCode) {
    // A price with no pricelist to put it in cannot be sent, and guessing a
    // pricelist code would write into the wrong one (§3: they must pre-exist).
    await appendEvent(principal, {
      entityType: "product_sync",
      event: "products.sync_skipped",
      detail: { reason: "missing_pricelist_code" },
    });
    return;
  }

  const client = new MetakockaClient({
    companyId: credential.companyId,
    secretKey: credential.secretKey,
  });
  const { admin } = await unauthenticated.admin(shopDomain);

  // The naming settings the preview screen resolves against, built from the
  // stored row. Rules are not stored yet, so this is the default pattern
  // alone; when they are, only this line changes.
  const naming = settingsFromTemplate(settings.nameTemplate);

  const [variants, pricing, mkProducts] = await Promise.all([
    // Metafields are read only when a pattern uses one. They cost query points
    // on every page, and a name built without them must not pay for them.
    listVariantDetails(admin, { metafields: usesMetafields(naming) }),
    getShopPricing(admin),
    listProducts(client),
  ]);

  const mkByCode = new Map(
    mkProducts.map((product) => [product.code, product]),
  );
  const taxFactor = taxFactorFromPercent(settings.taxPercent);

  /**
   * What kind of article the merchant says these are: Prodajni, Nabavni,
   * Storitev. One answer for the whole catalogue, because it is a property of
   * how this shop sells rather than of one SKU.
   */
  const wantedType: ProductTypeFlags = {
    sales: settings.productSales,
    purchasing: settings.productPurchasing,
    service: settings.productService,
  };

  /**
   * Whether an article MetaKocka already holds needs its flags rewritten.
   *
   * A null current type means `product_list` did not say, so it is sent rather
   * than assumed to match — assuming would leave the setting doing nothing for
   * anyone whose catalogue answers differently.
   */
  const typeDiffers = (current: ProductTypeFlags | null): boolean =>
    current === null ||
    current.sales !== wantedType.sales ||
    current.purchasing !== wantedType.purchasing ||
    current.service !== wantedType.service;

  let renamed = 0;
  let created = 0;
  let repriced = 0;
  let retyped = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;
  /** SKUs the merchant asked to price but Shopify has no price for. */
  let missingPrice = 0;
  /** SKUs whose price cannot be restated on the pricelist's basis. */
  let unpriceable = 0;

  /**
   * What MetaKocka said, and how many products it said it about.
   *
   * A count of failures is not a reason, and "39 products were rejected" told
   * a merchant who had just deleted their pricelists nothing they could act on.
   * MetaKocka's own words are the only description of the cause there is (§3:
   * failures are `opr_desc`, not machine-readable), so they are kept and
   * reported rather than reduced to a number.
   */
  const failureReasons = new Map<string, number>();

  /**
   * MetaKocka's words for the rejection that stopped prices going out, if one
   * did. Null while prices are still being sent.
   */
  let pricingStopped: string | null = null;

  /**
   * Whether the target pricelist holds gross prices.
   *
   * Starts from the merchant's setting and is corrected in place if MetaKocka
   * says otherwise mid-run, so one wrong answer costs one rejected call rather
   * than a whole catalogue.
   */
  let pricelistIncludesTax = settings.pricelistIncludesTax;
  let basisCorrected = false;

  const priceFor = (variantPrice: string | null): PriceInput | null => {
    if (!settings.sendPricing || !settings.pricelistCode) return null;
    // MetaKocka has already refused this pricelist once. Sending the same price
    // to it for every remaining SKU would be one rejected call per product and
    // one merchant left with a catalogue that looks entirely broken.
    if (pricingStopped !== null) return null;
    if (!variantPrice) {
      missingPrice += 1;
      return null;
    }

    // Shopify's basis and the pricelist's basis are two independent facts, and
    // when they differ the number itself has to change. Writing a 209.00 gross
    // price into a net pricelist is not a formatting problem: it is a price
    // 22% too high, which MetaKocka stores without a word.
    const restated = toPriceBasis({
      amountMinor: toMinorUnits(variantPrice),
      sourceIncludesTax: pricing.taxesIncluded,
      targetIncludesTax: pricelistIncludesTax,
      taxFactor,
    });

    if (restated.impossible) {
      // No rate to convert with, and the unconverted figure is simply wrong.
      unpriceable += 1;
      return null;
    }

    return {
      pricelistCode: settings.pricelistCode,
      price: minorToDecimalString(restated.amountMinor),
      taxIncluded: pricelistIncludesTax,
      taxFactor,
    };
  };

  /**
   * MetaKocka names the field it wanted when the basis is wrong, so a rejection
   * is worth acting on rather than only reporting: flip, remember, carry on.
   * The merchant is told through the event log rather than left to discover
   * that their setting was quietly overruled.
   */
  const isPriceBasisRejection = (error: unknown): boolean =>
    error instanceof MetakockaError &&
    /price type|price_with_tax|use 'price'/i.test(error.oprDesc ?? "");

  /** MetaKocka's own words for a failure, or ours when it never answered. */
  const reasonFor = (error: unknown): string =>
    error instanceof MetakockaError
      ? error.oprDesc?.trim() || error.message
      : error instanceof Error
        ? error.message
        : String(error);

  /** The last rejection seen on a priced write, and how often in a row. */
  let priceFailureReason: string | null = null;
  let priceFailureRun = 0;

  // Indexed rather than for-of: a SKU that discovers the pricelist basis is
  // pushed back on, and the loop has to see it.
  const queue = [...variants];

  for (let index = 0; index < queue.length; index += 1) {
    const variant = queue[index]!;
    const { name } = nameFor(naming, variant);
    const existing = mkByCode.get(variant.sku);

    /** Whether the call that is about to go out carries a price. */
    let carriedPrice = false;

    try {
      if (existing) {
        const hasName = (existing.name ?? "").trim() !== "";
        const nameIsFrozen =
          settings.namePolicy === "never" ||
          (settings.namePolicy === "when_empty" && hasName);

        const nextName =
          nameIsFrozen || existing.name === name ? undefined : name;

        // §8.9 makes MetaKocka master for price, so a product it already holds
        // is only repriced when the merchant turned that on by name. Without
        // this the pricing switch did nothing at all for an existing
        // catalogue — the price only ever went out on creation.
        const price = settings.updatePricing ? priceFor(variant.price) : null;
        carriedPrice = price !== null;

        // Same reasoning as the price above: §8.9 makes MetaKocka master for
        // its own catalogue, so an article it already holds is only retyped
        // when the merchant turned that on by name. Sent only when it would
        // actually change something — a needless flag write on every run risks
        // MetaKocka's service-change warning for nothing.
        const nextType =
          settings.updateProductType && typeDiffers(existing.type)
            ? wantedType
            : null;

        if (!nextName && !price && !nextType) {
          // Nothing to send. Distinguish "the merchant froze the name" from
          // "the name already matches", because they mean different things on
          // the settings screen.
          if (nameIsFrozen && !settings.updatePricing) skipped += 1;
          else unchanged += 1;
          continue;
        }

        await updateProduct(client, {
          mkId: existing.mkId,
          ...(nextName ? { name: nextName } : {}),
          ...(nextType ? { type: nextType } : {}),
          price,
        });

        if (nextName) renamed += 1;
        if (price) repriced += 1;
        if (nextType) retyped += 1;
        continue;
      }

      if (!settings.createMissing) {
        skipped += 1;
        continue;
      }

      const price: PriceInput | null = priceFor(variant.price);
      carriedPrice = price !== null;

      const result = await addProduct(client, {
        countCode: variant.sku,
        code: variant.sku,
        name,
        barcode: variant.barcode,
        unit: settings.unit,
        type: wantedType,
        price,
      });
      created += 1;

      // The product exists now, so the registry should say so rather than
      // waiting for the next catalogue read.
      await prisma.sku.updateMany({
        where: { sku: variant.sku, shop: { domain: shopDomain } },
        data: {
          metakockaCode: variant.sku,
          metakockaMkId: result.mkId,
          status: "matched",
        },
      });
    } catch (error) {
      if (isPriceBasisRejection(error) && !basisCorrected) {
        // MetaKocka has told us what the pricelist actually is. Believe it,
        // remember it, and let the loop retry this SKU on the next pass.
        pricelistIncludesTax = !pricelistIncludesTax;
        basisCorrected = true;
        queue.push(variant);
        continue;
      }

      const reason = reasonFor(error);

      /*
       * A rejection that belongs to the run rather than to this product.
       *
       * Two ways to recognise one, because MetaKocka's wording is not
       * documented (§3) and neither signal is sufficient alone: it named the
       * pricelist, or it has now said the same thing about three priced
       * products in a row. Either way the price is what is wrong, so the price
       * stops going out and this SKU is put back on the queue to go out with
       * its name alone. Names keep syncing; nobody has to fix the pricelist
       * before the rest of the catalogue can be renamed.
       */
      if (carriedPrice && pricingStopped === null) {
        priceFailureRun =
          priceFailureReason === reason ? priceFailureRun + 1 : 1;
        priceFailureReason = reason;

        if (
          pricingIsTheProblem({
            description:
              error instanceof MetakockaError ? (error.oprDesc ?? null) : null,
            identicalRunLength: priceFailureRun,
          })
        ) {
          pricingStopped = reason;
          queue.push(variant);
          log.warn(
            { shop: shopDomain, sku: variant.sku, reason },
            "Stopped sending prices for the rest of this run",
          );
          continue;
        }
      } else if (!carriedPrice) {
        // A failure with no price on it says nothing about the pricelist, so
        // it must not count towards dropping prices.
        priceFailureReason = null;
        priceFailureRun = 0;
      }

      failed += 1;
      failureReasons.set(reason, (failureReasons.get(reason) ?? 0) + 1);
      log.error(
        { shop: shopDomain, sku: variant.sku, reason },
        "Product sync failed for one SKU",
      );
    }
  }

  if (basisCorrected) {
    await savePricelistBasis(principal, pricelistIncludesTax);
    await appendEvent(principal, {
      entityType: "product_sync",
      event: "product_sync.pricelist_basis_corrected",
      detail: { pricelistIncludesTax },
    });
  }

  await markProductSyncRun(principal, new Date());

  /*
   * Reasons, largest first, so the screen can lead with the one that explains
   * most of the run. Capped: the audit trail is a product feature (§6), not a
   * place to store a distinct sentence per SKU.
   */
  const reasons = [...failureReasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => ({ reason, count }));

  await appendEvent(principal, {
    entityType: "product_sync",
    event: "products.synced",
    detail: {
      renamed,
      created,
      repriced,
      retyped,
      unchanged,
      skipped,
      failed,
      missingPrice,
      unpriceable,
      pricelistIncludesTax,
      basisCorrected,
      reasons,
      pricingStopped,
      pricelistCode: settings.pricelistCode,
    },
  });

  log.info(
    {
      shop: shopDomain,
      renamed,
      created,
      repriced,
      retyped,
      unchanged,
      skipped,
      failed,
      missingPrice,
      pricingStopped,
    },
    "Product sync finished",
  );
}
