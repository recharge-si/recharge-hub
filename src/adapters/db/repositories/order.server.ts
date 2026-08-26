import type { Prisma } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import { VALIDATION_REJECTION_CODES } from "~/adapters/metakocka/errors";
import { enqueueInTransaction } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import {
  minimiseOrderPayload,
  parseOrderSafe,
  type ParsedOrder,
} from "~/adapters/shopify/order-payload";
import { partyFingerprint } from "~/domain/orders/state";
import { shopDomainOf, type Principal } from "~/domain/types";
import type { OrderSnapshot } from "~/domain/orders/types";
import type { PartnerOverride } from "~/domain/orders/partner";

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
        fulfillmentState: parsed.fulfillmentState,
        // Kept as a column rather than read from the payload on demand: the
        // §2.4 retention job redacts the payload after 90 days, and a payment
        // arriving on day 91 still has to say which gateway it came from.
        paymentGateway: parsed.gateway,
        presentmentCurrency: parsed.currency,
        totalMinor: parsed.totalMinor,
        shippingMinor: parsed.shippingMinor,
        discountMinor: parsed.discountMinor,
        // §2.4 minimisation happens here, at the one boundary every stored
        // payload passes through, rather than in each caller.
        rawPayload: minimiseOrderPayload(rawPayload) as Prisma.InputJsonValue,
        receivedAt: new Date(),
        shopifyUpdatedAt: parsed.updatedAt,
        lastSyncedAt: new Date(),
        cancelledAt: parsed.cancelledAt,
        ...(parsed.cancelledAt ? { status: "cancelled" as const } : {}),
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

    /*
     * An order that is already over is recorded, not acted on.
     *
     * This matters for the recovery path rather than for the webhook: the
     * reconciler ingests orders `orders/create` never delivered, and some of
     * them were cancelled or refunded days ago. Allocating one would end with a
     * sales order in the ERP for money that no longer exists — and §8.8 is
     * clear that undoing a MetaKocka document is never automatic, so the
     * cheapest place to not create it is here.
     *
     * An order arriving this way through `orders/create` is essentially
     * impossible, so nothing is lost by applying the same rule to both.
     */
    const settled =
      parsed.cancelledAt !== null ||
      parsed.financialStatus === "refunded" ||
      parsed.financialStatus === "voided";

    if (!settled) {
      await enqueueInTransaction(
        tx,
        QUEUES.allocateOrder,
        { shopDomain: shopDomainOf(principal), orderId: order.id },
        { singletonKey: `allocate:${order.id}` },
      );
    }

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

export interface OrderListOptions {
  limit?: number;
  skip?: number;
  status?: string;
  /**
   * Free text from the search field above the list.
   *
   * It matches what a merchant has in front of them when they come looking: the
   * order number on the Shopify order, the reference this app files against it
   * in MetaKocka, or a SKU or product name off one of its lines. There is
   * deliberately no customer name here — section 2.4 keeps personal data out of
   * our own columns and inside the raw payload the retention job redacts, so a
   * name is not ours to index.
   */
  search?: string;
}

export async function listOrders(
  principal: Principal,
  options: OrderListOptions = {},
) {
  const search = options.search?.trim();

  return prisma.order.findMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      // Deleted in Shopify: gone from this app, still in MetaKocka.
      shopifyDeletedAt: null,
      ...(options.status ? { status: options.status as never } : {}),
      ...(search
        ? {
            OR: [
              { shopifyOrderNumber: { contains: search, mode: "insensitive" } },
              { customerOrderRef: { contains: search, mode: "insensitive" } },
              {
                lines: {
                  some: { sku: { contains: search, mode: "insensitive" } },
                },
              },
              {
                lines: {
                  some: { title: { contains: search, mode: "insensitive" } },
                },
              },
            ],
          }
        : {}),
    },
    include: {
      lines: { include: { allocations: { include: { supplySource: true } } } },
      documents: true,
      exceptions: { where: { status: "open" } },
    },
    orderBy: { receivedAt: "desc" },
    skip: options.skip ?? 0,
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

