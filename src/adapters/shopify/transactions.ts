import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import { toMinorUnits } from "~/adapters/metakocka/values";
import { numericId } from "~/adapters/shopify/orders";
import {
  toTransactionKind,
  toTransactionStatus,
  type OrderTransaction,
} from "~/domain/payments/transactions";

/**
 * The individual payment movements on one Shopify order (CLAUDE.md §8.7).
 *
 * Everything about payments in this app used to come from
 * `financial_status`, which is a display summary: it says "paid" without saying
 * how much or when, "partially_paid" without saying how far, and it says
 * nothing at all about the difference between a card hold and money in the
 * bank. An ERP filled in from that summary is filled in from a rounding.
 *
 * These are the underlying facts. Each one has a Shopify id, which becomes the
 * ledger's identity and therefore the reason a redelivered webhook or a retried
 * job can never record the same payment twice.
 *
 * Two boundary decisions:
 *
 *  - **Presentment money, like everything else on the order.** §8.6 files the
 *    currency the customer was charged and never converts; reading the shop
 *    amount here while the document is denominated in the presentment currency
 *    would record a payment in the wrong money and still balance.
 *  - **The amount stays positive.** Direction is the transaction's `kind`, and
 *    the domain treats it as such. A refund arriving with a negative amount
 *    *and* a refund kind would net itself out to nothing.
 */

/**
 * How many transactions one order can have before this stops reading them.
 *
 * `Order.transactions` is a plain list with a `first` argument rather than a
 * paginated connection, so there is no cursor to follow — the cap is the read.
 * A hundred covers instalment plans, split tenders and a long refund history
 * many times over; an order past it is reported rather than silently truncated,
 * because a truncated ledger understates what the customer paid.
 */
const TRANSACTION_LIMIT = 100;

const ORDER_TRANSACTIONS_QUERY = `#graphql
  query OrchestratorOrderTransactions($id: ID!) {
    order(id: $id) {
      id
      transactions(first: ${TRANSACTION_LIMIT}) {
        id
        kind
        status
        gateway
        processedAt
        errorCode
        amountSet {
          presentmentMoney { amount currencyCode }
          shopMoney { amount currencyCode }
        }
        parentTransaction { id }
      }
    }
  }
`;

const moneyBag = z
  .object({
    presentmentMoney: z
      .object({ amount: z.string(), currencyCode: z.string() })
      .nullish(),
    shopMoney: z
      .object({ amount: z.string(), currencyCode: z.string() })
      .nullish(),
  })
  .nullish();

const transactionNode = z.object({
  id: z.string(),
  kind: z.string().nullish(),
  status: z.string().nullish(),
  gateway: z.string().nullish(),
  processedAt: z.string().nullish(),
  errorCode: z.string().nullish(),
  amountSet: moneyBag,
  parentTransaction: z.object({ id: z.string() }).nullish(),
});

const orderTransactionsSchema = z.object({
  data: z.object({
    order: z
      .object({
        id: z.string(),
        transactions: z.array(transactionNode),
      })
      .nullable(),
  }),
});

export interface OrderTransactionsResult {
  transactions: OrderTransaction[];
  /**
   * True when Shopify returned exactly the cap.
   *
   * Reported rather than ignored: the ledger may be incomplete, and a payment
   * total computed from an incomplete ledger understates what was received.
   * The caller refuses to write payments and raises instead.
   */
  possiblyTruncated: boolean;
}

/**
 * Every transaction on one order, newest last.
 *
 * Returns an empty ledger — not null — for an order Shopify no longer has. An
 * order that has been deleted has no payments to represent, and the caller's
 * existing "order is gone" path is a better place to notice than a second null
 * check here.
 */
export async function fetchOrderTransactions(
  admin: AdminApiContext,
  shopifyOrderId: string,
): Promise<OrderTransactionsResult> {
  const response = await admin.graphql(ORDER_TRANSACTIONS_QUERY, {
    variables: { id: `gid://shopify/Order/${shopifyOrderId}` },
  });

  const parsed = orderTransactionsSchema.parse(await response.json());
  const nodes = parsed.data.order?.transactions ?? [];

  return {
    transactions: nodes.map((node) => ({
      shopifyTransactionId: numericId(node.id),
      kind: toTransactionKind(node.kind),
      status: toTransactionStatus(node.status),
      amountMinor: Math.abs(
        toMinorUnits(
          node.amountSet?.presentmentMoney?.amount ??
            node.amountSet?.shopMoney?.amount ??
            "0",
        ),
      ),
      currency:
        node.amountSet?.presentmentMoney?.currencyCode ??
        node.amountSet?.shopMoney?.currencyCode ??
        "",
      gateway: node.gateway ?? null,
      processedAt: node.processedAt ? new Date(node.processedAt) : null,
      parentTransactionId: node.parentTransaction
        ? numericId(node.parentTransaction.id)
        : null,
    })),
    possiblyTruncated: nodes.length >= TRANSACTION_LIMIT,
  };
}

/**
 * The same mapping, for a webhook payload rather than an Admin API read.
 *
 * `orders/paid` and `refunds/create` both carry transactions inline, and using
 * them saves a round trip on the common path. The shapes differ — the REST-
 * style webhook sends snake_case and flat amounts — so this is a second
 * boundary rather than a reuse of the query parser, and it produces exactly the
 * same domain type so nothing downstream can tell which path an order took.
 */
const webhookTransactionSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  kind: z.string().nullish(),
  status: z.string().nullish(),
  gateway: z.string().nullish(),
  processed_at: z.string().nullish(),
  amount: z.union([z.string(), z.number()]).transform(String).nullish(),
  currency: z.string().nullish(),
  parent_id: z.union([z.string(), z.number()]).transform(String).nullish(),
});

export function parseWebhookTransactions(payload: unknown): OrderTransaction[] {
  const parsed = z
    .object({ transactions: z.array(webhookTransactionSchema).default([]) })
    .safeParse(payload);
  if (!parsed.success) return [];

  return parsed.data.transactions.map((transaction) => ({
    shopifyTransactionId: transaction.id,
    kind: toTransactionKind(transaction.kind),
    status: toTransactionStatus(transaction.status),
    amountMinor: Math.abs(toMinorUnits(transaction.amount ?? "0")),
    currency: transaction.currency ?? "",
    gateway: transaction.gateway ?? null,
    processedAt: transaction.processed_at
      ? new Date(transaction.processed_at)
      : null,
    parentTransactionId: transaction.parent_id ?? null,
  }));
}
