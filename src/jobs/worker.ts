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
import { handleShopRedact } from "~/jobs/handlers/shop-redact";
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
