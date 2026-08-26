import type { Job } from "pg-boss";
import { z } from "zod";

import { getLogger } from "~/adapters/observability/logger.server";
import { serviceToken } from "~/domain/types";
import { reconcileOrder } from "~/jobs/handlers/reconcile-order";

/**
 * Recording a payment against the sales orders MetaKocka holds (CLAUDE.md §8.7).
 *
 * **This queue now delegates to the reconciliation loop, and that is a
 * correctness change rather than a tidy-up.**
 *
 * What used to live here was a one-shot: when Shopify reported an order as
 * paid, send `mark_paid` once per document, guarded by a per-document claim so
 * it could never be sent twice. Every part of that was right for an order paid
 * in one go, and structurally unable to handle an order paid in two — because
 * §8.7's verified behaviour is that `mark_paid` on an update **deletes the
 * previous payment and replaces it**. A second capture sent the same way would
 * have silently erased the first, so the claim existed to make sure a second
 * one never happened, which in turn meant a second capture could never be
 * recorded at all.
 *
 * The loop turns that constraint into the mechanism. It keeps a ledger of
 * individual Shopify transactions, allocates them across the order's documents,
 * and sends each document the **whole** array it should carry — so replacement
 * converges instead of destroying: two captures are two entries, sending the
 * same ledger again changes nothing, and a receipt reallocated after a
 * warehouse move simply stops appearing on the document it left.
 *
 * The queue name stays so jobs already in flight at deployment still run, and
 * so "record the payment" remains something the exceptions page can ask for.
 */

export const markMetakockaPaidJobSchema = z.object({
  shopDomain: z.string().min(1),
  orderId: z.string().min(1),
  /**
   * When the money moved, as an older caller reported it.
   *
   * Accepted and ignored. The ledger carries each transaction's own
   * `processed_at`, which is the real answer to the same question and is right
   * for an order with more than one payment, where a single timestamp cannot be.
   */
  paidAt: z.coerce.date().optional(),
});

export async function handleMarkMetakockaPaid(job: Job<unknown>): Promise<void> {
  const { shopDomain, orderId } = markMetakockaPaidJobSchema.parse(job.data);
  const log = getLogger();

  const outcome = await reconcileOrder(
    serviceToken(shopDomain, "mark-metakocka-paid"),
    orderId,
    { reason: "payment" },
  );

  log.info(
    { shop: shopDomain, orderId, outcome: outcome.kind },
    "Payment request reconciled",
  );
}
