import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { raiseException } from "~/adapters/db/repositories/exception.server";
import { getCredential } from "~/adapters/db/repositories/metakocka-credential.server";
import { isSyncActivated } from "~/adapters/db/repositories/shop.server";
import {
  listCachedWarehouses,
  listSupplySources,
} from "~/adapters/db/repositories/supply-source.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import {
  MetakockaError,
  describeForMerchant,
} from "~/adapters/metakocka/errors";
import { listWarehouseStock } from "~/adapters/metakocka/stock";
import {
  buildCompleteStockList,
  managedAmount,
  syncStockToMetakocka,
} from "~/adapters/metakocka/sync-stock";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  activateOnHand,
  readOnHandAtLocation,
  writeOnHand,
  type OnHandActivation,
  type OnHandWrite,
} from "~/adapters/shopify/inventory";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import { serviceToken } from "~/domain/types";

export const syncInventoryJobSchema = z.object({
  shopDomain: z.string().min(1),
});

/**
 * How many consecutive failures before a person is told.
 *
 * Twelve is an hour of the five-minute cycle. Below it the exceptions queue
 * fills with things that fixed themselves before anyone read them.
 */
const FAILURES_BEFORE_EXCEPTION = 12;

function formatWhen(at: Date): string {
  return at.toISOString().slice(0, 16).replace("T", " ");
}

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
  // Stable across this job's retries, so an ambiguous Shopify timeout is
  // recognised as the same write rather than applied twice.
  const runId = job.id;
  const principal = serviceToken(shopDomain, "sync-inventory");
  const log = getLogger();

  /*
   * The activation boundary (the product UX brief, section 11).
   *
   * Guided setup saves credentials and location mappings as the merchant works
   * through it, so a shop can be connected and half-configured at the same
   * time. Publishing stock off a half-configured store writes an inventory
   * document into the merchant's ERP (section 7) against warehouse mappings
   * they have not finished choosing. Finish setup is what says "start", and it
   * enqueues the first sync itself.
   *
   * Shops that were synchronizing before this existed were back-filled by
   * `20260826080000_setup_state`, so nothing stops for them.
   */
  if (!(await isSyncActivated(principal))) {
    log.info(
      { shop: shopDomain },
      "Inventory sync skipped, setup has not been finished",
    );
    return;
  }

  const credential = await getCredential(principal);
  if (!credential) {
    log.warn(
      { shop: shopDomain },
      "Inventory sync skipped, MetaKocka not connected",
    );
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
      source.stockDirection !== "none" &&
      source.metakockaWarehouse !== null &&
      source.shopifyLocationId !== null,
  );

  if (writable.length === 0) {
    log.info(
      { shop: shopDomain },
      "Inventory sync: nothing configured to sync",
    );
    return;
  }

  const client = new MetakockaClient({
    companyId: credential.companyId,
    secretKey: credential.secretKey,
  });
  const { admin } = await unauthenticated.admin(shopDomain);

  /**
   * How this location's sync went, kept on the location itself.
   *
   * A count of consecutive failures rather than a flag, because one blip is not
   * news: the sync runs every five minutes and MetaKocka is not always up. What
   * deserves a person is a location that has been failing for an hour, and that
   * is what the threshold below means.
   */
  async function recordOutcome(
    sourceId: string,
    outcome: { ok: true } | { ok: false; error: unknown },
  ): Promise<void> {
    const now = new Date();

    if (outcome.ok) {
      await prisma.supplySource.update({
        where: { id: sourceId },
        data: {
          lastSyncAt: now,
          lastSyncOk: true,
          lastSyncMessage: null,
          syncFailures: 0,
        },
      });
      /*
       * A location that started working again has nothing left to answer for.
       *
       * Closed by hand rather than through `closeExceptionsFor`, which keys on
       * an order: this exception belongs to a location, and the detail is the
       * only thing that says which one.
       */
      await prisma.exception.updateMany({
        where: {
          shop: { domain: shopDomain },
          kind: "stock_sync_failed",
          status: "open",
          detail: { path: ["sourceId"], equals: sourceId },
        },
        data: { status: "resolved", resolvedBy: "app", resolvedAt: now },
      });
      return;
    }

    const { error } = outcome;
    const message =
      error instanceof MetakockaError
        ? describeForMerchant(error)
        : error instanceof Error
          ? error.message
          : String(error);

    const updated = await prisma.supplySource.update({
      where: { id: sourceId },
      data: {
        lastSyncAt: now,
        lastSyncOk: false,
        lastSyncMessage: message,
        syncFailures: { increment: 1 },
      },
      select: { id: true, name: true, syncFailures: true, stockDirection: true },
    });

    log.error(
      { shop: shopDomain, source: updated.name, failures: updated.syncFailures },
      "Stock sync failed for a location",
    );

    /*
     * Twelve failures is an hour of a five-minute cycle. Below that the queue
     * would fill with things that fixed themselves before anyone read them;
     * above it, the merchant is publishing stock nobody has checked since
     * breakfast and nothing has said so.
     */
    if (updated.syncFailures >= FAILURES_BEFORE_EXCEPTION) {
      await raiseException(principal, {
        kind: "stock_sync_failed",
        message: `Stock has not synced for ${updated.name} since ${formatWhen(now)} — ${updated.syncFailures} attempts have failed. ${message} ${
          updated.stockDirection === "shopify_to_mk"
            ? "Shopify's counts are not reaching MetaKocka."
            : "MetaKocka's counts are not reaching Shopify, so what the store is selling may be out of date."
        }`,
        detail: {
          // Keyed on, so the sweep can close exactly this location's exception
          // when it starts working again.
          sourceId: updated.id,
          source: updated.name,
          failures: updated.syncFailures,
          direction: updated.stockDirection,
        },
      });
    }
  }

  for (const source of writable) {
    /*
     * One location at a time, and one location's failure is its own.
     *
     * This loop used to let anything thrown escape the job. The sweep then died
     * at whichever location failed, every location behind it was skipped, and
     * pg-boss retried the whole run — so a warehouse MetaKocka was refusing
     * (verified: `sync_stock` answering `opr_code 1, "Internal server error."`
     * for nine hours) both hid every other location and re-synced the ones in
     * front of it three times a minute.
     *
     * The outcome is recorded per location either way, because "Syncing" that
     * cannot be told apart from "failing since this morning" is worse than no
     * status at all.
     */
    try {
      await syncOneSource(source);
      await recordOutcome(source.id, { ok: true });
    } catch (error) {
      await recordOutcome(source.id, { ok: false, error });
    }
  }

  /** Everything for one location. Throws; the caller records the outcome. */
  async function syncOneSource(
    source: (typeof writable)[number],
  ): Promise<void> {
    // Narrowed above, but the check does not survive into a nested function.
    if (!credential) return;

    const warehouseMkId = warehouseIdByMark.get(source.metakockaWarehouse!);
    if (!warehouseMkId) {
      // The mapping points at a warehouse that is no longer in MetaKocka.
      // Skipping is right: writing the wrong stock is worse than writing none.
      log.error(
        {
          shop: shopDomain,
          source: source.code,
          mark: source.metakockaWarehouse,
        },
        "Inventory sync skipped: warehouse not in the cached list",
      );
      await appendEvent(principal, {
        entityType: "supply_source",
        entityId: source.id,
        event: "inventory.sync_skipped",
        detail: {
          reason: "warehouse_not_found",
          mark: source.metakockaWarehouse,
        },
      });
      throw new Error(
        `MetaKocka has no warehouse with the mark "${source.metakockaWarehouse}". Reload the warehouse list and check this location's mapping.`,
      );
    }

    if (source.stockDirection === "shopify_to_mk") {
      await pushShopifyStockIntoMetakocka({
        shopDomain,
        principal,
        source,
        warehouseMkId,
        client,
        credential,
        admin,
      });
      return;
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
    // Items Shopify does not stock at this location yet. They cannot be set,
    // only activated, and skipping them would hide MetaKocka stock forever.
    const activations: OnHandActivation[] = [];
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

      // Not stocked here yet: activate it at MetaKocka's amount. `inventorySet-
      // Quantities` would reject an item with no level at the location.
      if (shopifyQuantity === undefined) {
        activations.push({
          inventoryItemId: sku.shopifyInventoryItemId!,
          locationId: source.shopifyLocationId!,
          quantity: amount,
        });
        continue;
      }

      // §7: write only on change. The write itself is unconditional, so this is
      // about keeping our own inventory_levels/update webhooks rare, not about
      // refusing to overwrite.
      if (shopifyQuantity === amount) {
        skipped += 1;
        continue;
      }

      writes.push({
        inventoryItemId: sku.shopifyInventoryItemId!,
        locationId: source.shopifyLocationId!,
        quantity: amount,
        changeFromQuantity: shopifyQuantity,
      });
    }

    if (activations.length > 0) {
      await activateOnHand(admin, activations, {
        inventoryWriter: source.inventoryWriter,
        locationId: source.shopifyLocationId!,
        runId,
      });
    }

    const pushed: OnHandActivation[] = [...activations, ...writes];

    if (writes.length > 0) {
      await writeOnHand(admin, writes, {
        inventoryWriter: source.inventoryWriter,
        locationId: source.shopifyLocationId!,
        runId,
      });
    }

    if (pushed.length > 0) {
      const now = new Date();
      for (const write of pushed) {
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
        stocked: activations.length,
        unchanged: skipped,
      },
    });

    log.info(
      {
        shop: shopDomain,
        source: source.code,
        stockRows: stock.length,
        written: writes.length,
        stocked: activations.length,
        unchanged: skipped,
      },
      "Inventory synced",
    );
  }
}

