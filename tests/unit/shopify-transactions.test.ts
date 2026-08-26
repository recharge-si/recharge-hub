import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { describe, expect, it, vi } from "vitest";

import {
  fetchOrderTransactions,
  parseWebhookTransactions,
} from "~/adapters/shopify/transactions";

/**
 * Reading Shopify's payment transactions (brief §15, §16).
 *
 * Two boundaries produce the same domain type — the Admin API's camelCase
 * money bags and the webhook's flat snake_case — because everything downstream
 * has to be unable to tell which path an order took. The tests pin the three
 * things that are easy to get wrong and impossible to notice later:
 *
 *  - **presentment money**, matching the rest of the order (§8.6). Reading the
 *    shop amount while the document is denominated in the presentment currency
 *    records a payment in the wrong money and still balances.
 *  - **the id, numeric**, because it is the ledger's uniqueness key and a GID
 *    would make every re-read look like a new transaction.
 *  - **the amount positive**, because direction is the `kind`'s job and a
 *    negative refund amount would net itself out to nothing.
 */

function fakeAdmin(result: unknown) {
  const graphql = vi.fn(
    async () =>
      new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  return { admin: { graphql } as unknown as AdminApiContext, graphql };
}

function node(input: {
  id: string;
  kind: string;
  status?: string;
  presentment?: string;
  shop?: string;
  gateway?: string | null;
  parent?: string | null;
}) {
  return {
    id: `gid://shopify/OrderTransaction/${input.id}`,
    kind: input.kind,
    status: input.status ?? "SUCCESS",
    gateway: input.gateway ?? "shopify_payments",
    processedAt: "2026-01-05T09:30:00Z",
    errorCode: null,
    amountSet: {
      presentmentMoney: {
        amount: input.presentment ?? "100.00",
        currencyCode: "EUR",
      },
      shopMoney: { amount: input.shop ?? "95.00", currencyCode: "USD" },
    },
    parentTransaction: input.parent
      ? { id: `gid://shopify/OrderTransaction/${input.parent}` }
      : null,
  };
}

describe("reading transactions from the Admin API", () => {
  it("maps a capture into the ledger's own vocabulary", async () => {
    const { admin } = fakeAdmin({
      data: {
        order: {
          id: "gid://shopify/Order/1",
          transactions: [node({ id: "998", kind: "CAPTURE", parent: "997" })],
        },
      },
    });

    const result = await fetchOrderTransactions(admin, "1");

    expect(result.transactions).toEqual([
      {
        shopifyTransactionId: "998",
        kind: "capture",
        status: "success",
        // Presentment, not the 95.00 shop amount.
        amountMinor: 10_000,
        currency: "EUR",
        gateway: "shopify_payments",
        processedAt: new Date("2026-01-05T09:30:00Z"),
        parentTransactionId: "997",
      },
    ]);
    expect(result.possiblyTruncated).toBe(false);
  });

  it("keeps a refund's amount positive", async () => {
    const { admin } = fakeAdmin({
      data: {
        order: {
          id: "gid://shopify/Order/1",
          transactions: [
            node({ id: "1", kind: "REFUND", presentment: "-50.00" }),
          ],
        },
      },
    });

    const [refund] = (await fetchOrderTransactions(admin, "1")).transactions;
    expect(refund?.kind).toBe("refund");
    expect(refund?.amountMinor).toBe(5_000);
  });

  it("keeps a failed transaction rather than dropping it", async () => {
    // It is the explanation for an order that looks like it should have been
    // paid and was not, so the ledger carries it and the arithmetic ignores it.
    const { admin } = fakeAdmin({
      data: {
        order: {
          id: "gid://shopify/Order/1",
          transactions: [node({ id: "1", kind: "SALE", status: "FAILURE" })],
        },
      },
    });

    const [failed] = (await fetchOrderTransactions(admin, "1")).transactions;
    expect(failed?.status).toBe("failure");
  });

  it("returns an empty ledger for an order Shopify no longer has", async () => {
    const { admin } = fakeAdmin({ data: { order: null } });
    expect((await fetchOrderTransactions(admin, "1")).transactions).toEqual([]);
  });

  it("says so when the ledger may be short rather than reporting a total", async () => {
    /*
     * A total computed from a truncated ledger understates what the customer
     * paid, and nothing downstream could tell. The caller raises instead.
     */
    const { admin } = fakeAdmin({
      data: {
        order: {
          id: "gid://shopify/Order/1",
          transactions: Array.from({ length: 100 }, (_, index) =>
            node({ id: String(index), kind: "CAPTURE" }),
          ),
        },
      },
    });

    expect((await fetchOrderTransactions(admin, "1")).possiblyTruncated).toBe(
      true,
    );
  });
});

describe("reading transactions from a webhook payload", () => {
  it("produces exactly the same domain shape as the Admin API does", () => {
    const parsed = parseWebhookTransactions({
      transactions: [
        {
          id: 998,
          kind: "capture",
          status: "success",
          gateway: "bank_deposit",
          processed_at: "2026-01-05T09:30:00Z",
          amount: "100.00",
          currency: "EUR",
          parent_id: 997,
        },
      ],
    });

    expect(parsed).toEqual([
      {
        shopifyTransactionId: "998",
        kind: "capture",
        status: "success",
        amountMinor: 10_000,
        currency: "EUR",
        gateway: "bank_deposit",
        processedAt: new Date("2026-01-05T09:30:00Z"),
        parentTransactionId: "997",
      },
    ]);
  });

  it("returns nothing for a payload with no transactions", () => {
    expect(parseWebhookTransactions({ id: 1 })).toEqual([]);
    expect(parseWebhookTransactions(null)).toEqual([]);
    expect(parseWebhookTransactions("not an object")).toEqual([]);
  });
});
