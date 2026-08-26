import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  closeExceptionsFor,
  hasOpenException,
  raiseException,
} from "~/adapters/db/repositories/exception.server";
import { getCredential } from "~/adapters/db/repositories/metakocka-credential.server";
import { representedPaymentTotal } from "~/adapters/db/repositories/order-payment.server";
import {
  applyPrimaryDocument,
  claimOrderReconciliation,
  listDocumentsForReconciliation,
  recordSyncVerdict,
  releaseOrderReconciliation,
  replaceAllocations,
  reviveDocument,
} from "~/adapters/db/repositories/order.server";
import { getSalesOrderSettings } from "~/adapters/db/repositories/sales-order-setting.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  fetchFulfillmentAssignments,
  type FulfillmentAssignment,
} from "~/adapters/shopify/fulfillment-orders";
import { fetchOrderById } from "~/adapters/shopify/orders";
import { fetchOrderTransactions } from "~/adapters/shopify/transactions";
import { unauthenticated } from "~/adapters/shopify/shopify.server";
import {
  classifyQuantities,
  type CanonicalAllocation,
  type CanonicalLine,
} from "~/domain/orders/canonical";
import {
  planDocuments,
  sameLines,
  type DocumentAction,
  type ExistingDocument,
} from "~/domain/orders/reconcile";
import { serviceToken, type Principal } from "~/domain/types";
import { writeMetakockaOrderFor } from "~/jobs/handlers/write-metakocka-order";
import { syncOrderState } from "~/jobs/handlers/sync-order-state";
import { computeDocumentShares } from "~/jobs/order-shares";
import { planAllocations, planCoverage } from "~/jobs/orders/allocation-planner";
import { retireObsoleteDocument } from "~/jobs/orders/document-reconciler";
import {
  planPayments,
  reconcileLedger,
} from "~/jobs/orders/payment-reconciler";
import { contentOf, verifyOrder } from "~/jobs/orders/verification";

/**
 * One Shopify order, reconciled into MetaKocka (CLAUDE.md §8; the whole of the
 * order-reconciliation brief).
 *
 * This is the loop the connector is built around, and the thing it replaces is
 * worth naming: an event-to-document mapper. A webhook used to *mean* something
 * — "create a sales order", "mark it paid" — and every one of the hard cases
 * followed from that. An order edited twice produced two answers; a webhook
 * that arrived late described a world that had moved on; a retry after a
 * timeout risked a second document, because the trigger and the action were the
 * same thing.
 *
 * Here a webhook means only "look again". The sequence is fixed:
 *
 * ```text
 * acquire the per-order lock
 *   read the order from Shopify, fresh
 *   read where Shopify says each line ships from
 *   read the payment transactions
 *   build the desired state
 *   compare it with what MetaKocka is known to hold
 *   change only the difference
 *   verify the result adds up
 *   record the verdict and the trail
 * release the lock
 * ```
 *
 * Three properties follow, and they are the ones the brief asks for:
 *
 *  - **Repeating it changes nothing.** Every step is a comparison; an unchanged
 *    order produces no writes at all.
 *  - **Nothing is ever created because an event arrived.** Documents are
 *    created because the desired state has a warehouse with no document, which
 *    a duplicate webhook cannot make true twice.
 *  - **Order matters less than truth.** A late event triggers a read of the
 *    current order, so an out-of-order delivery converges on the same answer as
 *    an in-order one.
 */

export const reconcileOrderJobSchema = z.object({
  shopDomain: z.string().min(1),
  /** Either identifier; the Shopify one is what webhooks carry. */
  orderId: z.string().optional(),
  shopifyOrderId: z.string().optional(),
  /** Why this run was triggered, for the audit trail. */
  reason: z.string().optional(),
});

export type ReconcileResult =
  | { kind: "skipped"; reason: string }
  | {
      kind: "reconciled";
      orderId: string;
      actions: DocumentAction[];
      inconsistent: boolean;
    };