interface ReverseSyncInput {
  shopDomain: string;
  principal: ReturnType<typeof serviceToken>;
  source: {
    id: string;
    code: string;
    shopifyLocationId: string | null;
    metakockaWarehouse: string | null;
  };
  warehouseMkId: string;
  client: MetakockaClient;
  credential: {
    companyId: string;
    secretKey: string;
    apiUserEmail: string | null;
  };
  admin: Parameters<typeof readOnHandAtLocation>[0];
}

/**
 * Shopify is the truth for one warehouse: copy its on-hand into MetaKocka.
 *
 * **Only that one warehouse is written.** `sync_stock`'s documentation says
 * the total stock for all warehouses has to be sent in one request, and this
 * used to take that literally: every cached warehouse was read and echoed
 * back, so one Shopify-counted location filed an inventory document that also
 * restated every MetaKocka-counted warehouse in the company. That is the thing
 * docs/BUILD_SPEC.md §7 says this app never does — a `mk_to_shopify` warehouse
 * is the merchant's number, not ours — and “echoed unchanged” was not
 * harmless either: anything moved in the ERP between the read and the write
 * was put silently back, and while `listWarehouseStock` was returning other
 * warehouses' rows (fixed with it) the echo was not even the right numbers.
 *
 * The documented risk of leaving a warehouse out is that its stock is removed.
 * That has never been observed — the live `sync_stock` probe against the test
 * company was a single-warehouse write and no other warehouse was reported
 * lost — and if it does happen MetaKocka names it in `stock_remove_list`,
 * which the adapter treats as a failure. A bounded, announced risk on the
 * warehouses this app does not own beats a certain wrong write to them on
 * every cycle. See T-16 and T-20 in docs/project-status.md.
 *
 * Within the warehouse it does write, the list is still complete: managed
 * products take Shopify's number and every other product MetaKocka holds
 * there is echoed back verbatim, because omission removes.
 */
