import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  closeExceptionsFor,
  raiseException,
} from "~/adapters/db/repositories/exception.server";
import {
  applyPrimaryDocument,
  findStaleDocuments,
  getOrderForAllocation,
  replaceAllocations,
} from "~/adapters/db/repositories/order.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { getLogger } from "~/adapters/observability/logger.server";
import { allocate } from "~/domain/allocation/allocate";
import {
  DEFAULT_RULE,
  type AllocationLine,
  type SupplyLevel,
} from "~/domain/allocation/types";
import { computeDocumentShares } from "~/jobs/order-shares";
import { ensureOrderPartner } from "~/jobs/resolve-order-partner";
import { serviceToken, shopDomainOf } from "~/domain/types";

export const allocateOrderJobSchema = z.object({
  shopDomain: z.string().min(1),
  orderId: z.string().min(1),
});

/**
 * Decides where each line of an order is fulfilled from (CLAUDE.md §8.2).
 *
 * The decision itself is `domain/allocation`, which is pure. This handler is
 * only the plumbing around it: read the lines, read the stock, hand both to the
 * allocator, write the answer down, and queue the writes that follow. Keeping
 * the decision on the other side of that line is what makes it testable in
 * milliseconds rather than against a database.
 *
 * A line nothing can fill is not guessed at. It is allocated as far as it goes,
 * the remainder is recorded as `manual`, and an exception goes into the queue
 * with the SKU and the shortfall in it (§8.2, §11).
 */