/**
 * Whether a recorded failure was MetaKocka saying no.
 *
 * The write handler records what a failed attempt got back: a business
 * rejection is stored with its `oprCode`, while a timeout, a 5xx, a connection
 * reset or a crash between the call and the record has none. The distinction
 * matters because only a *validation* refusal is proof no document was created
 * — MetaKocka answered, and the answer was a rejection before anything was
 * filed. Everything else is ambiguous: a transport failure may have landed,
 * and an unrecognised code is an answer whose consequences nobody has
 * observed. §3 says re-sending the same `count_code` after a document was
 * created makes a second one, so anything short of a known refusal is resolved
 * by lookup before anything is sent again.
 */
export function isDefinitiveRejection(responseBody: unknown): boolean {
  if (responseBody === null || typeof responseBody !== "object") return false;
  const oprCode = (responseBody as { oprCode?: unknown }).oprCode;
  return typeof oprCode === "string" && VALIDATION_REJECTION_CODES.has(oprCode);
}

export interface DocumentClaim {
  id: string;
  alreadyWritten: boolean;
  /** True when this claim re-takes a row a previous attempt left behind. */
  reclaimed: boolean;
  /**
   * True when the previous attempt ended in an explicit MetaKocka rejection,
   * which is the one outcome that proves no document was created. False on a
   * fresh claim, and false when the previous failure was ambiguous — the
   * caller must then look before sending (§3, §8.4).
   */
  previousRejection: boolean;
}

export async function claimDocument(
  principal: Principal,
  input: {
    orderId: string;
    supplySourceId: string | null;
    countCode: string;
    isPrimary: boolean;
  },
): Promise<DocumentClaim | null> {
  const shopId = await shopIdFor(principal);

  const existing = await prisma.metakockaDocument.findUnique({
    where: { shopId_countCode: { shopId, countCode: input.countCode } },
    select: { id: true, status: true, updatedAt: true, responseBody: true },
  });

  if (existing) {
    // A previous attempt failed outright; let the caller try again on that
    // row. The re-claim is a conditional update, not a read followed by a
    // write: two jobs looking at the same failed row — the merchant's retry
    // beside the re-check sweep, say — must not both walk away believing they
    // hold it, because both would then call MetaKocka and §3 says that makes
    // two documents. The database settles who won; the loser is told nobody's
    // work is theirs to do.
    if (existing.status === "failed") {
      const taken = await prisma.metakockaDocument.updateMany({
        where: { id: existing.id, status: "failed" },
        data: { status: "pending" },
      });
      if (taken.count === 0) return null;

      return {
        id: existing.id,
        alreadyWritten: false,
        reclaimed: true,
        previousRejection: isDefinitiveRejection(existing.responseBody),
      };
    }

    // Written is the only status that means "MetaKocka has this". Pending means
    // a job claimed the code and never came back — it died between the claim
    // and the write — and treating that as written was a trap: the row could
    // never be retried by anything, and the order sat at "pending" for good.
    //
    // Reclaiming is safe once the lease has run out, because that is longer
    // than the queue lets a job live: by then pg-boss has abandoned it and
    // nobody is still writing. The same conditional update settles a race
    // between two would-be takers, and touching the row renews the lease so a
    // third arrival a moment later reads it as freshly held. Safe to *claim* —
    // not safe to send: the dead job may have died after its call reached
    // MetaKocka, so `previousRejection` stays false and the caller resolves by
    // lookup first.
    if (existing.status === "pending") {
      const staleBefore = new Date(Date.now() - CLAIM_LEASE_MS);
      const taken = await prisma.metakockaDocument.updateMany({
        where: {
          id: existing.id,
          status: "pending",
          updatedAt: { lt: staleBefore },
        },
        data: { status: "pending" },
      });
      if (taken.count === 1) {
        return {
          id: existing.id,
          alreadyWritten: false,
          reclaimed: true,
          previousRejection: false,
        };
      }
    }

    return {
      id: existing.id,
      alreadyWritten: true,
      reclaimed: false,
      previousRejection: false,
    };
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
    return {
      id: created.id,
      alreadyWritten: false,
      reclaimed: false,
      previousRejection: false,
    };
  } catch {
    // Lost the race against a concurrent claim. That is the guard working.
    return null;
  }
}

