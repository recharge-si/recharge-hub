import { describe, expect, it } from "vitest";

import { buildSalesOrderBody } from "~/adapters/metakocka/documents";
import { splitOrderMoney } from "~/domain/money/split";
import {
  allocatePayments,
  allocationPreservesReceipts,
  allocatedTotalFor,
  type AllocatableReceipt,
  type PayableDocument,
} from "~/domain/payments/allocation";
import {
  summarisePayments,
  type OrderTransaction,
} from "~/domain/payments/transactions";

/**
 * The multi-document payment scenarios, end to end (verification pass §1).
 *
 * These run the whole payment chain the reconciler runs — the money split that
 * decides what each document is worth, the allocation that divides receipts
 * across them, and the body builder that turns one document's share into the
 * bytes MetaKocka receives — and assert the numbers a merchant would see.
 *
 * **What "each document receives the complete `mark_paid` array" means**, since
 * the phrase is ambiguous and the ambiguity is dangerous:
 *
 *   *complete* qualifies **the set of payment applications belonging to that
 *   one document**, not the order's ledger.
 *
 * So for a €300 order split into a €100 and a €200 document, MK-A's array is
 * `[€100]` and MK-B's is `[€200]`. Neither ever contains €300. "Complete" means
 * *nothing is left out of that document's own set* — which matters because
 * MetaKocka replaces rather than appends: sending one payment at a time would
 * erase the previous one, so the document's whole share has to go every time.
 *
 * The alternative reading — every document receives the order's whole ledger —
 * is the €600-in-the-books bug, and the first test here exists to make it
 * impossible to reintroduce silently.
 */

/* -------------------------------------------------------------------------- */

const SOURCE_A = "src-a";
const SOURCE_B = "src-b";

/** The €100 / €200 split from the brief, through the real money split. */
function shares(aMinor: number, bMinor: number, orderTotalMinor: number) {
  return splitOrderMoney({
    perSource: [
      { sourceId: SOURCE_A, sourceCode: "A", kind: "own", lineTotalMinor: aMinor },
      { sourceId: SOURCE_B, sourceCode: "B", kind: "own", lineTotalMinor: bMinor },
    ],
    orderTotalMinor,
    shippingMinor: 0,
    discountMinor: 0,
  });
}

function payable(
  share: ReturnType<typeof shares>[number],
  retired = false,
): PayableDocument {
  return {
    documentKey: share.sourceId,
    countCode: `SH-1050-${share.sourceCode}`,
    isPrimary: share.isPrimary,
    valueMinor: share.totalMinor,
    retired,
  };
}

let sequence = 0;
function capture(amountMinor: number, at = "2026-01-05T09:00:00Z"): OrderTransaction {
  sequence += 1;
  return {
    shopifyTransactionId: `t${sequence}`,
    kind: "capture",
    status: "success",
    amountMinor,
    currency: "EUR",
    gateway: "shopify_payments",
    processedAt: new Date(at),
    parentTransactionId: null,
  };
}

function refund(amountMinor: number, at = "2026-02-01T09:00:00Z"): OrderTransaction {
  sequence += 1;
  return {
    shopifyTransactionId: `t${sequence}`,
    kind: "refund",
    status: "success",
    amountMinor,
    currency: "EUR",
    gateway: "shopify_payments",
    processedAt: new Date(at),
    parentTransactionId: null,
  };
}

function receiptsOf(transactions: OrderTransaction[]): AllocatableReceipt[] {
  return transactions
    .filter(
      (transaction) =>
        transaction.status === "success" &&
        (transaction.kind === "capture" || transaction.kind === "sale"),
    )
    .map((transaction) => ({
      shopifyTransactionId: transaction.shopifyTransactionId,
      amountMinor: transaction.amountMinor,
      gateway: transaction.gateway,
      processedAt: transaction.processedAt,
    }));
}

/** The bytes one document would receive, from its own allocated share. */
function markPaidFor(
  documents: PayableDocument[],
  transactions: OrderTransaction[],
  documentKey: string,
) {
  const receipts = receiptsOf(transactions);
  const result = allocatePayments({
    documents,
    receipts,
    strategy: "proportional",
  });

  expect(allocationPreservesReceipts({ receipts, result }).ok).toBe(true);

  const body = buildSalesOrderBody({
    countCode: `SH-1050-${documentKey}`,
    buyerOrder: "SH-1050",
    docDate: new Date("2026-01-05T09:00:00Z"),
    currencyCode: "EUR",
    partner: { customer: "Ana Novak" },
    lines: [
      { code: "SKU-A", amount: 1, priceWithTaxMinor: 10_000, taxFactor: "0.22" },
    ],
    payments: result.entries
      .filter((entry) => entry.documentKey === documentKey)
      .map((entry) => ({
        paymentType: "TRR",
        paidAt: entry.processedAt ?? new Date("2026-01-05T09:00:00Z"),
        amountMinor: entry.amountMinor,
      })),
  });

  return (body as { mark_paid?: { amount: string }[] }).mark_paid;
}

