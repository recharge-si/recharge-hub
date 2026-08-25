import type { Prisma } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import { enqueueInTransaction } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import type { ParsedOrder } from "~/adapters/shopify/order-payload";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * Orders, their lines, allocations and the MetaKocka documents they produce
 * (CLAUDE.md §6). Every query filters by shop here, so route and job code
 * cannot forget (§9).
 */

async function shopIdFor(principal: Principal): Promise<string> {
  const domain = shopDomainOf(principal);
  const shop = await prisma.shop.findUnique({
    where: { domain },
    select: { id: true },
  });
  if (!shop) throw new Error(`No shop record for ${domain}`);
  return shop.id;
}

/**
 * Writes an incoming order and queues its allocation **in one transaction**.
 *
 * This is the whole reason the job queue lives in Postgres (§8.1). If the row
 * and the job were written separately, a crash between them would leave either
 * an order nobody allocates or an allocation for an order that does not exist.
 * `enqueueInTransaction` puts the pg-boss insert on the same Prisma transaction,
 * so both commit or neither does.
 *
 * Returns null when the order is already known. Shopify redelivers webhooks,
 * and an order that arrives twice must not produce two sets of documents.
 */
export async function saveIncomingOrder(
  principal: Principal,
  parsed: ParsedOrder,
  rawPayload: unknown,
): Promise<{ orderId: string; created: boolean }> {
  const shopId = await shopIdFor(principal);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.order.findUnique({
      where: {
        shopId_shopifyOrderId: {
          shopId,
          shopifyOrderId: parsed.shopifyOrderId,
        },
      },
      select: { id: true },
    });
    if (existing) return { orderId: existing.id, created: false };

    // The reference every MetaKocka document from this order shares (§3:
    // `buyer_order`, which is the field that actually links siblings).
    const customerOrderRef = `SH-${parsed.orderNumber}`;

    const skus = parsed.lines.map((line) => line.sku).filter(Boolean);
    const known = await tx.sku.findMany({
      where: { shopId, sku: { in: skus } },
      select: { id: true, sku: true },
    });
    const skuIdByCode = new Map(known.map((row) => [row.sku, row.id]));

    const order = await tx.order.create({
      data: {
        shopId,
        shopifyOrderId: parsed.shopifyOrderId,
        shopifyOrderNumber: parsed.orderNumber,
        customerOrderRef,
        financialStatus: parsed.financialStatus,
        presentmentCurrency: parsed.currency,
        totalMinor: parsed.totalMinor,
        shippingMinor: parsed.shippingMinor,
        discountMinor: parsed.discountMinor,
        rawPayload: rawPayload as Prisma.InputJsonValue,
        receivedAt: new Date(),
        lines: {
          create: parsed.lines.map((line) => ({
            skuId: skuIdByCode.get(line.sku) ?? null,
            sku: line.sku,
            title: line.title,
            quantity: line.quantity,
            unitPriceWithTaxMinor: line.unitPriceWithTaxMinor,
            discountMinor: line.discountMinor,
            taxFactor: line.taxFactor,
            shopifyLineItemId: line.shopifyLineItemId,
          })),
        },
      },
      select: { id: true },
    });

    await enqueueInTransaction(
      tx,
      QUEUES.allocateOrder,
      { shopDomain: shopDomainOf(principal), orderId: order.id },
      { singletonKey: `allocate:${order.id}` },
    );

    return { orderId: order.id, created: true };
  });
}

export async function getOrderForAllocation(
  principal: Principal,
  orderId: string,
) {
  return prisma.order.findFirst({
    where: { id: orderId, shop: { domain: shopDomainOf(principal) } },
    include: {
      lines: { include: { allocations: true }, orderBy: { createdAt: "asc" } },
      documents: true,
    },
  });
}

export async function listOrders(
  principal: Principal,
  options: { limit?: number; status?: string } = {},
) {
  return prisma.order.findMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      // Deleted in Shopify: gone from this app, still in MetaKocka.
      shopifyDeletedAt: null,
      ...(options.status ? { status: options.status as never } : {}),
    },
    include: {
      lines: { include: { allocations: { include: { supplySource: true } } } },
      documents: true,
      exceptions: { where: { status: "open" } },
    },
    orderBy: { receivedAt: "desc" },
    take: options.limit ?? 50,
  });
}

export async function getOrderDetail(principal: Principal, orderId: string) {
  return prisma.order.findFirst({
    where: { id: orderId, shop: { domain: shopDomainOf(principal) } },
    include: {
      lines: {
        include: {
          allocations: { include: { supplySource: true } },
        },
        orderBy: { createdAt: "asc" },
      },
      documents: {
        include: { supplySource: true },
        orderBy: { isPrimary: "desc" },
      },
      exceptions: { orderBy: { createdAt: "desc" } },
    },
  });
}

export interface AllocationRecord {
  orderLineId: string;
  supplySourceId: string | null;
  quantity: number;
  reason: unknown;
}