/**
 * Marks an order written only when every source its allocation names holds a
 * written document.
 *
 * The old check counted document *rows* that were not yet written, which reads
 * as complete the moment the last existing row succeeds — but a sibling write
 * job that died before claiming its row never created one, so a split order
 * lost half its documents and still turned green. Completeness is a claim
 * about the allocation, so it is measured against the allocation.
 */
export async function markOrderWrittenIfComplete(
  orderId: string,
): Promise<void> {
  const allocated = await prisma.allocation.findMany({
    where: { orderLine: { orderId }, supplySourceId: { not: null } },
    select: { supplySourceId: true },
    distinct: ["supplySourceId"],
  });
  if (allocated.length === 0) return;

  const written = await prisma.metakockaDocument.findMany({
    where: { orderId, status: "written" },
    select: { supplySourceId: true },
  });
  const have = new Set(written.map((doc) => doc.supplySourceId));

  const missing = allocated.some(
    (allocation) => !have.has(allocation.supplySourceId),
  );
  if (missing) return;

  await prisma.order.update({
    where: { id: orderId },
    data: { status: "written" },
  });
}

/**
 * Records the exact body about to be sent, before the call goes out.
 *
 * §8.4 says request and response are recorded regardless of outcome, and this
 * is the half that has to happen first: after a timeout the response is exactly
 * what nobody has, and the recorded request is what tells the next attempt —
 * and the drift poller (§8.11) — what MetaKocka may be holding.
 */