export async function handleAllocateOrder(job: Job<unknown>): Promise<void> {
  const { shopDomain, orderId } = allocateOrderJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "allocate-order");
  const log = getLogger();

  const order = await getOrderForAllocation(principal, orderId);
  if (!order) {
    log.warn({ shop: shopDomain, orderId }, "Order vanished before allocation");
    return;
  }

  /*
   * A person has already decided where this order comes from.
   *
   * Allocation replaces the whole set every time it runs, and it runs for
   * reasons that have nothing to do with the merchant — a stock sync, a
   * re-check, an order update. Without this, a source chosen by hand survives
   * until the next one of those and then silently reverts, which is worse than
   * not offering the choice at all. Allocating again from the order page clears
   * the lock on purpose.
   */
  if (order.allocationLockedAt) {
    log.info(
      { shop: shopDomain, orderId },
      "Allocation left alone: the supply sources were chosen by hand",
    );

    for (const sourceId of [
      ...new Set(
        order.lines.flatMap((line) =>
          line.allocations
            .map((allocation) => allocation.supplySourceId)
            .filter((id): id is string => id !== null),
        ),
      ),
    ]) {
      await enqueue(
        QUEUES.writeMetakockaOrder,
        { shopDomain, orderId, supplySourceId: sourceId },
        { singletonKey: `mk:${orderId}:${sourceId}:locked:${Date.now()}` },
      );
    }
    return;
  }

  const lines: AllocationLine[] = order.lines.map((line) => ({
    lineId: line.id,
    sku: line.sku,
    quantity: line.quantity,
  }));

  const skus = [...new Set(lines.map((line) => line.sku).filter(Boolean))];

  // Stock as this app last observed it, per source and SKU. `supply_level` is
  // what the inventory sync maintains; reading MetaKocka here instead would put
  // a call that can take tens of seconds inside an allocation (§2.5, §3).
  const levels = await prisma.supplyLevel.findMany({
    where: {
      sku: { sku: { in: skus }, shop: { domain: shopDomainOf(principal) } },
      supplySource: { enabled: true },
    },
    include: { supplySource: true, sku: true },
  });

  const supply: SupplyLevel[] = levels.map((level) => ({
    sourceId: level.supplySourceId,
    sourceCode: level.supplySource.code,
    sku: level.sku.sku,
    // What is free to sell, not what is physically there: stock already claimed
    // by another order is not ours to promise.
    available: Math.max(0, level.quantity - level.reserved),
    kind: level.supplySource.kind,
    priority: level.supplySource.priority,
    canSplit: level.supplySource.canSplit,
    enabled: level.supplySource.enabled,
  }));

  const result = allocate({
    lines,
    supply,
    rules: [DEFAULT_RULE],
    // Injected rather than read inside the domain (§5).
    now: new Date(),
  });

  const hasShortfall = result.shortfalls.length > 0;

  await replaceAllocations(
    principal,
    orderId,
    result.allocations.map((allocation) => ({
      orderLineId: allocation.lineId,
      supplySourceId: allocation.sourceId,
      quantity: allocation.quantity,
      reason: allocation.reason,
    })),
    hasShortfall ? "needs_attention" : "allocated",
  );

  await appendEvent(principal, {
    entityType: "order",
    entityId: orderId,
    event: "order.allocated",
    detail: {
      orderNumber: order.shopifyOrderNumber,
      allocations: result.allocations.length,
      shortfalls: result.shortfalls.length,
      sources: [
        ...new Set(
          result.allocations
            .map((allocation) => allocation.sourceId)
            .filter((id): id is string => id !== null),
        ),
      ].length,
    },
  });

  /*
   * Close what this run has just disproved.
   *
   * An exception is a condition, not an event (§11), and these two are
   * conditions this job has just re-evaluated from scratch. Leaving a "not
   * enough stock" banner up on an order every line of which is now allocated is
   * how the exceptions queue fills with things nobody needs to read — and the
   * order page shows the same red banner, so the merchant is told the order is
   * broken while looking at the proof that it is not.
   */
  if (!hasShortfall) {
    await closeExceptionsFor(principal, orderId, ["insufficient_stock"]);
  }

  // Lines with no SKU cannot reach MetaKocka at all, and that is a different
  // problem from having no stock — say which it is.
  //
  // Deliberately not closed here when they are all present: this job only knows
  // whether a line *has* a SKU, and the same exception kind also means "the
  // catalogue does not have it". The write job closes it, because a successful
  // write is the only thing that proves both.
  const namelessLines = order.lines.filter((line) => line.sku.trim() === "");
  if (namelessLines.length > 0) {
    await raiseException(principal, {
      orderId,
      kind: "sku_not_in_metakocka",
      message: `${namelessLines.length} ${namelessLines.length === 1 ? "line has" : "lines have"} no SKU, so ${namelessLines.length === 1 ? "it" : "they"} cannot be matched to a MetaKocka product. Add a SKU to the variant in Shopify, then retry this order.`,
      detail: { lines: namelessLines.map((line) => line.title) },
    });
  }

  if (hasShortfall) {
    const detail = result.shortfalls
      .map((shortfall) => `${shortfall.sku} (${shortfall.quantity})`)
      .join(", ");

    await raiseException(principal, {
      orderId,
      kind: "insufficient_stock",
      message: `No supply source has enough stock for ${detail}. Choose a source by hand, or restock and retry.`,
      detail: { shortfalls: result.shortfalls },
    });
  }

  // Everything that could be allocated still goes out. A partly satisfiable
  // order should not sit doing nothing while somebody decides about one line.
  const sourceIds = [
    ...new Set(
      result.allocations
        .map((allocation) => allocation.sourceId)
        .filter((id): id is string => id !== null),
    ),
  ];

  /*
   * A document whose source no longer has any lines.
   *
   * A quantity change can move a whole line to another warehouse, which leaves
   * the document that was written for the old one describing goods this order
   * no longer takes from there. Emptying it is not something to do
   * automatically and deleting it is forbidden outright (§8.8: it may already
   * be invoiced), so this is the one part of an edit that stays a person's job
   * — and it is named precisely rather than left to be discovered.
   */
  /*
   * Which document is primary follows the allocation, so it is settled here.
   *
   * §8.6 gives the shipping and the order-level discount to one document, and
   * `splitOrderMoney` picks it from the allocation — so the moment the
   * allocation moves, the answer moves with it. Leaving it to the write job
   * meant a document that had stopped being primary stayed flagged until
   * something happened to send it again, and an order with two primary
   * documents has the shipping on both.
   */
  await applyPrimaryDocument(
    orderId,
    (await computeDocumentShares(orderId)).find((share) => share.isPrimary)
      ?.sourceId ?? null,
  );

  const orphaned = await findStaleDocuments(orderId, sourceIds);

  if (orphaned.length > 0) {
    /*
     * Flagged, so it stops reading as a healthy document on the order page.
     *
     * The payment on it is the dangerous part: until this existed, a document
     * left behind by a re-allocation kept its payment and kept counting towards
     * the order, so a split that moved once was paid twice.
     */
    await prisma.metakockaDocument.updateMany({
      where: { id: { in: orphaned.map((document) => document.id) } },
      data: { mkStatus: "no longer allocated", isPrimary: false },
    });

    await raiseException(principal, {
      orderId,
      kind: "order_diverged",
      message: `This order no longer takes anything from ${orphaned
        .map((document) => document.supplySource?.name ?? "a supply source")
        .join(", ")}, but MetaKocka still holds ${orphaned.length === 1 ? "the document" : "documents"} ${orphaned
        .map((document) => document.countCode)
        .join(", ")} for it. Nothing was deleted — it may already be invoiced — so cancel or credit it in MetaKocka by hand, then resolve this.`,
      detail: {
        countCodes: orphaned.map((document) => document.countCode),
        paidMinor: orphaned.reduce(
          (sum, document) => sum + (document.paymentAmountMinor ?? 0),
          0,
        ),
      },
    });
  }

  if (sourceIds.length > 0) {
    // Resolved here, while one job still owns the order, so the per-source
    // document jobs cannot each create their own copy of the same customer.
    try {
      await ensureOrderPartner(principal, orderId);
    } catch (error) {
      // Not fatal: the document job resolves it too, and a MetaKocka blip
      // should not stop an allocation that is otherwise complete.
      log.warn(
        { shop: shopDomain, orderId, err: error },
        "Could not resolve the MetaKocka partner during allocation",
      );
    }

    await enqueue(
      QUEUES.writeShopifyFulfilment,
      { shopDomain, orderId },
      { singletonKey: `fulfilment:${orderId}` },
    );

    // One job per supply source: one MetaKocka document per source (§8.4),
    // because warehouse and profit centre are document-level (§3).
    for (const sourceId of sourceIds) {
      await enqueue(
        QUEUES.writeMetakockaOrder,
        { shopDomain, orderId, supplySourceId: sourceId },
        { singletonKey: `mk:${orderId}:${sourceId}` },
      );
    }
  }

  log.info(
    {
      shop: shopDomain,
      orderId,
      allocations: result.allocations.length,
      shortfalls: result.shortfalls.length,
      sources: sourceIds.length,
    },
    "Order allocated",
  );
}