async function pushShopifyStockIntoMetakocka(
  input: ReverseSyncInput,
): Promise<void> {
  const log = getLogger();

  if (!input.credential.apiUserEmail) {
    log.error(
      { shop: input.shopDomain, source: input.source.code },
      "Cannot write stock to MetaKocka: no API user email configured",
    );
    await appendEvent(input.principal, {
      entityType: "supply_source",
      entityId: input.source.id,
      event: "inventory.sync_skipped",
      detail: { reason: "missing_api_user_email", source: input.source.code },
    });
    // A skip is not a success: nothing was written, and a source stuck this
    // way should count toward the failure threshold like any other, not sit
    // silently marked "ok" while nobody is told.
    throw new Error(
      "MetaKocka has no API user email configured. Add it on the Connection page.",
    );
  }

  const skus = await prisma.sku.findMany({
    where: {
      shop: { domain: input.shopDomain },
      status: "matched",
      shopifyInventoryItemId: { not: null },
    },
  });

  const onHand = await readOnHandAtLocation(
    input.admin,
    input.source.shopifyLocationId!,
  );

  const managed = new Map<string, number>();
  for (const sku of skus) {
    const quantity = onHand.get(sku.shopifyInventoryItemId!);
    if (quantity === undefined) continue;
    managed.set(sku.metakockaCode ?? sku.sku, quantity);
  }

  /*
   * This source's own warehouse, and only it.
   *
   * It is the only warehouse whose numbers can decide whether anything has to
   * be written, and on most cycles nothing has. Reading the whole company up
   * front spent one MetaKocka call per warehouse every five minutes to answer
   * a question this single call settles.
   *
   * A read that fails throws, which is the right end for a destructive write:
   * the caller's try/catch around `syncOneSource` records it as this source's
   * failure and nothing is sent.
   */
  const currentRows = await listWarehouseStock(
    input.client,
    input.warehouseMkId,
  );
  const current = new Map(currentRows.map((row) => [row.code, row.amount]));

  /*
   * Write only on change (§7's own rule for the other direction, and it binds
   * harder here: every `sync_stock` call files an inventory document in the
   * merchant's ERP — an accounting action, not a cache refresh. This ran on
   * the five-minute tick unconditionally, which is 288 stock documents a day
   * per warehouse for a store where nothing moved.)
   *
   * The unmanaged products are echoed back at MetaKocka's own values by
   * construction, so the only thing that can differ is a managed code —
   * absence from `warehouse_stock` means zero (the read is fully paginated).
   */
  let changed = false;
  for (const [code, quantity] of managed) {
    // Compared against the value that would actually be sent, not the raw
    // Shopify one: an oversold location reporting -1 against a held 0 is not
    // a change, and treating it as one files an inventory document every five
    // minutes for ever.
    if ((current.get(code) ?? 0) !== managedAmount(quantity)) {
      changed = true;
      break;
    }
  }

  if (!changed) {
    log.info(
      { shop: input.shopDomain, source: input.source.code },
      "MetaKocka stock already matches Shopify, nothing written",
    );
    return;
  }

  const lines = buildCompleteStockList({
    managed,
    current,
    warehouseId: input.warehouseMkId,
  });

  if (lines.length === 0) {
    // The adapter refuses an empty list anyway; stopping here keeps the reason
    // in the audit trail rather than as a thrown error.
    await appendEvent(input.principal, {
      entityType: "supply_source",
      entityId: input.source.id,
      event: "inventory.sync_skipped",
      detail: { reason: "nothing_to_sync", source: input.source.code },
    });
    return;
  }

  const result = await syncStockToMetakocka(
    {
      companyId: input.credential.companyId,
      secretKey: input.credential.secretKey,
      apiUserEmail: input.credential.apiUserEmail,
    },
    lines,
  );

  await appendEvent(input.principal, {
    entityType: "supply_source",
    entityId: input.source.id,
    event: "inventory.written_to_metakocka",
    detail: {
      source: input.source.code,
      warehouse: input.warehouseMkId,
      lines: result.sent,
      fromShopify: managed.size,
      preserved: result.sent - managed.size,
    },
  });

  log.info(
    {
      shop: input.shopDomain,
      source: input.source.code,
      lines: result.sent,
      fromShopify: managed.size,
    },
    "Stock written to MetaKocka from Shopify",
  );
}