export async function recordDocumentRequest(
  documentId: string,
  requestBody: unknown,
): Promise<void> {
  await prisma.metakockaDocument.update({
    where: { id: documentId },
    data: { requestBody: requestBody as Prisma.InputJsonValue },
  });
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


/* -------------------------------------------------------------------------- */
/* Keeping an order in step with Shopify                                      */
/* -------------------------------------------------------------------------- */

/**
 * An order as this app currently holds it, with everything the sync path needs
 * to decide what to do about a change.
 *
 * One query rather than three, because the sync handler runs for every
 * `orders/updated` webhook — which Shopify sends when a tag is added — and the
 * common case is that nothing relevant has changed at all.
 */
export async function getOrderState(
  principal: Principal,
  shopifyOrderId: string,
) {
  return prisma.order.findFirst({
    where: {
      shopifyOrderId,
      shop: { domain: shopDomainOf(principal) },
    },
    select: {
      id: true,
      shopifyOrderNumber: true,
      customerOrderRef: true,
      status: true,
      financialStatus: true,
      fulfillmentState: true,
      presentmentCurrency: true,
      totalMinor: true,
      shippingMinor: true,
      discountMinor: true,
      cancelledAt: true,
      divergedAt: true,
      shopifyUpdatedAt: true,
      shopifyDeletedAt: true,
      redactedAt: true,
      paymentGateway: true,
      partnerOverride: true,
      receivedAt: true,
      // Read so the snapshot can tell whether the customer details moved. They
      // live nowhere else — §2.4 keeps them out of columns of our own.
      rawPayload: true,
      lines: {
        select: {
          id: true,
          shopifyLineItemId: true,
          sku: true,
          title: true,
          quantity: true,
          unitPriceWithTaxMinor: true,
          discountMinor: true,
        },
        orderBy: { createdAt: "asc" },
      },
      documents: {
        select: {
          id: true,
          countCode: true,
          status: true,
          mkId: true,
          isPrimary: true,
          paymentMarkedAt: true,
        },
      },
    },
  });
}

export type OrderState = NonNullable<Awaited<ReturnType<typeof getOrderState>>>;

/** What this app holds, in the shape `domain/orders/state` compares. */
export function snapshotOf(order: OrderState): OrderSnapshot {
  /*
   * The customer, as the payload we last stored describes them.
   *
   * Derived rather than stored: §2.4 keeps personal data out of columns of our
   * own, so the payload is the only record, and comparing it against the fresh
   * one is the only way to notice an address arriving. Past the 90-day
   * redaction there is nothing left to compare and the fingerprint is null on
   * both sides, which reads as "unchanged" — correct, because by then nothing
   * about the customer is being sent anywhere either.
   */
  const stored = parseOrderSafe(order.rawPayload);

  return {
    financialStatus: order.financialStatus,
    fulfillmentState:
      (order.fulfillmentState as OrderSnapshot["fulfillmentState"] | null) ??
      "unfulfilled",
    currency: order.presentmentCurrency,
    totalMinor: order.totalMinor,
    shippingMinor: order.shippingMinor,
    discountMinor: order.discountMinor,
    cancelled: order.cancelledAt !== null,
    party: partyFingerprint(stored?.partner ?? stored?.receiver ?? null),
    lines: order.lines.map((line) => ({
      shopifyLineItemId: line.shopifyLineItemId,
      sku: line.sku,
      title: line.title,
      quantity: line.quantity,
      unitPriceWithTaxMinor: line.unitPriceWithTaxMinor,
      discountMinor: line.discountMinor,
    })),
  };
}

export interface ApplyOrderSyncInput {
  parsed: ParsedOrder;
  rawPayload: unknown;
  /**
   * Whether the stored lines may be rewritten to match Shopify.
   *
   * False once a MetaKocka document exists. The order lines are then the record
   * of what was sent to the ERP, and overwriting them would erase the only
   * evidence of the difference the merchant is being asked to resolve
   * (`domain/orders/state`, `contentChangePolicy`).
   */
  replaceLines: boolean;
  /** Set, or cleared, alongside the exception the caller raises. */
  diverged: boolean;
  /** Left alone when absent, so a sync never overrules the allocation pipeline. */
  status?: "received" | "cancelled" | "needs_attention" | null;
  now: Date;
}

/**
 * Writes what Shopify now says about an order.
 *
 * The payload is replaced wholesale — it is Shopify's record of the order, and
 * the newest one is the true one — while the decision trail around it is
 * treated as append-only. Lines are rewritten only when nothing has been sent
 * to MetaKocka yet; allocations and documents are never touched here.
 *
 * `shopify_updated_at` is written last and read first by the caller: it is the
 * high-water mark that makes a webhook arriving out of order harmless.
 */
export async function applyOrderSync(
  principal: Principal,
  orderId: string,
  input: ApplyOrderSyncInput,
): Promise<void> {
  const { parsed } = input;
  const shopDomain = shopDomainOf(principal);

  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: orderId, shop: { domain: shopDomain } },
      select: { id: true, shopId: true, redactedAt: true },
    });
    if (!order) return;

    if (input.replaceLines) {
      const skus = parsed.lines.map((line) => line.sku).filter(Boolean);
      const known = await tx.sku.findMany({
        where: { shopId: order.shopId, sku: { in: skus } },
        select: { id: true, sku: true },
      });
      const skuIdByCode = new Map(known.map((row) => [row.sku, row.id]));

      const seen = parsed.lines.map((line) => line.shopifyLineItemId);

      /*
       * Removed in Shopify: the line goes, and its allocations with it by
       * cascade. Safe only because this branch is unreachable once a document
       * exists.
       *
       * An order with no lines at all is a parse that went wrong far more often
       * than it is a real order, and an empty list here would delete every line
       * on the order. The trail is worth more than the tidiness.
       */
      if (seen.length > 0) {
        await tx.orderLine.deleteMany({
          where: { orderId, shopifyLineItemId: { notIn: seen } },
        });
      }

      for (const line of parsed.lines) {
        const existing = await tx.orderLine.findFirst({
          where: { orderId, shopifyLineItemId: line.shopifyLineItemId },
          select: { id: true },
        });

        const data = {
          skuId: skuIdByCode.get(line.sku) ?? null,
          sku: line.sku,
          title: line.title,
          quantity: line.quantity,
          unitPriceWithTaxMinor: line.unitPriceWithTaxMinor,
          discountMinor: line.discountMinor,
          taxFactor: line.taxFactor,
        };

        if (existing) {
          await tx.orderLine.update({ where: { id: existing.id }, data });
        } else {
          await tx.orderLine.create({
            data: {
              ...data,
              orderId,
              shopifyLineItemId: line.shopifyLineItemId,
            },
          });
        }
      }
    }

    await tx.order.update({
      where: { id: orderId },
      data: {
        financialStatus: parsed.financialStatus,
        fulfillmentState: parsed.fulfillmentState,
        paymentGateway: parsed.gateway,
        cancelledAt: parsed.cancelledAt,
        shopifyUpdatedAt: parsed.updatedAt,
        lastSyncedAt: input.now,
        divergedAt: input.diverged ? input.now : null,
        ...(input.status ? { status: input.status } : {}),
        ...(input.replaceLines
          ? {
              presentmentCurrency: parsed.currency,
              totalMinor: parsed.totalMinor,
              shippingMinor: parsed.shippingMinor,
              discountMinor: parsed.discountMinor,
            }
          : {}),
        /*
         * The payload is refreshed unless retention has already been applied.
         *
         * Writing a fresh payload over a redacted order would put the
         * customer's name, address and email back into a row the §2.4 promise
         * says no longer holds them, with `redacted_at` still claiming
         * otherwise. A redacted order is ninety days old; what is left to learn
         * about it is its status, and that lives in columns.
         */
        ...(order.redactedAt
          ? {}
          : {
              rawPayload: minimiseOrderPayload(
                input.rawPayload,
              ) as Prisma.InputJsonValue,
            }),
      },
    });
  });
}

