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
import { handleDeadJob } from "~/jobs/handlers/dead-job";
import { handleCustomersRedact } from "~/jobs/handlers/customers-redact";
import { handleAllocateOrder } from "~/jobs/handlers/allocate-order";
import { handleMarkMetakockaPaid } from "~/jobs/handlers/mark-metakocka-paid";
import { handleOrdersEvent } from "~/jobs/handlers/orders-event";
import { handlePollMetakockaDocuments } from "~/jobs/handlers/poll-metakocka-documents";
import { handleRecheckExceptions } from "~/jobs/handlers/recheck-exceptions";
import { handleReconcileOrders } from "~/jobs/handlers/reconcile-orders";
import { handleSyncOrderState } from "~/jobs/handlers/sync-order-state";
import { handleReloadPaymentTypes } from "~/jobs/handlers/reload-payment-types";
import { handleReloadPricelists } from "~/jobs/handlers/reload-pricelists";
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

  // §11: a job that has run out of retries is no longer being dealt with by
  // the queue, so it stops being invisible. Metadata is needed for the queue
  // the job died in (`sourceName`) and the failure it recorded (`output`).
  await boss.work(
    QUEUES.deadJobs,
    { includeMetadata: true },
    async (jobs) => {
      for (const job of jobs) await handleDeadJob(job);
    },
  );

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
  /*
   * Payment status, edits, cancellations: everything that happens to an order
   * after it arrives (§8.7, §8.8).
   *
   * Deliberately outside the idempotency guard. The guard keys on Shopify's
   * webhook id, and this queue is also fed by the reconciler and by the order
   * page, neither of which has one. It does not need the guard either: the
   * handler compares the order against what is stored and does nothing when
   * nothing moved, so a redelivery costs one comparison.
   */
  await boss.work(QUEUES.syncOrderState, async (jobs) => {
    for (const job of jobs) await handleSyncOrderState(job);
  });
  // Not wrapped in the idempotency guard: this is also queued by the
  // reconciler and by the order page, neither of which carries a webhook id.
  // Sending a payment twice is prevented where it matters instead — by the
  // per-document claim (§8.7).
  await boss.work(QUEUES.markMetakockaPaid, async (jobs) => {
    for (const job of jobs) await handleMarkMetakockaPaid(job);
  });
  await boss.work(QUEUES.reconcileOrders, async (jobs) => {
    for (const job of jobs) await handleReconcileOrders(job);
  });
  // An exception is a condition, not an event (§11): it stops being true the
  // moment somebody fixes what it describes, and nothing announces that.
  await boss.work(QUEUES.recheckExceptions, async (jobs) => {
    for (const job of jobs) await handleRecheckExceptions(job);
  });
  await boss.work(QUEUES.pollMetakockaDocuments, async (jobs) => {
    for (const job of jobs) await handlePollMetakockaDocuments(job);
  });

  await boss.work(QUEUES.reloadWarehouses, async (jobs) => {
    for (const job of jobs) await handleReloadWarehouses(job);
  });
  await boss.work(QUEUES.reloadPaymentTypes, async (jobs) => {
    for (const job of jobs) await handleReloadPaymentTypes(job);
  });
  await boss.work(QUEUES.reloadPricelists, async (jobs) => {
    for (const job of jobs) await handleReloadPricelists(job);
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

  // One cron entry per cadence, fanned out per shop by the tick handler.
  // Everything it sends is throttled, so a slow run is never lapped.
  //
  // Stock gets its own five-minute cycle: MetaKocka's webhook gives up after
  // two retries (§3), and stock is the one figure where being behind means
  // selling something that is not there.
  await boss.schedule(QUEUES.scheduledTick, "*/5 * * * *", {
    cadence: "fast",
  });

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
