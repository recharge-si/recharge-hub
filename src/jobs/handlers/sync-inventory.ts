import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getCredential } from "~/adapters/db/repositories/metakocka-credential.server";
import {
  listCachedWarehouses,
  listSupplySources,
} from "~/adapters/db/repositories/supply-source.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import { listWarehouseStock } from "~/adapters/metakocka/stock";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  readOnHandAtLocation,
  writeOnHand,
  type OnHandWrite,
} from "~/adapters/shopify/inventory";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import { serviceToken } from "~/domain/types";

export const syncInventoryJobSchema = z.object({
  shopDomain: z.string().min(1),
});

/**
 * Publishes MetaKocka stock into Shopify (CLAUDE.md §7).
 *
 * The rules that shape this, all from §7:
 *
 *  - MetaKocka `amount` is written to Shopify `on_hand`. `available` is never
 *    written and `free_amount` is never published, because Shopify already
 *    subtracts committed and doing both would undersell the store.
 *  - Only sources whose `inventory_writer` is `metakocka` are touched. The
 *    adapter throws for anything else; this filter means we never even ask.
 *  - Write only on change, so our own `inventory_levels/update` webhooks stay
 *    rare and recognisable.
 */
export async function handleSyncInventory(job: Job<unknown>): Promise<void> {
  const { shopDomain } = syncInventoryJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "sync-inventory");
  const log = getLogger();

  const credential = await getCredential(principal);
  if (!credential) {
    log.warn({ shop: shopDomain }, "Inventory sync skipped, MetaKocka not connected");
    return;
  }

  const [sources, warehouses] = await Promise.all([
    listSupplySources(principal),
    listCachedWarehouses(principal),
  ]);

  const warehouseIdByMark = new Map(warehouses.map((w) => [w.mark, w.mkId]));

  const writable = sources.filter(
    (source) =>
      source.enabled &&
      source.inventoryWriter === "metakocka" &&
      source.metakockaWarehouse !== null &&
      source.shopifyLocationId !== null,
  );

  if (writable.length === 0) {
    log.info({ shop: shopDomain }, "Inventory sync: no writable supply sources");
    return;
  }

  const client = new MetakockaClient({
    companyId: credential.companyId,
    secretKey: credential.secretKey,
  });
  const { admin } = await unauthenticated.admin(shopDomain);

  for (const source of writable) {
    const warehouseMkId = warehouseIdByMark.get(source.metakockaWarehouse!);
    if (!warehouseMkId) {
      // The mapping points at a warehouse that is no longer in MetaKocka.
      // Skipping is right: writing the wrong stock is worse than writing none.
      log.error(
        { shop: shopDomain, source: source.code, mark: source.metakockaWarehouse },
        "Inventory sync skipped: warehouse not in the cached list",
      );
      await appendEvent(principal, {
        entityType: "supply_source",
        entityId: source.id,
        event: "inventory.sync_skipped",
        detail: { reason: "warehouse_not_found", mark: source.metakockaWarehouse },
      });
      continue;
    }

    const stock = await listWarehouseStock(client, warehouseMkId);
    const amountByCode = new Map(stock.map((row) => [row.code, row]));

    const skus = await prisma.sku.findMany({
      where: {
        shop: { domain: shopDomain },
        status: "matched",
        shopifyInventoryItemId: { not: null },
      },
    });

    const existingLevels = await prisma.supplyLevel.findMany({
      where: { supplySourceId: source.id },
    });
    const levelBySkuId = new Map(existingLevels.map((l) => [l.skuId, l]));

    const currentOnHand = await readOnHandAtLocation(
      admin,
      source.shopifyLocationId!,
    );

    const writes: OnHandWrite[] = [];
    let skipped = 0;

    for (const sku of skus) {
      const row = amountByCode.get(sku.metakockaCode ?? sku.sku);
      const level = levelBySkuId.get(sku.id);

      // A SKU with no stock row and no history at this source is not ours to
      // touch. One we have written before is zeroed, because MetaKocka saying
      // nothing is there means nothing is there.
      if (!row && !level) continue;

      const amount = Math.max(0, Math.trunc(row?.amount ?? 0));
      const reserved = Math.max(0, Math.trunc(row?.reserved ?? 0));

      await prisma.supplyLevel.upsert({
        where: {
          supplySourceId_skuId: { supplySourceId: source.id, skuId: sku.id },
        },
        create: {
          supplySourceId: source.id,
          skuId: sku.id,
          quantity: amount,
          reserved,
        },
        update: { quantity: amount, reserved, observedAt: new Date() },
      });

      const shopifyQuantity = currentOnHand.get(sku.shopifyInventoryItemId!);

      // Shopify does not know this item at this location yet; setting a
      // compareQuantity we cannot prove would be a guess.
      if (shopifyQuantity === undefined) {
        skipped += 1;
        continue;
      }

      // §7: write only on change.
      if (shopifyQuantity === amount) {
        skipped += 1;
        continue;
      }

      writes.push({
        inventoryItemId: sku.shopifyInventoryItemId!,
        locationId: source.shopifyLocationId!,
        quantity: amount,
        compareQuantity: shopifyQuantity,
      });
    }

    if (writes.length > 0) {
      await writeOnHand(admin, writes, {
        inventoryWriter: source.inventoryWriter,
        locationId: source.shopifyLocationId!,
      });

      const now = new Date();
      for (const write of writes) {
        await prisma.supplyLevel.updateMany({
          where: {
            supplySourceId: source.id,
            sku: { shopifyInventoryItemId: write.inventoryItemId },
          },
          data: { lastPushedQuantity: write.quantity, lastPushedAt: now },
        });
      }
    }

    await appendEvent(principal, {
      entityType: "supply_source",
      entityId: source.id,
      event: "inventory.synced",
      detail: {
        source: source.code,
        stockRows: stock.length,
        written: writes.length,
        unchanged: skipped,
      },
    });

    log.info(
      {
        shop: shopDomain,
        source: source.code,
        stockRows: stock.length,
        written: writes.length,
        unchanged: skipped,
      },
      "Inventory synced",
    );
  }
}