/**
 * Records that the order has been checked and nothing this app acts on moved —
 * and stores the payload anyway.
 *
 * **The payload is refreshed even when the diff found nothing, and that is not
 * belt and braces.** `raw_payload` is not a copy of the diff's inputs: it is
 * Shopify's whole record of the order, and it is where the customer, the
 * addresses and the tax lines live. The diff deliberately watches only what
 * this app would *send differently* — so every field outside it was a field
 * that could go stale permanently.
 *
 * That is not hypothetical. An order created with no address, given one in
 * Shopify a minute later, synced, and correctly diffed as "nothing this app
 * acts on changed" — so the payload carrying the new address was thrown away,
 * and the order could never be sent to MetaKocka however many times anyone
 * pressed retry. The fix is not to widen the diff until it covers everything;
 * it is to stop treating "no action needed" as "no news".
 */
export async function touchOrderSync(
  principal: Principal,
  orderId: string,
  at: Date,
  shopifyUpdatedAt: Date | null,
  rawPayload?: unknown,
): Promise<void> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, shop: { domain: shopDomainOf(principal) } },
    select: { id: true, redactedAt: true },
  });
  if (!order) return;

  await prisma.order.update({
    where: { id: order.id },
    data: {
      lastSyncedAt: at,
      ...(shopifyUpdatedAt ? { shopifyUpdatedAt } : {}),
      // Never over a redacted order: §2.4 promised those details are gone, and
      // writing them back would make `redacted_at` a lie.
      ...(rawPayload !== undefined && !order.redactedAt
        ? {
            rawPayload: minimiseOrderPayload(
              rawPayload,
            ) as Prisma.InputJsonValue,
          }
        : {}),
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Payment, recorded once per document                                        */
/* -------------------------------------------------------------------------- */

/**
 * How long a payment claim may sit unfinished before another job may take it.
 *
 * Matched to the mark-paid queue's `expireInSeconds`, on the same reasoning as
 * `CLAIM_LEASE_MS` above: past that point pg-boss has abandoned the job holding
 * the claim, so nobody is still calling MetaKocka with it.
 */
const PAYMENT_CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * Claims one document for a payment write.
 *
 * §8.7: `mark_paid` on an update **deletes the previous payment and replaces
 * it**, so it is sent exactly once per document. Two jobs arriving together
 * would otherwise both send one and the second would quietly replace the
 * first — and they do arrive together: `orders/paid` and `orders/updated`
 * describe the same moment, and the nightly reconciler may be reading the same
 * order while both land.
 *
 * The claim is a conditional update rather than a read followed by a write, so
 * the database settles the race instead of whichever job happened to look
 * first. Returns false when somebody else holds it.
 */
export async function claimPaymentMark(
  documentId: string,
  now: Date,
): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - PAYMENT_CLAIM_LEASE_MS);

  const claimed = await prisma.metakockaDocument.updateMany({
    where: {
      id: documentId,
      paymentMarkedAt: null,
      OR: [
        { paymentClaimedAt: null },
        { paymentClaimedAt: { lt: staleBefore } },
      ],
    },
    data: { paymentClaimedAt: now },
  });

  return claimed.count === 1;
}

/** Releases a claim whose write never happened, so a retry can pick it up. */
export async function releasePaymentClaim(documentId: string): Promise<void> {
  await prisma.metakockaDocument.updateMany({
    where: { id: documentId, paymentMarkedAt: null },
    data: { paymentClaimedAt: null },
  });
}

export async function recordPaymentMark(
  documentId: string,
  input: {
    at: Date;
    paymentType: string;
    amountMinor: number;
    requestBody?: unknown;
  },
): Promise<void> {
  await prisma.metakockaDocument.update({
    where: { id: documentId },
    data: {
      paymentMarkedAt: input.at,
      paymentType: input.paymentType,
      paymentAmountMinor: input.amountMinor,
      ...(input.requestBody !== undefined
        ? { requestBody: input.requestBody as Prisma.InputJsonValue }
        : {}),
    },
  });
}

/** An order's documents, with the body that was sent to create each one. */
export async function listDocumentsForPayment(
  principal: Principal,
  orderId: string,
) {
  return prisma.metakockaDocument.findMany({
    where: { orderId, shop: { domain: shopDomainOf(principal) } },
    select: {
      id: true,
      countCode: true,
      status: true,
      mkId: true,
      isPrimary: true,
      supplySourceId: true,
      paymentMarkedAt: true,
      requestBody: true,
    },
    orderBy: { isPrimary: "desc" },
  });
}

/* -------------------------------------------------------------------------- */
/* Fixing an order by hand                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Stores customer details a merchant entered for an order Shopify has none on.
 *
 * §2.4 governs this exactly as it governs the payload: it is protected customer
 * data, it is kept only because it is sent to the ERP, and the retention job
 * redacts it with everything else. Passing null clears it, which is how a
 * merchant undoes a mistake without needing a second button.
 */
export async function savePartnerOverride(
  principal: Principal,
  orderId: string,
  override: PartnerOverride | null,
): Promise<void> {
  await prisma.order.updateMany({
    where: { id: orderId, shop: { domain: shopDomainOf(principal) } },
    data: {
      partnerOverride: (override ?? null) as Prisma.InputJsonValue,
      /*
       * A different customer means a different partner in MetaKocka.
       *
       * The resolved id is cached on the order so the several jobs of a split
       * order cannot each create their own copy (§3: inline partner data
       * creates a new partner every time). Editing the details without clearing
       * it would leave the document pointing at the partner these details
       * replaced — the one thing worse than having no partner at all.
       */
      metakockaPartnerMkId: null,
      metakockaPartnerAddressId: null,
    },
  });
}

export interface ManualAllocationInput {
  orderLineId: string;
  supplySourceId: string;
  quantity: number;
}

/**
 * Sets the supply sources for an order by hand, and stops the app changing its
 * mind afterwards.
 *
 * This is the other half of "choose a source by hand, or restock and retry" —
 * advice the exceptions queue has been giving since the beginning with nowhere
 * to act on it. It exists for the case automatic allocation cannot answer: the
 * stock figures say no, and the merchant knows something the figures do not.
 *
 * **The lock is the point.** Allocation replaces the whole set every time it
 * runs, and it runs for reasons that have nothing to do with the merchant — a
 * stock sync, an order update, the exception re-check. Without
 * `allocationLockedAt` a hand-made decision would survive until the next one of
 * those and then silently revert, which is worse than never offering the choice.
 *
 * The reason is recorded like any other (§6: the audit trail is a product
 * feature), so the order page says a person chose this and when.
 */
/**
 * A manual allocation naming a supply source this shop does not have.
 *
 * Its own type so the route can answer with a message rather than a 500. It
 * only happens on a forged post — the picker cannot offer one — but "only a
 * forged post" is not a reason to hand back a stack trace.
 */
export class UnknownSupplySourceError extends Error {
  constructor(readonly supplySourceIds: string[]) {
    super(
      `Unknown supply source: ${supplySourceIds.join(", ")}`,
    );
    this.name = "UnknownSupplySourceError";
  }
}

export async function setManualAllocations(
  principal: Principal,
  orderId: string,
  records: ManualAllocationInput[],
  chosenBy: string,
  now: Date,
): Promise<void> {
  const shopDomain = shopDomainOf(principal);

  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: orderId, shop: { domain: shopDomain } },
      select: { id: true, lines: { select: { id: true } } },
    });
    if (!order) throw new Error("Order not found");

    const lineIds = new Set(order.lines.map((line) => line.id));
    const mine = records.filter((record) => lineIds.has(record.orderLineId));

    /*
     * The chosen source has to belong to this shop.
     *
     * The order and its lines are already scoped, but the source id comes
     * straight off a form. Nothing in the picker can offer another tenant's
     * source — `listAllocatableSources` is scoped too — so only a forged post
     * reaches here, and what it would buy is real: the order page joins the
     * allocation to its source to render the name, so a guessed id would show
     * one shop another shop's supply source, and the document writer would
     * read that source's warehouse and profit centre.
     *
     * §9 puts this in the repository rather than in the route on purpose:
     * route code is allowed to forget.
     */
    const chosen = [...new Set(mine.map((record) => record.supplySourceId))];
    if (chosen.length > 0) {
      const owned = await tx.supplySource.findMany({
        where: { id: { in: chosen }, shop: { domain: shopDomain } },
        select: { id: true },
      });
      const ownedIds = new Set(owned.map((source) => source.id));
      const foreign = chosen.filter((id) => !ownedIds.has(id));
      if (foreign.length > 0) {
        throw new UnknownSupplySourceError(foreign);
      }
    }

    await tx.allocation.deleteMany({
      where: { orderLineId: { in: [...lineIds] } },
    });

    for (const record of mine) {
      await tx.allocation.create({
        data: {
          orderLineId: record.orderLineId,
          supplySourceId: record.supplySourceId,
          quantity: record.quantity,
          status: "planned",
          reason: {
            rule: "manual",
            detail: `Chosen by hand on ${now.toISOString().slice(0, 10)}, overriding what the stock figures allow.`,
            chosenBy,
          } as Prisma.InputJsonValue,
        },
      });
    }

    /*
     * Anything left unallocated is still a decision, and still needs a person —
     * so the order goes back to needing attention rather than reporting itself
     * ready to send.
     */
    const covered = new Set(mine.map((record) => record.orderLineId));
    const complete = [...lineIds].every((id) => covered.has(id));

    await tx.order.update({
      where: { id: orderId },
      data: {
        allocationLockedAt: now,
        status: complete ? "allocated" : "needs_attention",
      },
    });
  });
}