export async function handleReconcileOrder(job: Job<unknown>): Promise<void> {
  const { shopDomain, orderId, shopifyOrderId, reason } =
    reconcileOrderJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "reconcile-order");
  const log = getLogger();

  const order = await prisma.order.findFirst({
    where: {
      shop: { domain: shopDomain },
      ...(orderId ? { id: orderId } : {}),
      ...(shopifyOrderId ? { shopifyOrderId } : {}),
    },
    select: { id: true },
  });

  if (!order) {
    log.info(
      { shop: shopDomain, orderId, shopifyOrderId },
      "Nothing to reconcile: this app does not hold that order",
    );
    return;
  }

  const outcome = await reconcileOrder(principal, order.id, {
    reason: reason ?? "queued",
  });

  log.info(
    { shop: shopDomain, orderId: order.id, outcome: outcome.kind },
    "Order reconciliation finished",
  );
}

/**
 * The loop itself, callable directly.
 *
 * Exported so the order page and the scheduled sweep can run it and report the
 * result rather than queueing and hoping.
 */
export async function reconcileOrder(
  principal: Principal,
  orderId: string,
  options: { reason: string; now?: Date; payload?: unknown },
): Promise<ReconcileResult> {
  const log = getLogger();
  const now = options.now ?? new Date();

  /* ---------------------------------------------------------------------- */
  /* The lock                                                               */
  /* ---------------------------------------------------------------------- */

  /*
   * Everything below reads a state and then writes based on it, which is only
   * safe while nobody else is doing the same. Losing the claim is a normal
   * outcome, not an error: the holder is reconciling the same order from the
   * same Shopify and will reach the same answer.
   */
  if (!(await claimOrderReconciliation(principal, orderId, now))) {
    log.info(
      { shop: principal.shopDomain, orderId },
      "Reconciliation already running for this order, skipping",
    );
    return { kind: "skipped", reason: "another reconciliation holds this order" };
  }

  try {
    return await reconcileUnderLock(principal, orderId, { ...options, now });
  } finally {
    await releaseOrderReconciliation(orderId);
  }
}

