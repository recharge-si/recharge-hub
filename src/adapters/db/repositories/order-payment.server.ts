import type { Prisma } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import type { OrderTransaction } from "~/domain/payments/transactions";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * The order payment ledger (CLAUDE.md §8.7).
 *
 * Every read and write of `order_payment` and `order_payment_application` goes
 * through here, filtered by shop like every other repository (§9).
 *
 * The one rule the whole ledger rests on: **a Shopify transaction id is the
 * identity of a payment.** `UNIQUE (shop_id, shopify_transaction_id)` is what
 * makes recording payments idempotent, and it is the reason a redelivered
 * `orders/paid`, a reconciliation pass over an order settled last week and a
 * retried job all converge on the same rows instead of stacking receipts.
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

export interface LedgerRow {
  id: string;
  shopifyTransactionId: string;
  kind: OrderTransaction["kind"];
  status: OrderTransaction["status"];
  amountMinor: number;
  currency: string;
  gateway: string | null;
  processedAt: Date | null;
  parentTransactionId: string | null;
  metakockaPaymentType: string | null;
}

export interface LedgerSyncResult {
  rows: LedgerRow[];
  /** Transactions this pass had never seen before. For the audit trail. */
  added: string[];
  /** Transactions whose status or amount moved since last time. */
  changed: string[];
}

/**
 * Brings the stored ledger in line with what Shopify currently reports.
 *
 * An upsert per transaction rather than a delete-and-rewrite, and the
 * difference matters twice. It keeps `metakocka_payment_type` — the resolved
 * type is a decision, not a copy of Shopify — and it keeps
 * `order_payment_application`, which is what the ERP was actually told; a
 * rewrite would cascade both away and re-derive them, so a gateway remapped
 * last month would silently re-file a payment recorded before the change.
 *
 * A transaction that Shopify has stopped reporting is **left in place**, not
 * deleted. Shopify does not retract transactions, so its absence means a
 * truncated read or a permission change far more often than it means the money
 * never moved — and deleting the row would delete the record of what the ERP
 * was told about it.
 */
export async function syncLedger(
  principal: Principal,
  orderId: string,
  transactions: readonly OrderTransaction[],
): Promise<LedgerSyncResult> {
  const shopId = await shopIdFor(principal);

  const existing = await prisma.orderPayment.findMany({
    where: { shopId, orderId },
  });
  const bySumId = new Map(
    existing.map((row) => [row.shopifyTransactionId, row] as const),
  );

  const added: string[] = [];
  const changed: string[] = [];

  for (const transaction of transactions) {
    const current = bySumId.get(transaction.shopifyTransactionId);

    const data = {
      kind: transaction.kind,
      status: transaction.status,
      amountMinor: transaction.amountMinor,
      currency: transaction.currency,
      gateway: transaction.gateway,
      processedAt: transaction.processedAt,
      parentTransactionId: transaction.parentTransactionId,
    };

    if (!current) {
      added.push(transaction.shopifyTransactionId);
    } else if (
      current.status !== data.status ||
      current.amountMinor !== data.amountMinor ||
      current.kind !== data.kind
    ) {
      // A pending transaction that settled, or a status Shopify corrected.
      changed.push(transaction.shopifyTransactionId);
    }

    await prisma.orderPayment.upsert({
      where: {
        shopId_shopifyTransactionId: {
          shopId,
          shopifyTransactionId: transaction.shopifyTransactionId,
        },
      },
      create: {
        shopId,
        orderId,
        shopifyTransactionId: transaction.shopifyTransactionId,
        ...data,
      },
      update: data,
    });
  }

  const rows = await prisma.orderPayment.findMany({
    where: { shopId, orderId },
    orderBy: [{ processedAt: "asc" }, { shopifyTransactionId: "asc" }],
  });

  return {
    rows: rows.map((row) => ({
      id: row.id,
      shopifyTransactionId: row.shopifyTransactionId,
      kind: row.kind,
      status: row.status,
      amountMinor: row.amountMinor,
      currency: row.currency,
      gateway: row.gateway,
      processedAt: row.processedAt,
      parentTransactionId: row.parentTransactionId,
      metakockaPaymentType: row.metakockaPaymentType,
    })),
    added,
    changed,
  };
}

