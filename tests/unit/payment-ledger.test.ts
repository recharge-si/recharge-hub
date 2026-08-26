import { describe, expect, it } from "vitest";

import {
  isOpenAuthorization,
  isSettledReceipt,
  isSettledRefund,
  sortTransactions,
  summarisePayments,
  toTransactionKind,
  toTransactionStatus,
  type OrderTransaction,
} from "~/domain/payments/transactions";

/**
 * The payment ledger (brief §15–§18, §22, §24).
 *
 * Every scenario the brief lists, asserted as arithmetic rather than as a
 * status. The property being protected throughout: **what the connector
 * believes was received equals the sum of the successful sale and capture
 * transactions, less the successful refunds** — never Shopify's display
 * `financial_status`, which cannot express "€150 of €300".
 */

let sequence = 0;

function tx(input: Partial<OrderTransaction> = {}): OrderTransaction {
  sequence += 1;
  return {
    shopifyTransactionId: `t${sequence}`,
    kind: "sale",
    status: "success",
    amountMinor: 0,
    currency: "EUR",
    gateway: "shopify_payments",
    // Injected, never read from the clock: these are inputs to pure functions.
    processedAt: new Date(Date.UTC(2026, 0, 1, 12, 0, sequence)),
    parentTransactionId: null,
    ...input,
  };
}

const TOTAL = 50_000; // €500.00

describe("what counts as money", () => {
  it("counts a sale and a capture, and nothing else", () => {
    expect(isSettledReceipt(tx({ kind: "sale" }))).toBe(true);
    expect(isSettledReceipt(tx({ kind: "capture" }))).toBe(true);
    expect(isSettledReceipt(tx({ kind: "authorization" }))).toBe(false);
    expect(isSettledReceipt(tx({ kind: "void" }))).toBe(false);
    expect(isSettledReceipt(tx({ kind: "refund" }))).toBe(false);
    expect(isSettledReceipt(tx({ kind: "change" }))).toBe(false);
  });

  it("counts only successful transactions", () => {
    for (const status of ["pending", "failure", "error", "awaiting_response", "unknown"] as const) {
      expect(isSettledReceipt(tx({ kind: "sale", status }))).toBe(false);
      expect(isSettledRefund(tx({ kind: "refund", status }))).toBe(false);
    }
  });

  it("reads Shopify's enum in either case and does not guess at new members", () => {
    expect(toTransactionKind("SALE")).toBe("sale");
    expect(toTransactionKind("Capture")).toBe("capture");
    // A hold under either name.
    expect(toTransactionKind("EMV_AUTHORIZATION")).toBe("authorization");
    expect(toTransactionKind("SOMETHING_NEW")).toBe("other");
    expect(toTransactionKind(null)).toBe("other");

    expect(toTransactionStatus("SUCCESS")).toBe("success");
    expect(toTransactionStatus("something")).toBe("unknown");
  });
});

describe("an unpaid order", () => {
  it("is unpaid with nothing outstanding invented", () => {
    const summary = summarisePayments([], TOTAL);
    expect(summary).toMatchObject({
      grossReceivedMinor: 0,
      refundedMinor: 0,
      netPaidMinor: 0,
      outstandingMinor: TOTAL,
      state: "unpaid",
    });
  });
});