/** Every source a merchant may choose from, for the picker on the order page. */
export async function listAllocatableSources(principal: Principal) {
  return prisma.supplySource.findMany({
    where: { shop: { domain: shopDomainOf(principal) }, enabled: true },
    select: {
      id: true,
      name: true,
      code: true,
      kind: true,
      metakockaWarehouse: true,
    },
    orderBy: [{ priority: "asc" }, { name: "asc" }],
  });
}

/**
 * What this app last observed in each source, for the SKUs on one order.
 *
 * Shown beside the picker so choosing by hand is an informed decision rather
 * than a guess — including when the honest answer is "this source has none",
 * which is often exactly the override the merchant means to make.
 */
export async function stockForOrder(
  principal: Principal,
  orderId: string,
): Promise<Map<string, Map<string, number>>> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, shop: { domain: shopDomainOf(principal) } },
    select: { lines: { select: { sku: true } } },
  });
  if (!order) return new Map();

  const skus = order.lines.map((line) => line.sku).filter(Boolean);
  if (skus.length === 0) return new Map();

  const levels = await prisma.supplyLevel.findMany({
    where: {
      sku: { sku: { in: skus }, shop: { domain: shopDomainOf(principal) } },
      supplySource: { enabled: true },
    },
    select: {
      quantity: true,
      reserved: true,
      supplySourceId: true,
      sku: { select: { sku: true } },
    },
  });

  // sku -> sourceId -> free to sell, the same figure the allocator works from.
  const bySku = new Map<string, Map<string, number>>();
  for (const level of levels) {
    const forSku = bySku.get(level.sku.sku) ?? new Map<string, number>();
    forSku.set(
      level.supplySourceId,
      Math.max(0, level.quantity - level.reserved),
    );
    bySku.set(level.sku.sku, forSku);
  }

  return bySku;
}

