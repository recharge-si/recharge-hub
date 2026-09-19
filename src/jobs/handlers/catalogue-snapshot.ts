import type { Job } from "pg-boss";
import { z } from "zod";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  getCatalogueState,
  loadCatalogueFacts,
  replaceCatalogue,
  replacePriceLists,
  setCatalogueBulkOperation,
  setShopContext,
} from "~/adapters/db/repositories/catalogue.server";
import { raiseException } from "~/adapters/db/repositories/exception.server";
import { listDynamicActiveCampaigns } from "~/adapters/db/repositories/sale-campaign.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES, catalogueSnapshotKey } from "~/adapters/queue/queues";
import { reconcileDynamicMembership } from "~/adapters/sales/membership.server";
import {
  downloadBulkResult,
  parseCatalogueJsonl,
  readBulkOperation,
  readRunningBulkOperation,
  readShopContext,
  startCatalogueRead,
} from "~/adapters/shopify/catalogue";
import { listPriceLists } from "~/adapters/shopify/price-lists";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import { serviceToken } from "~/domain/types";

export const catalogueSnapshotJobSchema = z.object({
  shopDomain: z.string().min(1),
  /** Set by the job itself when it comes back to poll. */
  poll: z.boolean().optional(),
});

/** How long to wait between polls of the bulk operation. */
const POLL_AFTER_SECONDS = 15;

/** A bulk operation older than this is treated as lost and started again. */
const BULK_TIMEOUT_MS = 6 * 60 * 60_000;

/**
 * Reads the whole catalogue into the snapshot (docs/sale-campaigns.md § Data
 * model), through a Shopify bulk operation.
 *
 * The job comes back to itself: start the operation, record its id on the
 * shop, re-enqueue with a delay, poll, and when Shopify says COMPLETED
 * download the JSONL, parse it and replace the shop's catalogue in one
 * transaction. Only one operation runs per shop at a time, which Shopify
 * enforces too; a second request while one is running simply polls that one.
 *
 * The same pass refreshes the price lists and the shop's timezone, and
 * re-evaluates every active dynamic campaign over the fresh catalogue — the
 * only way collection and metafield changes reach a campaign.
 */
export async function handleCatalogueSnapshot(
  job: Job<unknown>,
): Promise<void> {
  const { shopDomain } = catalogueSnapshotJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "catalogue-snapshot");
  const log = getLogger();
  const { admin } = await unauthenticated.admin(shopDomain);

  const state = await getCatalogueState(principal);
  let operationId = state.bulkOperationId;

  if (
    operationId &&
    state.bulkStartedAt &&
    Date.now() - state.bulkStartedAt.getTime() > BULK_TIMEOUT_MS
  ) {
    log.warn(
      { shop: shopDomain, operationId },
      "Catalogue read timed out; starting again",
    );
    operationId = null;
  }

  if (!operationId) {
    const started = await startCatalogueRead(admin);
    if (started.kind === "rejected") {
      await raiseException(principal, {
        kind: "job_failed",
        dedupeKey: "catalogue-snapshot",
        message: `Shopify would not read the catalogue: ${started.messages.join("; ")}. Sale campaigns cannot be previewed or activated until it does.`,
        detail: { messages: started.messages },
      });
      throw new Error(
        `bulkOperationRunQuery rejected: ${started.messages.join("; ")}`,
      );
    }
    if (started.kind === "already_running") {
      const running = await readRunningBulkOperation(admin);
      if (!running) {
        // Told it is running, cannot find it: try again in a while.
        await poll(shopDomain);
        return;
      }
      operationId = running.id;
    } else {
      operationId = started.id;
    }
    await setCatalogueBulkOperation(principal, {
      id: operationId,
      startedAt: new Date(),
    });
    log.info({ shop: shopDomain, operationId }, "Catalogue read started");
    await poll(shopDomain);
    return;
  }

  const operation = await readBulkOperation(admin, operationId);
  if (!operation) {
    await setCatalogueBulkOperation(principal, null);
    await poll(shopDomain);
    return;
  }

  switch (operation.status) {
    case "CREATED":
    case "RUNNING":
    case "CANCELING":
      await poll(shopDomain);
      return;
    case "COMPLETED":
      break;
    default: {
      // FAILED, CANCELED, EXPIRED: say so and let the next request start over.
      await setCatalogueBulkOperation(principal, null);
      await raiseException(principal, {
        kind: "job_failed",
        dedupeKey: "catalogue-snapshot",
        message: `The catalogue read ${operation.status.toLowerCase()} in Shopify${operation.errorCode ? ` (${operation.errorCode})` : ""}. Refresh the catalogue from a campaign to try again.`,
        detail: {
          operationId,
          status: operation.status,
          errorCode: operation.errorCode,
        },
      });
      return;
    }
  }

  if (!operation.url) {
    // Completed with nothing in it: an empty catalogue. Record that honestly.
    await replaceCatalogue(principal, [], state.currencyCode ?? "", new Date());
    return;
  }

  const [text, context, priceLists] = await Promise.all([
    downloadBulkResult(operation.url),
    readShopContext(admin),
    listPriceLists(admin),
  ]);
  const products = parseCatalogueJsonl(text);
  const now = new Date();

  await setShopContext(principal, context);
  const written = await replaceCatalogue(
    principal,
    products,
    context.currencyCode,
    now,
  );
  await replacePriceLists(principal, priceLists, now);

  await appendEvent(principal, {
    entityType: "catalogue",
    event: "catalogue.snapshot",
    detail: { ...written, priceLists: priceLists.length, operationId },
  });
  log.info({ shop: shopDomain, ...written }, "Catalogue snapshot replaced");

  // Dynamic campaigns see the whole fresh catalogue.
  const dynamic = await listDynamicActiveCampaigns(principal);
  if (dynamic.length > 0) {
    const facts = await loadCatalogueFacts(principal);
    for (const campaign of dynamic) {
      await reconcileDynamicMembership(principal, campaign, facts, "all", now);
    }
  }
}

async function poll(shopDomain: string): Promise<void> {
  await enqueue(
    QUEUES.catalogueSnapshot,
    { shopDomain, poll: true },
    {
      singletonKey: catalogueSnapshotKey(shopDomain),
      startAfterSeconds: POLL_AFTER_SECONDS,
    },
  );
}
