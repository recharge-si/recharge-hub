import { getEnv } from "~/adapters/config/env.server";
import { prisma } from "~/adapters/db/client.server";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  captureException,
  initSentry,
} from "~/adapters/observability/sentry.server";
import { createBoss, ensureQueues } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { makeAppUninstalledHandler } from "~/jobs/handlers/app-uninstalled";
import { handleCustomersDataRequest } from "~/jobs/handlers/customers-data-request";
import { handleCustomersRedact } from "~/jobs/handlers/customers-redact";
import { handleAllocateOrder } from "~/jobs/handlers/allocate-order";
import { handleOrdersEvent } from "~/jobs/handlers/orders-event";
import { handleReloadPaymentTypes } from "~/jobs/handlers/reload-payment-types";
import { handleReloadProfitCenters } from "~/jobs/handlers/reload-profit-centers";
import { handleReloadWarehouses } from "~/jobs/handlers/reload-warehouses";
import { handleRedactOldOrders } from "~/jobs/handlers/redact-old-orders";
import { handleScheduledTick } from "~/jobs/handlers/scheduled-tick";
import { handleWriteMetakockaOrder } from "~/jobs/handlers/write-metakocka-order";
import { handleShopRedact } from "~/jobs/handlers/shop-redact";
import { handleSyncCatalogue } from "~/jobs/handlers/sync-catalogue";
import { handleSyncInventory } from "~/jobs/handlers/sync-inventory";
import { handleSyncProducts } from "~/jobs/handlers/sync-products";
import { withIdempotency } from "~/jobs/with-idempotency";

/**
 * The worker process. Long-running sync work never runs in a request handler
 * (CLAUDE.md section 2.5); it runs here.
 */
async function main(): Promise<void> {
  getEnv();
  initSentry("worker");

  const log = getLogger();
  const boss = createBoss("worker");

  boss.on("error", (error: Error) => {
    log.error({ err: error }, "pg-boss worker error");
    captureException(error, { process: "worker" });
  });

  await boss.start();
  await ensureQueues(boss);

  // Every handler runs at most once per Shopify webhook id, however many times
  // the event is delivered (CLAUDE.md section 6, idempotency_key).
  await boss.work(
    QUEUES.appUninstalled,
    withIdempotency(QUEUES.appUninstalled, makeAppUninstalledHandler(boss)),
  );
  await boss.work(
    QUEUES.customersDataRequest,
    withIdempotency(QUEUES.customersDataRequest, handleCustomersDataRequest),
  );
  await boss.work(
    QUEUES.customersRedact,
    withIdempotency(QUEUES.customersRedact, handleCustomersRedact),
  );
  await boss.work(
    QUEUES.shopRedact,
    withIdempotency(QUEUES.shopRedact, handleShopRedact),
  );

  // Sync jobs are triggered by the merchant or by a schedule, not by a webhook,
  // so they carry no webhook id and are not wrapped in the idempotency guard.
  // Re-running one is harmless: it writes only what differs.
  await boss.work(QUEUES.syncCatalogue, async (jobs) => {
    for (const job of jobs) await handleSyncCatalogue(job);
  });
  await boss.work(QUEUES.syncInventory, async (jobs) => {
    for (const job of jobs) await handleSyncInventory(job);
  });
  await boss.work(QUEUES.syncProducts, async (jobs) => {
    for (const job of jobs) await handleSyncProducts(job);
  });
  // Order flow. Allocation is pure and cheap; the MetaKocka write is the one
  // that must never run twice, which the count_code claim guarantees (§8.4).
  await boss.work(QUEUES.allocateOrder, async (jobs) => {
    for (const job of jobs) await handleAllocateOrder(job);
  });
  await boss.work(QUEUES.writeMetakockaOrder, async (jobs) => {
    for (const job of jobs) await handleWriteMetakockaOrder(job);
  });
  await boss.work(
    QUEUES.ordersEvent,
    withIdempotency(QUEUES.ordersEvent, handleOrdersEvent),
  );

  await boss.work(QUEUES.reloadWarehouses, async (jobs) => {
    for (const job of jobs) await handleReloadWarehouses(job);
  });
  await boss.work(QUEUES.reloadPaymentTypes, async (jobs) => {
    for (const job of jobs) await handleReloadPaymentTypes(job);
  });
  await boss.work(QUEUES.reloadProfitCenters, async (jobs) => {
    for (const job of jobs) await handleReloadProfitCenters(job);
  });
  await boss.work(QUEUES.scheduledTick, async (jobs) => {
    for (const job of jobs) await handleScheduledTick(job);
  });
  await boss.work(QUEUES.redactOldOrders, async (jobs) => {
    for (const job of jobs) await handleRedactOldOrders(job);
  });

  // One cron entry, fanned out per shop by the tick handler. Everything it
  // sends is throttled, so a slow run is never lapped by the next tick.
  await boss.schedule(QUEUES.scheduledTick, "*/15 * * * *", {
    cadence: "quarter_hourly",
  });

  // Nightly work: the section 2.4 retention promise, kept at a quiet hour.
  await boss.schedule(QUEUES.scheduledTick, "20 3 * * *", {
    cadence: "nightly",
  });

  log.info({ queues: Object.values(QUEUES) }, "Worker started");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info({ signal }, "Worker shutting down");
    try {
      // Let in-flight jobs finish rather than orphaning them as active rows.
      await boss.stop({ graceful: true, close: true, timeout: 30_000 });
      await prisma.$disconnect();
    } catch (error) {
      log.error({ err: error }, "Error during worker shutdown");
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  getLogger().fatal({ err: error }, "Worker failed to start");
  captureException(error, { process: "worker" });
  process.exit(1);
});