async function reconcileUnderLock(
  principal: Principal,
  orderId: string,
  options: { reason: string; now: Date; payload?: unknown },
): Promise<ReconcileResult> {
  const log = getLogger();
  const { now } = options;
  const shopDomain = principal.shopDomain;

  const head = await prisma.order.findFirst({
    where: { id: orderId, shop: { domain: shopDomain } },
    select: {
      id: true,
      shopifyOrderId: true,
      shopifyOrderNumber: true,
      shopifyDeletedAt: true,
      allocationLockedAt: true,
    },
  });
  if (!head) return { kind: "skipped", reason: "the order no longer exists" };

  /*
   * Deleted in Shopify, kept in MetaKocka (§8.8).
   *
   * There is no Shopify order left to be in step with, and the ERP document may
   * already be invoiced. Reconciling would mean deciding what an order that
   * does not exist should look like, which is not a question with an answer.
   */
  if (head.shopifyDeletedAt) {
    return { kind: "skipped", reason: "the order was deleted in Shopify" };
  }

  const settings = await getSalesOrderSettings(principal);

  /* ---------------------------------------------------------------------- */
  /* Read Shopify                                                           */
  /* ---------------------------------------------------------------------- */

  const { admin } = await unauthenticated.admin(shopDomain);

  /*
   * The order, fresh.
   *
   * A webhook payload is accepted when the caller has one, but the default is a
   * read: §12 of the brief is explicit that a webhook is a trigger and not a
   * source of truth, and the payload of an `orders/edited` is not even an
   * order.
   */
  const payload = options.payload ?? (await fetchOrderById(admin, head.shopifyOrderId));

  if (!payload) {
    // Shopify no longer has it. `orders/delete` handles that case and leaves
    // the MetaKocka document alone; there is nothing to compare against.
    return { kind: "skipped", reason: "Shopify no longer has that order" };
  }

  // Applies Shopify's view to the database — lines, totals, financial status,
  // the high-water mark — and raises the divergence/cancellation exceptions it
  // always did. `followUp: false` because this pass *is* the follow-up.
  await syncOrderState(principal, payload, {
    source: options.reason === "webhook" ? "webhook" : "reconciler",
    now,
    followUp: false,
  });

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { lines: { orderBy: { createdAt: "asc" } } },
  });
  if (!order) return { kind: "skipped", reason: "the order no longer exists" };

  const canonicalLines: CanonicalLine[] = order.lines.map((line) => ({
    shopifyLineItemId: line.shopifyLineItemId,
    sku: line.sku,
    title: line.title,
    quantity: line.quantity,
    unitPriceWithTaxMinor: line.unitPriceWithTaxMinor,
    discountMinor: line.discountMinor,
    taxFactor: line.taxFactor,
  }));

  /* ---------------------------------------------------------------------- */
  /* The payment ledger                                                     */
  /* ---------------------------------------------------------------------- */

  /*
   * Read and stored before anything is decided about documents, and stored
   * whether or not payments are being written to MetaKocka. "What has this
   * customer actually paid" is worth answering on the order screen even for a
   * merchant who settles in the ERP by hand — and it is the only way to tell a
   * partly paid order from a paid one, which `financial_status` cannot.
   */
  const transactions = await fetchOrderTransactions(admin, head.shopifyOrderId);
  const ledger = await reconcileLedger(principal, {
    orderId,
    transactions: transactions.transactions,
    orderTotalMinor: order.totalMinor,
    now,
  });

  /*
   * A refund Shopify has processed and MetaKocka has not been credited for.
   *
   * The ledger is right either way — the capture stays at what was actually
   * received and the refund nets against it, which is the rule the brief is
   * emphatic about and which this app does not break. But *MetaKocka* is then
   * carrying a receipt with no corresponding credit, and an order in that state
   * is not financially reconciled however tidy its documents are.
   *
   * This app cannot issue the credit note: the accounting behaviour is not
   * verified and inventing one would be exactly the speculative implementation
   * the brief rules out. So it raises the action and, below, refuses to call
   * the order `in_sync` while the action is outstanding. The merchant resolving
   * the exception is the signal that the books have been squared, because
   * nothing in the API would tell this app.
   */
  if (ledger.summary.refundedMinor > 0) {
    await raiseException(principal, {
      orderId,
      kind: "refund_received",
      message: `Order ${order.shopifyOrderNumber} has been refunded ${(ledger.summary.refundedMinor / 100).toFixed(2)} ${order.presentmentCurrency} in Shopify, of ${(ledger.summary.grossReceivedMinor / 100).toFixed(2)} received. This app records the refund, so what the customer has actually paid is right — but a refund is never written onto a sales order, because the only way to do that would be to shrink the payment already recorded and destroy the record of what was received. MetaKocka still shows the full receipt. Issue the credit note there, then resolve this.`,
      detail: {
        grossReceivedMinor: ledger.summary.grossReceivedMinor,
        refundedMinor: ledger.summary.refundedMinor,
        netPaidMinor: ledger.summary.netPaidMinor,
        creditRequiredMinor: ledger.summary.refundedMinor,
      },
    });
  }

  if (transactions.possiblyTruncated) {
    await raiseException(principal, {
      orderId,
      kind: "payment_unallocated",
      message: `Order ${order.shopifyOrderNumber} has more payment transactions than this app reads in one pass, so what it believes was paid may be short of what actually was. Nothing was guessed at. Check the payments in Shopify against MetaKocka by hand.`,
      detail: { read: transactions.transactions.length },
    });
  }

  /*
   * An order that is over is recorded, not acted on.
   *
   * Cancelling or crediting a MetaKocka document is never automatic (§8.8), so
   * there is nothing to converge towards: the desired state of a cancelled
   * order's documents is a question only the merchant can answer. The
   * exception `syncOrderState` raised is the answer this app has.
   */
  if (order.cancelledAt) {
    await recordSyncVerdict(orderId, {
      state: "blocked",
      detail: {
        reason: "the order is cancelled in Shopify",
        documents: (await listDocumentsForReconciliation(principal, orderId))
          .filter((document) => document.status === "written")
          .map((document) => document.countCode),
      },
      at: now,
    });
    return { kind: "reconciled", orderId, actions: [], inconsistent: false };
  }

  /* ---------------------------------------------------------------------- */
  /* Where each line ships from                                             */
  /* ---------------------------------------------------------------------- */

  let assignments: FulfillmentAssignment[] = [];
  let unreadableLocation = false;

  if (settings.allocationMode === "shopify_locations") {
    const read = await fetchFulfillmentAssignments(admin, head.shopifyOrderId);
    assignments = read.assignments;
    unreadableLocation = read.hasUnreadableLocation;
  }

  /*
   * A person chose the supply sources by hand.
   *
   * Allocation replaces the whole set every time it runs, so re-planning would
   * revert their decision the next time anything touched the order. The
   * documents are still reconciled against that allocation — the merchant chose
   * the warehouses, not the quantities.
   */
  const plan = head.allocationLockedAt
    ? null
    : await planAllocations(principal, {
        orderId,
        lines: order.lines.map((line) => ({
          orderLineId: line.id,
          shopifyLineItemId: line.shopifyLineItemId,
          sku: line.sku,
          title: line.title,
          quantity: line.quantity,
        })),
        canonicalLines,
        assignments,
        mode: settings.allocationMode,
      });

  /*
   * Where every Shopify quantity went.
   *
   * From the plan when one was made; from the persisted allocations when a
   * person pinned the sources by hand, so a locked order is classified by the
   * same rules rather than skipping the question.
   */
  const classification =
    plan?.classification ??
    classifyQuantities(
      canonicalLines,
      await persistedAllocations(orderId, canonicalLines),
    );

  if (plan) {
    const coverage = planCoverage(canonicalLines, plan);

    await replaceAllocations(
      principal,
      orderId,
      plan.records,
      plan.shortfalls.length > 0 || coverage.shortfalls.length > 0
        ? "needs_attention"
        : "allocated",
    );

    if (plan.shortfalls.length === 0) {
      await closeExceptionsFor(principal, orderId, ["insufficient_stock"]);
    } else {
      await raiseException(principal, {
        orderId,
        kind: "insufficient_stock",
        message: `No supply source has enough stock for ${plan.shortfalls
          .map((shortfall) => `${shortfall.sku} (${shortfall.quantity})`)
          .join(", ")}. Choose a source by hand, or restock and reconcile again.`,
        detail: { shortfalls: plan.shortfalls },
      });
    }

    if (plan.unmappedLocations.length > 0) {
      await raiseException(principal, {
        orderId,
        kind: "unmapped_location",
        message: `Shopify is fulfilling part of order ${order.shopifyOrderNumber} from ${plan.unmappedLocations
          .map((entry) => entry.locationName ?? entry.shopifyLocationId)
          .join(
            ", ",
          )}, which is not mapped to a MetaKocka warehouse — so those lines were not sent. Map the location on the Locations page, then reconcile this order again.`,
        detail: { locations: plan.unmappedLocations },
      });
    } else {
      await closeExceptionsFor(principal, orderId, ["unmapped_location"]);
    }

  }

  /*
   * Shopify is fulfilling part of this order somewhere this app cannot manage.
   *
   * An explicit business rule rather than an omission: those quantities are
   * **not** represented in MetaKocka, because the goods never move through a
   * MetaKocka warehouse and no mapping could say which one — allocating them by
   * guesswork would misstate the ERP's stock.
   *
   * It is also never silent. The quantity is classified as `external`, the
   * order is held out of `in_sync` below, and this names the service so the
   * merchant can tell it apart from something being broken.
   */
  if (classification.externalTotal > 0) {
    const services = [
      ...new Set(
        (plan?.externalLocations ?? [])
          .map((entry) => entry.locationName)
          .filter((name): name is string => Boolean(name)),
      ),
    ];

    await raiseException(principal, {
      orderId,
      kind: "unmapped_location",
      message: `Shopify is fulfilling ${classification.externalTotal} ${classification.externalTotal === 1 ? "item" : "items"} on order ${order.shopifyOrderNumber} through ${services.length > 0 ? services.join(", ") : "a fulfilment service this app cannot see"}. Those ${classification.externalTotal === 1 ? "goods do" : "goods do"} not pass through a MetaKocka warehouse, so ${classification.externalTotal === 1 ? "it is" : "they are"} deliberately not on the sales order and this app has not guessed a warehouse for ${classification.externalTotal === 1 ? "it" : "them"}. Record ${classification.externalTotal === 1 ? "it" : "them"} in MetaKocka by hand if your books need ${classification.externalTotal === 1 ? "it" : "them"}, then resolve this.`,
      detail: {
        services,
        externalUnits: classification.externalTotal,
        lines: classification.externalLines,
      },
    });
  }

  if (unreadableLocation && classification.externalTotal === 0) {
    log.info(
      { shop: shopDomain, orderId },
      "Shopify named a fulfilment service this app cannot resolve, but it holds none of this order's quantity",
    );
  }

  /* ---------------------------------------------------------------------- */
  /* What MetaKocka should hold, against what it does                       */
  /* ---------------------------------------------------------------------- */

  const shares = await computeDocumentShares(orderId);
  await applyPrimaryDocument(
    orderId,
    shares.find((share) => share.isPrimary)?.sourceId ?? null,
  );

  const desiredBySource = await desiredDocumentLines(orderId);
  const existingRows = await listDocumentsForReconciliation(principal, orderId);

  const existing: ExistingDocument[] = existingRows.map((row) => ({
    documentId: row.id,
    supplySourceId: row.supplySourceId,
    countCode: row.countCode,
    status: row.status,
    present: row.status === "written" && row.mkId !== null,
    paid: row.paymentMarkedAt !== null,
    retired: row.retiredAt !== null,
    lines: contentOf({
      countCode: row.countCode,
      retired: row.retiredAt !== null,
      requestBody: row.requestBody,
    }).lines,
  }));

  const actions = planDocuments({
    desired: [...desiredBySource.entries()].map(([supplySourceId, lines]) => ({
      supplySourceId,
      lines,
    })),
    existing,
  });

  /* ---------------------------------------------------------------------- */
  /* What each document should say about payments                           */
  /* ---------------------------------------------------------------------- */

  const retiredSourceIds = new Set(
    actions
      .filter((action) => action.kind === "retire" && action.supplySourceId)
      .map((action) => action.supplySourceId!),
  );

  const payments = settings.syncPayments
    ? await planPayments(principal, {
        ledger,
        shares,
        retiredSourceIds,
        countCodeBySource: new Map(
          existingRows
            .filter((row) => row.supplySourceId)
            .map((row) => [row.supplySourceId!, row.countCode]),
        ),
        strategy: settings.paymentAllocation,
        entryMode: settings.paymentEntryMode,
        fallbackPaidAt: order.receivedAt,
      })
    : null;

  if (payments && payments.unmappedGateways.length > 0) {
    await raiseException(principal, {
      orderId,
      kind: "unmapped_payment_gateway",
      message: `Money arrived for order ${order.shopifyOrderNumber} on ${payments.unmappedGateways.join(", ")}, which ${payments.unmappedGateways.length === 1 ? "is" : "are"} not mapped to a MetaKocka payment type and no fallback type is set. The sales ${desiredBySource.size === 1 ? "order was" : "orders were"} sent; the payment was not, because a payment type is never guessed. Map it on the Payment types page, then reconcile this order again.`,
      detail: { gateways: payments.unmappedGateways },
    });
  }

  if (payments && payments.unmappedGateways.length === 0) {
    await closeExceptionsFor(principal, orderId, ["unmapped_payment_gateway"]);
  }

  if (payments && payments.unallocated.length > 0) {
    await raiseException(principal, {
      orderId,
      kind: "payment_unallocated",
      message: `Order ${order.shopifyOrderNumber} has received money that could not be recorded against any MetaKocka document, because ${payments.unallocated[0]!.reason}. Nothing was written anywhere else. Record it in MetaKocka by hand, then resolve this.`,
      detail: { unallocated: payments.unallocated },
    });
  }

  if (payments && payments.unallocated.length === 0) {
    await closeExceptionsFor(principal, orderId, ["payment_unallocated"]);
  }

  /* ---------------------------------------------------------------------- */
  /* Money the order carries that MetaKocka has no way to show               */
  /* ---------------------------------------------------------------------- */

  /*
   * Shipping and discounts are real money the customer was charged, and until
   * the merchant says how they should appear the ERP cannot account for the
   * whole order. Reported rather than guessed: which article an accountant
   * expects postage on is not a decision this app gets to make, and quietly
   * sending a sales order short of the postage is how a set of books stops
   * balancing without anyone noticing.
   *
   * The order still gets its documents — the merchandise is right, and being
   * short of the shipping is better than being absent — but it is held out of
   * `in_sync` below, so nothing reports full commercial reconciliation.
   */
  const missingRepresentation: string[] = [];
  if (order.shippingMinor > 0 && !settings.shippingProductCode) {
    missingRepresentation.push(
      `shipping of ${(order.shippingMinor / 100).toFixed(2)} ${order.presentmentCurrency}`,
    );
  }
  if (
    order.discountMinor > 0 &&
    settings.discountRepresentation === "none"
  ) {
    missingRepresentation.push(
      `a discount of ${(order.discountMinor / 100).toFixed(2)} ${order.presentmentCurrency}`,
    );
  }

  if (missingRepresentation.length > 0) {
    await raiseException(principal, {
      orderId,
      kind: "commercial_representation_missing",
      message: `Order ${order.shopifyOrderNumber} carries ${missingRepresentation.join(" and ")} that MetaKocka has no way to show, because ${missingRepresentation.length === 1 ? "it has" : "they have"} no representation configured. The sales ${desiredBySource.size === 1 ? "order was" : "orders were"} written with the goods, so the ERP is short by that amount and this order is not reported as fully reconciled. Choose a shipping product and a discount representation on the order settings page, then reconcile this order again.`,
      detail: {
        shippingMinor: order.shippingMinor,
        discountMinor: order.discountMinor,
        shippingProductCode: settings.shippingProductCode,
        discountRepresentation: settings.discountRepresentation,
      },
    });
  } else {
    await closeExceptionsFor(principal, orderId, [
      "commercial_representation_missing",
    ]);
  }

  /* ---------------------------------------------------------------------- */
  /* Apply the difference                                                   */
  /* ---------------------------------------------------------------------- */

  const credential = await getCredential(principal);
  const client = credential
    ? new MetakockaClient({
        companyId: credential.companyId,
        secretKey: credential.secretKey,
      })
    : null;

  for (const action of actions) {
    if (action.kind === "retire") {
      if (!client) continue;
      const row = existingRows.find((entry) => entry.id === action.documentId);
      await retireObsoleteDocument(principal, {
        client,
        orderId,
        orderNumber: order.shopifyOrderNumber,
        action,
        policy: settings.obsoleteDocumentPolicy,
        sourceName: row?.supplySource?.name ?? null,
        mkId: row?.mkId ?? null,
        requestBody: row?.requestBody ?? null,
        now,
      });
      continue;
    }

    /*
     * A retired document whose warehouse is wanted again.
     *
     * Reviving the row rather than writing a second document is the whole point
     * of never deleting it: the `count_code` is still claimed here, so the
     * write below updates in place. A line that moved to another warehouse and
     * back leaves one document, not three.
     */
    const row = existingRows.find(
      (entry) => entry.supplySourceId === action.supplySourceId,
    );
    if (row?.retiredAt) await reviveDocument(row.id);

    /*
     * `unchanged` still goes through the write.
     *
     * It is the one executor, and it re-compares the body it is about to send
     * against the body it last sent — so an unchanged document costs one
     * comparison and no MetaKocka call, and a document the planner called
     * unchanged for its *lines* still has its payments reconciled.
     */
    await writeMetakockaOrderFor(principal, {
      orderId,
      supplySourceId: action.supplySourceId,
      ...(payments
        ? {
            payments: {
              payments:
                payments.bySource.get(action.supplySourceId)?.payments ?? [],
              // The ledger identities go with the amounts: without them the
              // applications table is cleared and §24 can never be satisfied.
              entries:
                payments.bySource.get(action.supplySourceId)?.entries ?? [],
            },
          }
        : {}),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Verify                                                                 */
  /* ---------------------------------------------------------------------- */

  const finalRows = await listDocumentsForReconciliation(principal, orderId);

  const verification = verifyOrder({
    lines: canonicalLines,
    documents: finalRows
      .filter((row) => row.status === "written")
      .map((row) => ({
        countCode: row.countCode,
        retired: row.retiredAt !== null,
        requestBody: row.requestBody,
      })),
    classification,
    orderTotalMinor: order.totalMinor,
    // Named, not summed into an allowance: shipping and the order-level
    // discount are in the payment shares but are not yet MetaKocka document
    // lines (project status T-05/T-06), so they explain part of the total
    // rather than widening the tolerance around it.
    shippingMinor: order.shippingMinor,
    orderDiscountMinor: order.discountMinor,
    shippingProductCode: settings.shippingProductCode,
    discountConfigured:
      settings.discountRepresentation === "document_discount_value",
    grossReceivedMinor: ledger.summary.grossReceivedMinor,
    representedPaymentMinor: await representedPaymentTotal(principal, orderId),
  });

  /*
   * Two different questions about money, and the brief is right that they must
   * not be collapsed:
   *
   *   Shopify ledger reconciled     — every receipt Shopify reports is
   *                                   represented against a MetaKocka document.
   *   MetaKocka accounting reconciled — and nothing is outstanding on the ERP
   *                                   side, such as a credit note for a refund.
   *
   * An order can satisfy the first and fail the second, which is exactly what a
   * refund does.
   */
  const accountingActionOutstanding = await hasOpenException(
    principal,
    orderId,
    ["refund_received", "voided_payment"],
  );

  const blocked =
    missingRepresentation.length > 0 ||
    accountingActionOutstanding ||
    classification.externalTotal > 0 ||
    (plan?.unmappedLocations.length ?? 0) > 0 ||
    (payments?.unmappedGateways.length ?? 0) > 0 ||
    (payments?.unallocated.length ?? 0) > 0;

  const state = !verification.ok
    ? "inconsistent"
    : blocked
      ? "blocked"
      : "in_sync";

  await recordSyncVerdict(orderId, {
    state,
    detail: {
      checkedAt: now.toISOString(),
      quantities: verification.quantities,
      /*
       * Every Shopify unit, sorted: represented in MetaKocka, explicitly
       * fulfilled elsewhere, or unresolved. The brief's "never silently
       * missing" is only meaningful if the breakdown is recorded, so it is.
       */
      classification: {
        managed: classification.managedTotal,
        external: classification.externalTotal,
        unresolved: classification.unresolvedTotal,
        lines: classification.lines,
      },
      value: verification.value,
      payments: verification.payments,
      accounting: {
        shopifyLedgerReconciled: verification.payments.ok,
        metakockaAccountingReconciled: !accountingActionOutstanding,
        grossReceivedMinor: ledger.summary.grossReceivedMinor,
        refundedMinor: ledger.summary.refundedMinor,
        netPaidMinor: ledger.summary.netPaidMinor,
        creditRequiredMinor: accountingActionOutstanding
          ? ledger.summary.refundedMinor
          : 0,
      },
      documents: verification.documents,
    },
    at: now,
  });

  if (!verification.ok) {
    /*
     * **Never repaired by writing another document.**
     *
     * If MetaKocka holds six where Shopify says four, a new document makes it
     * ten. The repair is the same deterministic reconciliation that produced
     * this verdict — update the documents that exist — so the honest thing here
     * is to record the difference precisely and let the next pass, or a person,
     * act on it.
     */
    await raiseException(principal, {
      orderId,
      kind: "sync_inconsistent",
      message: `What MetaKocka holds for order ${order.shopifyOrderNumber} does not add up to what Shopify says it contains. ${verification.summary.join(
        " ",
      )} Nothing extra was created — another document would make the difference bigger, not smaller. Check the documents in MetaKocka (${verification.documents
        .map((document) => document.countCode)
        .join(", ")}) and reconcile this order again.`,
      detail: {
        quantities: verification.quantities.discrepancies,
        value: verification.value,
        documents: verification.documents,
      },
    });
  } else {
    await closeExceptionsFor(principal, orderId, ["sync_inconsistent"]);
  }

  /* ---------------------------------------------------------------------- */
  /* The trail                                                              */
  /* ---------------------------------------------------------------------- */

  await appendEvent(principal, {
    entityType: "order",
    entityId: orderId,
    event: "order.reconciled",
    detail: {
      reason: options.reason,
      allocationMode: settings.allocationMode,
      actions: actions.map((action) =>
        action.kind === "retire"
          ? { kind: action.kind, countCode: action.countCode }
          : { kind: action.kind, supplySourceId: action.supplySourceId },
      ),
      quantities: {
        shopify: verification.quantities.expectedTotal,
        metakocka: verification.quantities.actualTotal,
      },
      payments: {
        grossReceivedMinor: ledger.summary.grossReceivedMinor,
        refundedMinor: ledger.summary.refundedMinor,
        netPaidMinor: ledger.summary.netPaidMinor,
        outstandingMinor: ledger.summary.outstandingMinor,
        state: ledger.summary.state,
        newTransactions: ledger.added.length,
      },
      verdict: state,
    },
  });

  log.info(
    {
      shop: shopDomain,
      orderId,
      state,
      actions: actions.length,
      shopifyQuantity: verification.quantities.expectedTotal,
      metakockaQuantity: verification.quantities.actualTotal,
    },
    "Order reconciled",
  );

  return {
    kind: "reconciled",
    orderId,
    actions,
    inconsistent: !verification.ok,
  };
}

/**
 * The persisted allocations, in canonical form.
 *
 * Only for the order whose supply sources a person pinned by hand: no plan was
 * made this pass, and the classification still has to answer "where did every
 * Shopify unit go?" — an order nobody re-planned is not an order nobody has to
 * account for. A row with a source is managed; one without is unresolved, and
 * whatever the rows do not cover is added by `classifyQuantities` itself.
 */
async function persistedAllocations(
  orderId: string,
  lines: readonly CanonicalLine[],
): Promise<CanonicalAllocation[]> {
  const rows = await prisma.orderLine.findMany({
    where: { orderId },
    select: {
      shopifyLineItemId: true,
      allocations: {
        select: { supplySourceId: true, quantity: true, shopifyLocationId: true },
      },
    },
  });

  const known = new Set(lines.map((line) => line.shopifyLineItemId));

  return rows.flatMap((row) =>
    known.has(row.shopifyLineItemId)
      ? row.allocations.map((allocation) => ({
          shopifyLocationId: allocation.shopifyLocationId,
          supplySourceId: allocation.supplySourceId,
          disposition: allocation.supplySourceId
            ? ("managed" as const)
            : ("unresolved" as const),
          lines: [
            {
              shopifyLineItemId: row.shopifyLineItemId,
              quantity: allocation.quantity,
            },
          ],
        }))
      : [],
  );
}

/**
 * What each supply source should hold, from the allocations just persisted.
 *
 * Read back from the database rather than carried from the plan, deliberately:
 * the allocation is the thing the write path reads, so verifying against it
 * catches a plan that failed to persist as well as a plan that was wrong.
 */
async function desiredDocumentLines(
  orderId: string,
): Promise<Map<string, { sku: string; quantity: number }[]>> {
  const lines = await prisma.orderLine.findMany({
    where: { orderId },
    select: {
      sku: true,
      allocations: { select: { supplySourceId: true, quantity: true } },
    },
  });

  const bySource = new Map<string, { sku: string; quantity: number }[]>();

  for (const line of lines) {
    for (const allocation of line.allocations) {
      if (!allocation.supplySourceId) continue;
      if (allocation.quantity <= 0) continue;

      const target = bySource.get(allocation.supplySourceId) ?? [];
      const existing = target.find((entry) => entry.sku === line.sku);
      if (existing) existing.quantity += allocation.quantity;
      else target.push({ sku: line.sku, quantity: allocation.quantity });
      bySource.set(allocation.supplySourceId, target);
    }
  }

  return bySource;
}

// Re-exported for the tests that pin the planner's behaviour against real
// recorded document bodies rather than hand-built ones.
export { sameLines };
