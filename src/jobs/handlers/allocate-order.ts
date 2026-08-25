import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { raiseException } from "~/adapters/db/repositories/exception.server";
import {
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

  // Lines with no SKU cannot reach MetaKocka at all, and that is a different
  // problem from having no stock — say which it is.
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