export interface OrderLineProduct {
  imageUrl: string | null;
  /** The product's own title, as Shopify has it now. */
  title: string | null;
  /** The variant's option values, or null when the product has none. */
  variantTitle: string | null;
  matched: boolean;
}

/**
 * What the registry knows about the SKUs on one order.
 *
 * Read from our own tables, never from Shopify or MetaKocka: no page load may
 * wait on either (§2.5), and the catalogue read already collected all of it.
 *
 * It is here rather than on a product browser because this is where it answers
 * something. "MetaKocka has no product with the code P04200014480" is the
 * commonest reason an order stops, and the code alone tells nobody which
 * product that is or whether they are looking at the right one.
 */
export async function productsForSkus(
  principal: Principal,
  skus: string[],
): Promise<Map<string, OrderLineProduct>> {
  const wanted = [...new Set(skus.filter(Boolean))];
  if (wanted.length === 0) return new Map();

  const rows = await prisma.sku.findMany({
    where: { shop: { domain: shopDomainOf(principal) }, sku: { in: wanted } },
    select: {
      sku: true,
      title: true,
      variantTitle: true,
      imageUrl: true,
      status: true,
    },
  });

  return new Map(
    rows.map((row) => [
      row.sku,
      {
        imageUrl: row.imageUrl,
        title: row.title,
        variantTitle: row.variantTitle,
        matched: row.status === "matched",
      },
    ]),
  );
}