/** The stored ledger, without asking Shopify. */
export async function listLedger(
  principal: Principal,
  orderId: string,
): Promise<LedgerRow[]> {
  const rows = await prisma.orderPayment.findMany({
    where: { orderId, shop: { domain: shopDomainOf(principal) } },
    orderBy: [{ processedAt: "asc" }, { shopifyTransactionId: "asc" }],
  });

  return rows.map((row) => ({
    id: row.id,
    shopifyTransactionId: row.shopifyTransactionId,
    kind: row.kind,
    status: row.status,
    amountMinor: row.amountMinor,
    currency: row.currency,
    gateway: row.gateway,
    processedAt: row.processedAt,
    parentTransactionId: row.parentTransactionId,
    metakockaPaymentType: row.metakockaPaymentType,
  }));
}

/** Records which MetaKocka payment type a receipt resolved to. */
export async function recordPaymentTypes(
  entries: readonly { orderPaymentId: string; paymentType: string }[],
): Promise<void> {
  for (const entry of entries) {
    await prisma.orderPayment.update({
      where: { id: entry.orderPaymentId },
      data: { metakockaPaymentType: entry.paymentType },
    });
  }
}

export interface ApplicationRecord {
  orderPaymentId: string;
  documentId: string;
  amountMinor: number;
  paymentType: string;
  appliedAt: Date | null;
}

/**
 * Records what each document was told, for one document at a time.
 *
 * Scoped to a document rather than to the whole order because that is the unit
 * that actually succeeded or failed: a split order can have one document
 * accepted and the next refused, and writing the whole order's applications
 * after a partial failure would claim MetaKocka holds payments it does not.
 *
 * Applications for the document that are not in `entries` are removed, which is
 * how a receipt moving to another document stops being recorded against this
 * one. That is a record of an intention, not of ERP state — the ERP state was
 * changed by the replacement `mark_paid` in the same pass.
 */
export async function replaceApplicationsForDocument(
  documentId: string,
  entries: readonly ApplicationRecord[],
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.orderPaymentApplication.deleteMany({
      where: {
        documentId,
        ...(entries.length > 0
          ? {
              orderPaymentId: {
                notIn: entries.map((entry) => entry.orderPaymentId),
              },
            }
          : {}),
      },
    });

    for (const entry of entries) {
      await tx.orderPaymentApplication.upsert({
        where: {
          orderPaymentId_documentId: {
            orderPaymentId: entry.orderPaymentId,
            documentId,
          },
        },
        create: {
          orderPaymentId: entry.orderPaymentId,
          documentId,
          amountMinor: entry.amountMinor,
          paymentType: entry.paymentType,
          appliedAt: entry.appliedAt,
        },
        update: {
          amountMinor: entry.amountMinor,
          paymentType: entry.paymentType,
          appliedAt: entry.appliedAt,
        },
      });
    }
  });
}

/**
 * What this app believes MetaKocka currently holds in payments for one order.
 *
 * The `represented` half of the §24 invariant: successful receipts less
 * successful refunds against what the connector has actually recorded.
 * Deliberately reads the applications rather than
 * `metakocka_document.payment_amount_minor`, because the applications say which
 * transaction each share came from and the column only says how much.
 */
export async function representedPaymentTotal(
  principal: Principal,
  orderId: string,
): Promise<number> {
  const applications = await prisma.orderPaymentApplication.findMany({
    where: {
      appliedAt: { not: null },
      document: { orderId, shop: { domain: shopDomainOf(principal) } },
    },
    select: { amountMinor: true },
  });

  return applications.reduce(
    (total, application) => total + application.amountMinor,
    0,
  );
}

/** The order-level payment summary, materialised for the screens (§2.5). */
export async function recordPaymentSummary(
  orderId: string,
  input: {
    state: Prisma.OrderUpdateInput["paymentState"];
    grossReceivedMinor: number;
    refundedMinor: number;
    netPaidMinor: number;
    outstandingMinor: number;
    readAt: Date;
  },
): Promise<void> {
  await prisma.order.update({
    where: { id: orderId },
    data: {
      paymentState: input.state,
      grossReceivedMinor: input.grossReceivedMinor,
      refundedMinor: input.refundedMinor,
      netPaidMinor: input.netPaidMinor,
      outstandingMinor: input.outstandingMinor,
      paymentsReadAt: input.readAt,
    },
  });
}