/* -------------------------------------------------------------------------- */

describe("€300 order, €100 and €200 documents, one €300 capture", () => {
  const split = shares(10_000, 20_000, 30_000);
  const documents = split.map((share) => payable(share));
  const transactions = [capture(30_000)];

  it("gives each document its own value and nothing more", () => {
    const receipts = receiptsOf(transactions);
    const result = allocatePayments({
      documents,
      receipts,
      strategy: "proportional",
    });

    expect(allocatedTotalFor(result.entries, SOURCE_A)).toBe(10_000);
    expect(allocatedTotalFor(result.entries, SOURCE_B)).toBe(20_000);
  });

  it("puts €100 in MK-A's mark_paid, never €300", () => {
    /*
     * The exact bytes. This is the assertion that pins what "the complete
     * mark_paid array" means: complete *for this document*.
     */
    expect(markPaidFor(documents, transactions, SOURCE_A)).toEqual([
      { payment_type: "TRR", date: "05.01.2026", amount: "100.00" },
    ]);
  });

  it("puts €200 in MK-B's mark_paid, never €300", () => {
    expect(markPaidFor(documents, transactions, SOURCE_B)).toEqual([
      { payment_type: "TRR", date: "05.01.2026", amount: "200.00" },
    ]);
  });

  it("sums to €300 across the ERP, not €600", () => {
    const a = markPaidFor(documents, transactions, SOURCE_A) ?? [];
    const b = markPaidFor(documents, transactions, SOURCE_B) ?? [];

    const total = [...a, ...b].reduce(
      (sum, entry) => sum + Math.round(Number(entry.amount) * 100),
      0,
    );

    expect(total).toBe(30_000);
    expect(total).not.toBe(60_000);
  });
});

describe("a €150 partial payment on the same €300 order", () => {
  const split = shares(10_000, 20_000, 30_000);
  const documents = split.map((share) => payable(share));
  const transactions = [capture(15_000)];

  it("divides it by document value, not by what each document is owed", () => {
    const receipts = receiptsOf(transactions);
    const result = allocatePayments({
      documents,
      receipts,
      strategy: "proportional",
    });

    // 1:2 by value, so 50.00 and 100.00.
    expect(allocatedTotalFor(result.entries, SOURCE_A)).toBe(5_000);
    expect(allocatedTotalFor(result.entries, SOURCE_B)).toBe(10_000);
    expect(allocationPreservesReceipts({ receipts, result }).ok).toBe(true);
  });

  it("leaves the order partly paid with the right outstanding balance", () => {
    const summary = summarisePayments(transactions, 30_000);
    expect(summary.state).toBe("partially_paid");
    expect(summary.outstandingMinor).toBe(15_000);
  });

  it("writes a half-sized entry to each document", () => {
    expect(markPaidFor(documents, transactions, SOURCE_A)).toEqual([
      { payment_type: "TRR", date: "05.01.2026", amount: "50.00" },
    ]);
    expect(markPaidFor(documents, transactions, SOURCE_B)).toEqual([
      { payment_type: "TRR", date: "05.01.2026", amount: "100.00" },
    ]);
  });
});

describe("a second partial payment arriving later", () => {
  const split = shares(10_000, 20_000, 30_000);
  const documents = split.map((share) => payable(share));

  const first = capture(15_000, "2026-01-05T09:00:00Z");
  const second = capture(15_000, "2026-01-20T09:00:00Z");

  it("adds an entry rather than replacing the first", () => {
    /*
     * The whole reason the complete set is sent every time. MetaKocka replaces
     * `mark_paid` on an update ([verified] 2026-08-26), so sending only the new
     * capture would erase the first — which is precisely why the old one-shot
     * `mark_paid` path could never record a second payment at all.
     */
    const after = markPaidFor(documents, [first, second], SOURCE_A);

    expect(after).toEqual([
      { payment_type: "TRR", date: "05.01.2026", amount: "50.00" },
      { payment_type: "TRR", date: "20.01.2026", amount: "50.00" },
    ]);
  });

  it("settles the order exactly, with no cent invented or lost", () => {
    const receipts = receiptsOf([first, second]);
    const result = allocatePayments({
      documents,
      receipts,
      strategy: "proportional",
    });

    expect(
      result.entries.reduce((sum, entry) => sum + entry.amountMinor, 0),
    ).toBe(30_000);
    expect(summarisePayments([first, second], 30_000).state).toBe("paid");
  });

  it("is unchanged by reconciling again with the same ledger", () => {
    // Idempotence at the level that matters: identical bytes mean the write
    // path compares them equal and sends nothing.
    expect(JSON.stringify(markPaidFor(documents, [first, second], SOURCE_A))).toBe(
      JSON.stringify(markPaidFor(documents, [first, second], SOURCE_A)),
    );
  });
});