/**
 * Marks exactly one document of an order primary, and the rest not.
 *
 * §8.6 gives the shipping, the COD surcharge and the order-level discount to
 * one document, and `splitOrderMoney` picks it deterministically — so "which
 * one" is a fact about the order, not about the job that happens to be running.
 *
 * It used to be written per job, and only ever upwards: a job whose source came
 * out primary set the flag, and nothing ever cleared it on the others. Re-drive
 * an order after its allocation moved and the winner changes, so the order ends
 * up with two primary documents — each carrying the shipping, and each claiming
 * to be the one that does.
 */
export async function applyPrimaryDocument(
  orderId: string,
  primarySourceId: string | null,
): Promise<void> {
  await prisma.$transaction([
    prisma.metakockaDocument.updateMany({
      where: { orderId, supplySourceId: { not: primarySourceId } },
      data: { isPrimary: false },
    }),
    ...(primarySourceId
      ? [
          prisma.metakockaDocument.updateMany({
            where: { orderId, supplySourceId: primarySourceId },
            data: { isPrimary: true },
          }),
        ]
      : []),
  ]);
}

/**
 * Documents for supply sources this order no longer takes anything from.
 *
 * A re-allocation moves a line to another warehouse and the document written
 * for the old one stops describing anything the order contains. It cannot be
 * deleted — §8.8, it may already be invoiced — so it is named, and above all it
 * is **not treated as a live document**: its payment must stop being counted
 * towards the order, or a split that moved once is paid twice.
 */
export async function findStaleDocuments(
  orderId: string,
  allocatedSourceIds: string[],
) {
  return prisma.metakockaDocument.findMany({
    where: {
      orderId,
      status: "written",
      ...(allocatedSourceIds.length > 0
        ? { supplySourceId: { notIn: allocatedSourceIds } }
        : {}),
    },
    select: {
      id: true,
      countCode: true,
      mkId: true,
      paymentMarkedAt: true,
      paymentAmountMinor: true,
      supplySource: { select: { name: true } },
    },
  });
}
