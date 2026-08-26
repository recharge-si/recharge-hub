import type { Job } from "pg-boss";
import { z } from "zod";

import { getLogger } from "~/adapters/observability/logger.server";
import { serviceToken } from "~/domain/types";
import { reconcileOrder } from "~/jobs/handlers/reconcile-order";

/**
 * Choosing where an order is fulfilled from (CLAUDE.md §8.2).
 *
 * **This queue is now a doorway into the reconciliation loop rather than a step
 * of its own,** and the reason is the bug that made the loop necessary.
 *
 * Allocation used to be a job: read the stock, run the pure allocator, write
 * the answer, queue one write per supply source. Every part of that is still
 * done — by `jobs/orders/allocation-planner`, inside `reconcile-order` — but it
 * can no longer be done *alone*. Two things changed underneath it:
 *
 *  - **Shopify's own fulfilment assignment is now the first authority.**
 *    Deciding warehouses without reading it would overwrite a merchant's
 *    decision with a guess from cached stock, every time anything touched the
 *    order.
 *  - **Allocating and writing have to happen under one lock.** They are two
 *    halves of one decision: an allocation written by one pass and sent by
 *    another, with a fulfilment order moving in between, is how a split order
 *    ends up with documents for three warehouses when it uses two.
 *
 * So this parses its job, hands over, and keeps the queue name alive for jobs
 * that were already in flight when the change was deployed.
 */

export const allocateOrderJobSchema = z.object({
  shopDomain: z.string().min(1),
  orderId: z.string().min(1),
});

export async function handleAllocateOrder(job: Job<unknown>): Promise<void> {
  const { shopDomain, orderId } = allocateOrderJobSchema.parse(job.data);
  const log = getLogger();

  const outcome = await reconcileOrder(
    serviceToken(shopDomain, "allocate-order"),
    orderId,
    { reason: "allocate" },
  );

  log.info(
    { shop: shopDomain, orderId, outcome: outcome.kind },
    "Allocation request reconciled",
  );
}
