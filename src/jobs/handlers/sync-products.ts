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

  let renamed = 0;
  let created = 0;
  let repriced = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;
  /** SKUs the merchant asked to price but Shopify has no price for. */
  let missingPrice = 0;
  /** SKUs whose price cannot be restated on the pricelist's basis. */
  let unpriceable = 0;

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

  // Indexed rather than for-of: a SKU that discovers the pricelist basis is
  // pushed back on, and the loop has to see it.
  const queue = [...variants];

  for (let index = 0; index < queue.length; index += 1) {
    const variant = queue[index]!;
    const { name } = nameFor(naming, variant);
    const existing = mkByCode.get(variant.sku);

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

        if (!nextName && !price) {
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
          price,
        });

        if (nextName) renamed += 1;
        if (price) repriced += 1;
        continue;
      }

      if (!settings.createMissing) {
        skipped += 1;
        continue;
      }

      const price: PriceInput | null = priceFor(variant.price);

      const result = await addProduct(client, {
        countCode: variant.sku,
        code: variant.sku,
        name,
        barcode: variant.barcode,
        unit: settings.unit,
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

      failed += 1;
      log.error(
        {
          shop: shopDomain,
          sku: variant.sku,
          reason:
            error instanceof MetakockaError ? error.message : String(error),
        },
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

  await appendEvent(principal, {
    entityType: "product_sync",
    event: "products.synced",
    detail: {
      renamed,
      created,
      repriced,
      unchanged,
      skipped,
      failed,
      missingPrice,
      unpriceable,
      pricelistIncludesTax,
      basisCorrected,
    },
  });

  log.info(
    {
      shop: shopDomain,
      renamed,
      created,
      repriced,
      unchanged,
      skipped,
      failed,
      missingPrice,
    },
    "Product sync finished",
  );
}