/**
 * Replaces the allocations for one order.
 *
 * Replacing rather than appending is what makes re-running allocation safe: the
 * job is retryable, and a second run must leave one set of allocations, not two.
 */
export async function replaceAllocations(
  principal: Principal,
  orderId: string,
  records: AllocationRecord[],
  status: "allocated" | "needs_attention",
): Promise<void> {
  const shopDomain = shopDomainOf(principal);

  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: orderId, shop: { domain: shopDomain } },
      select: { id: true, lines: { select: { id: true } } },
    });
    if (!order) throw new Error("Order not found");

    await tx.allocation.deleteMany({
      where: { orderLineId: { in: order.lines.map((line) => line.id) } },
    });

    for (const record of records) {
      await tx.allocation.create({
        data: {
          orderLineId: record.orderLineId,
          supplySourceId: record.supplySourceId,
          quantity: record.quantity,
          status: record.supplySourceId ? "planned" : "manual",
          reason: record.reason as Prisma.InputJsonValue,
        },
      });
    }

    await tx.order.update({ where: { id: orderId }, data: { status } });
  });
}

export async function setOrderStatus(
  principal: Principal,
  orderId: string,
  status:
    "received" | "allocated" | "written" | "needs_attention" | "cancelled",
): Promise<void> {
  await prisma.order.updateMany({
    where: { id: orderId, shop: { domain: shopDomainOf(principal) } },
    data: { status },
  });
}

/**
 * Claims a `count_code` before anything is sent to MetaKocka.
 *
 * This is the duplicate guard, and it is the only one there is. §3 verified
 * that MetaKocka does not treat `count_code` as unique: re-sending one creates
 * a second document under its own numbering, which can no longer be found by
 * the code we sent. So the row is written first, and the unique index on
 * `(shop_id, count_code)` is what stops a redelivered webhook or a retried job
 * turning one Shopify order into two sales orders.
 *
 * Returns null when the code is already claimed, which the caller must treat as
 * "somebody else is doing this", not as an error.
 */
/**
 * How long a claim may sit unfinished before another job may take it over.
 *
 * Matched to the write queue's `expireInSeconds`: past that point pg-boss has
 * given up on the job, so no one is still holding the claim.
 */
const CLAIM_LEASE_MS = 5 * 60 * 1000;

export async function claimDocument(
  principal: Principal,
  input: {
    orderId: string;
    supplySourceId: string | null;
    countCode: string;
    isPrimary: boolean;
  },
): Promise<{ id: string; alreadyWritten: boolean } | null> {
  const shopId = await shopIdFor(principal);

  const existing = await prisma.metakockaDocument.findUnique({
    where: { shopId_countCode: { shopId, countCode: input.countCode } },
    select: { id: true, status: true, updatedAt: true },
  });

  if (existing) {
    // A previous attempt failed outright; let the caller try again on that row.
    if (existing.status === "failed") {
      return { id: existing.id, alreadyWritten: false };
    }

    // Written is the only status that means "MetaKocka has this". Pending means
    // a job claimed the code and never came back — it died between the claim
    // and the write — and treating that as written was a trap: the row could
    // never be retried by anything, and the order sat at "pending" for good.
    //
    // Reclaiming is safe once the lease has run out, because that is longer
    // than the queue lets a job live: by then pg-boss has abandoned it and
    // nobody is still writing.
    if (existing.status === "pending") {
      const age = Date.now() - existing.updatedAt.getTime();
      if (age > CLAIM_LEASE_MS) {
        return { id: existing.id, alreadyWritten: false };
      }
    }

    return { id: existing.id, alreadyWritten: true };
  }

  try {
    const created = await prisma.metakockaDocument.create({
      data: {
        shopId,
        orderId: input.orderId,
        supplySourceId: input.supplySourceId,
        countCode: input.countCode,
        isPrimary: input.isPrimary,
        status: "pending",
      },
      select: { id: true },
    });
    return { id: created.id, alreadyWritten: false };
  } catch {
    // Lost the race against a concurrent claim. That is the guard working.
    return null;
  }
}

export async function recordDocumentResult(
  documentId: string,
  input: {
    status: "written" | "failed";
    mkId?: string | null;
    requestBody?: unknown;
    responseBody?: unknown;
  },
): Promise<void> {
  await prisma.metakockaDocument.update({
    where: { id: documentId },
    data: {
      status: input.status,
      ...(input.mkId ? { mkId: input.mkId } : {}),
      ...(input.requestBody !== undefined
        ? { requestBody: input.requestBody as Prisma.InputJsonValue }
        : {}),
      ...(input.responseBody !== undefined
        ? { responseBody: input.responseBody as Prisma.InputJsonValue }
        : {}),
    },
  });
}

export async function markDocumentPaymentSent(
  documentId: string,
  at: Date,
): Promise<void> {
  await prisma.metakockaDocument.update({
    where: { id: documentId },
    data: { paymentMarkedAt: at },
  });
}