describe("a refund after several payments", () => {
  const split = shares(10_000, 20_000, 30_000);
  const documents = split.map((share) => payable(share));

  const first = capture(10_000, "2026-01-05T09:00:00Z");
  const second = capture(20_000, "2026-01-10T09:00:00Z");
  const back = refund(5_000);

  it("nets in the ledger without touching what the documents record", () => {
    /*
     * The rule the brief is emphatic about: historical received payments are
     * never rewritten. MetaKocka goes on recording the €300 that actually
     * arrived; the €50 back is a credit note there, and a net figure here.
     */
    const summary = summarisePayments([first, second, back], 30_000);
    expect(summary.grossReceivedMinor).toBe(30_000);
    expect(summary.refundedMinor).toBe(5_000);
    expect(summary.netPaidMinor).toBe(25_000);
    expect(summary.state).toBe("partially_refunded");

    const receipts = receiptsOf([first, second, back]);
    const result = allocatePayments({
      documents,
      receipts,
      strategy: "proportional",
    });

    // Still the full receipts, undiminished.
    expect(
      result.entries.reduce((sum, entry) => sum + entry.amountMinor, 0),
    ).toBe(30_000);
  });

  it("does not shrink a document's entries to represent the refund", () => {
    const before = markPaidFor(documents, [first, second], SOURCE_B);
    const after = markPaidFor(documents, [first, second, back], SOURCE_B);
    expect(after).toEqual(before);
  });
});

describe("warehouse redistribution after the money arrived", () => {
  /*
   * The scenario that used to record an order twice: a paid order whose line
   * moves to another warehouse. The payment must follow the goods — not stay,
   * not duplicate, and not be recreated as a new receipt.
   */
  const paid = [capture(30_000)];

  it("moves the whole payment when the whole order moves", () => {
    const before = shares(30_000, 0, 30_000).map((share) => payable(share));
    expect(allocatedTotalFor(
      allocatePayments({
        documents: before,
        receipts: receiptsOf(paid),
        strategy: "proportional",
      }).entries,
      SOURCE_A,
    )).toBe(30_000);

    // A now holds nothing and is retired; B holds everything.
    const after = [
      payable(shares(0, 30_000, 30_000)[0]!, true),
      payable(shares(0, 30_000, 30_000)[1]!),
    ];

    const receipts = receiptsOf(paid);
    const result = allocatePayments({
      documents: after,
      receipts,
      strategy: "proportional",
    });

    expect(allocatedTotalFor(result.entries, SOURCE_A)).toBe(0);
    expect(allocatedTotalFor(result.entries, SOURCE_B)).toBe(30_000);
    // Not 60,000: the money exists once, wherever the goods are.
    expect(
      result.entries.reduce((sum, entry) => sum + entry.amountMinor, 0),
    ).toBe(30_000);
  });

  it("re-divides when only part of the order moves", () => {
    // 300.00 order, was all at A, now 100.00 at A and 200.00 at B.
    const after = shares(10_000, 20_000, 30_000).map((share) => payable(share));
    const receipts = receiptsOf(paid);
    const result = allocatePayments({
      documents: after,
      receipts,
      strategy: "proportional",
    });

    expect(allocatedTotalFor(result.entries, SOURCE_A)).toBe(10_000);
    expect(allocatedTotalFor(result.entries, SOURCE_B)).toBe(20_000);
    expect(
      result.entries.reduce((sum, entry) => sum + entry.amountMinor, 0),
    ).toBe(30_000);
  });

  it("keeps the same Shopify transaction ids throughout", () => {
    /*
     * Money is never "recreated" by a move. The applications point at the same
     * ledger rows before and after, which is what makes the history survive a
     * warehouse change — and what stops a move looking like a new payment.
     */
    const before = allocatePayments({
      documents: shares(30_000, 0, 30_000).map((share) => payable(share)),
      receipts: receiptsOf(paid),
      strategy: "proportional",
    });
    const after = allocatePayments({
      documents: shares(10_000, 20_000, 30_000).map((share) => payable(share)),
      receipts: receiptsOf(paid),
      strategy: "proportional",
    });

    expect(new Set(before.entries.map((e) => e.shopifyTransactionId))).toEqual(
      new Set(after.entries.map((e) => e.shopifyTransactionId)),
    );
  });

  it("clears the emptied document rather than leaving its payment behind", () => {
    /*
     * The other half, and the one the live probe corrected. A retired document
     * gets an empty allocated set — and an empty set must reach MetaKocka as a
     * zero entry, because [verified] an empty `mark_paid` array changes nothing
     * at all. `clearedPayments` handles that; here we assert the allocation
     * really does leave the document with nothing to send.
     */
    const after = [
      payable(shares(0, 30_000, 30_000)[0]!, true),
      payable(shares(0, 30_000, 30_000)[1]!),
    ];

    const result = allocatePayments({
      documents: after,
      receipts: receiptsOf(paid),
      strategy: "proportional",
    });

    expect(
      result.entries.filter((entry) => entry.documentKey === SOURCE_A),
    ).toEqual([]);
  });
});