describe("an authorization only (§17)", () => {
  it("is not money", () => {
    /*
     * The rule the brief states outright: a hold on a card is not received
     * payment. Booking it would state income that has not happened, and the
     * capture may never come or may come for less.
     */
    const summary = summarisePayments(
      [tx({ kind: "authorization", amountMinor: 20_000 })],
      TOTAL,
    );

    expect(summary.grossReceivedMinor).toBe(0);
    expect(summary.netPaidMinor).toBe(0);
    expect(summary.outstandingMinor).toBe(TOTAL);
    expect(summary.authorizedMinor).toBe(20_000);
    expect(summary.state).toBe("authorized");
  });

  it("stops being an open hold once it is captured", () => {
    const authorization = tx({ kind: "authorization", amountMinor: 20_000 });
    const capture = tx({
      kind: "capture",
      amountMinor: 20_000,
      parentTransactionId: authorization.shopifyTransactionId,
    });

    const all = [authorization, capture];
    expect(isOpenAuthorization(authorization, all)).toBe(false);

    const summary = summarisePayments(all, 20_000);
    // Counted once, as the capture. Not twice, which is what would happen if
    // an authorization were treated as money and its capture added on top.
    expect(summary.grossReceivedMinor).toBe(20_000);
    expect(summary.state).toBe("paid");
  });

  it("stops being an open hold once it is voided", () => {
    const authorization = tx({ kind: "authorization", amountMinor: 20_000 });
    const voided = tx({
      kind: "void",
      amountMinor: 20_000,
      parentTransactionId: authorization.shopifyTransactionId,
    });

    const summary = summarisePayments([authorization, voided], TOTAL);
    expect(summary.authorizedMinor).toBe(0);
    expect(summary.state).toBe("unpaid");
  });
});

describe("partial payments (§18)", () => {
  it("walks the brief's example to the cent", () => {
    const first = tx({ kind: "capture", amountMinor: 10_000, gateway: "bank" });
    const second = tx({ kind: "capture", amountMinor: 20_000, gateway: "card" });
    const third = tx({ kind: "capture", amountMinor: 20_000, gateway: "card" });

    const afterFirst = summarisePayments([first], TOTAL);
    expect(afterFirst.netPaidMinor).toBe(10_000);
    expect(afterFirst.outstandingMinor).toBe(40_000);
    expect(afterFirst.state).toBe("partially_paid");

    const afterSecond = summarisePayments([first, second], TOTAL);
    expect(afterSecond.netPaidMinor).toBe(30_000);
    expect(afterSecond.outstandingMinor).toBe(20_000);
    expect(afterSecond.state).toBe("partially_paid");

    const afterThird = summarisePayments([first, second, third], TOTAL);
    expect(afterThird.netPaidMinor).toBe(50_000);
    expect(afterThird.outstandingMinor).toBe(0);
    expect(afterThird.state).toBe("paid");
  });

  it("keeps two captures as two receipts, not one merged figure", () => {
    const summary = summarisePayments(
      [
        tx({ kind: "capture", amountMinor: 10_000 }),
        tx({ kind: "capture", amountMinor: 5_000 }),
      ],
      30_000,
    );

    expect(summary.receiptCount).toBe(2);
    expect(summary.grossReceivedMinor).toBe(15_000);
    expect(summary.outstandingMinor).toBe(15_000);
    expect(summary.state).toBe("partially_paid");
  });

  it("handles several gateways on one order", () => {
    const summary = summarisePayments(
      [
        tx({ kind: "capture", amountMinor: 10_000, gateway: "bank_deposit" }),
        tx({ kind: "sale", amountMinor: 40_000, gateway: "paypal" }),
      ],
      TOTAL,
    );
    expect(summary.state).toBe("paid");
    expect(summary.netPaidMinor).toBe(TOTAL);
  });
});

describe("failed and voided transactions", () => {
  it("ignores a failed capture entirely", () => {
    const summary = summarisePayments(
      [
        tx({ kind: "capture", amountMinor: 50_000, status: "failure" }),
        tx({ kind: "capture", amountMinor: 50_000, status: "error" }),
      ],
      TOTAL,
    );
    expect(summary.grossReceivedMinor).toBe(0);
    expect(summary.state).toBe("unpaid");
  });

  it("ignores a pending transaction until it succeeds", () => {
    const pending = tx({ kind: "sale", amountMinor: 50_000, status: "pending" });
    expect(summarisePayments([pending], TOTAL).state).toBe("unpaid");

    // Shopify updates the same transaction id in place; the ledger upserts it.
    const settled = { ...pending, status: "success" as const };
    expect(summarisePayments([settled], TOTAL).state).toBe("paid");
  });
});

describe("refunds (§22)", () => {
  it("keeps the history: gross captured, refunded and net are three numbers", () => {
    /*
     * The brief's example, and the rule it protects: a refund is its own
     * movement, never a shrunken receipt. Rewriting the €300 capture as €250
     * would destroy the record of what was actually received.
     */
    const summary = summarisePayments(
      [
        tx({ kind: "capture", amountMinor: 30_000 }),
        tx({ kind: "refund", amountMinor: 5_000 }),
      ],
      30_000,
    );

    expect(summary.grossReceivedMinor).toBe(30_000);
    expect(summary.refundedMinor).toBe(5_000);
    expect(summary.netPaidMinor).toBe(25_000);
    expect(summary.state).toBe("partially_refunded");
  });

  it("adds up several refunds", () => {
    const summary = summarisePayments(
      [
        tx({ kind: "sale", amountMinor: 30_000 }),
        tx({ kind: "refund", amountMinor: 5_000 }),
        tx({ kind: "refund", amountMinor: 2_500 }),
      ],
      30_000,
    );

    expect(summary.refundedMinor).toBe(7_500);
    expect(summary.netPaidMinor).toBe(22_500);
    expect(summary.refundCount).toBe(2);
    expect(summary.state).toBe("partially_refunded");
  });

  it("reports a fully refunded order as refunded, not as unpaid", () => {
    const summary = summarisePayments(
      [
        tx({ kind: "sale", amountMinor: 30_000 }),
        tx({ kind: "refund", amountMinor: 30_000 }),
      ],
      30_000,
    );

    expect(summary.netPaidMinor).toBe(0);
    // "unpaid" would invite the app to chase money that came and went.
    expect(summary.state).toBe("refunded");
  });

  it("handles payment, refund, then another capture", () => {
    const summary = summarisePayments(
      [
        tx({ kind: "capture", amountMinor: 30_000 }),
        tx({ kind: "refund", amountMinor: 10_000 }),
        tx({ kind: "capture", amountMinor: 10_000 }),
      ],
      30_000,
    );

    expect(summary.grossReceivedMinor).toBe(40_000);
    expect(summary.refundedMinor).toBe(10_000);
    expect(summary.netPaidMinor).toBe(30_000);
    expect(summary.state).toBe("partially_refunded");
  });
});

describe("overpayment", () => {
  it("is called out rather than rounded down to paid", () => {
    const summary = summarisePayments(
      [tx({ kind: "sale", amountMinor: 60_000 })],
      TOTAL,
    );
    expect(summary.state).toBe("overpaid");
    expect(summary.outstandingMinor).toBe(0);
  });
});

describe("idempotence and stability", () => {
  it("gives the same answer however many times the same ledger is read", () => {
    /*
     * The reconciler re-reads a settled order every quarter of an hour. A
     * summary that drifted would rewrite an ERP document each time.
     */
    const ledger = [
      tx({ kind: "capture", amountMinor: 10_000 }),
      tx({ kind: "capture", amountMinor: 20_000 }),
      tx({ kind: "refund", amountMinor: 5_000 }),
    ];

    expect(summarisePayments(ledger, TOTAL)).toEqual(
      summarisePayments(ledger, TOTAL),
    );
  });

  it("is unaffected by the order the transactions arrive in", () => {
    // Webhooks are not promised in order, and the reconciler reads by page.
    const a = tx({ kind: "capture", amountMinor: 10_000 });
    const b = tx({ kind: "refund", amountMinor: 2_500 });
    const c = tx({ kind: "capture", amountMinor: 20_000 });

    expect(summarisePayments([a, b, c], TOTAL)).toEqual(
      summarisePayments([c, a, b], TOTAL),
    );
  });

  it("sorts by processed time then id, so a re-run produces one order", () => {
    const later = tx({
      shopifyTransactionId: "aaa",
      processedAt: new Date("2026-02-02T00:00:00Z"),
    });
    const earlier = tx({
      shopifyTransactionId: "zzz",
      processedAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(
      sortTransactions([later, earlier]).map((t) => t.shopifyTransactionId),
    ).toEqual(["zzz", "aaa"]);
  });
});
