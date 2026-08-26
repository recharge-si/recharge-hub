import { describe, expect, it } from "vitest";

import {
  allocatePayments,
  allocatedTotalFor,
  allocationPreservesReceipts,
  type AllocatableReceipt,
  type PayableDocument,
} from "~/domain/payments/allocation";

/**
 * Dividing one Shopify payment across several MetaKocka sales orders
 * (brief §20, §21).
 *
 * The failure being prevented is worth stating as arithmetic, because it is
 * invisible on any single document: a €300 order split into a €100 and a €200
 * sales order, paid once for €300, must not record €300 against each. That is
 * €600 in the merchant's books for €300 of trade, and each document on its own
 * looks perfectly reasonable.
 *
 * So the test that matters most in this file is the last one in each group:
 * **the amounts allocated from one receipt sum to exactly that receipt.**
 */

const A: PayableDocument = {
  documentKey: "source-a",
  countCode: "SH-1050-A",
  isPrimary: true,
  valueMinor: 10_000,
  retired: false,
};

const B: PayableDocument = {
  documentKey: "source-b",
  countCode: "SH-1050-B",
  isPrimary: false,
  valueMinor: 20_000,
  retired: false,
};

function receipt(
  id: string,
  amountMinor: number,
  processedAt = new Date("2026-01-01T10:00:00Z"),
): AllocatableReceipt {
  return { shopifyTransactionId: id, amountMinor, gateway: "card", processedAt };
}

function expectPreserved(
  receipts: AllocatableReceipt[],
  result: ReturnType<typeof allocatePayments>,
) {
  expect(allocationPreservesReceipts({ receipts, result })).toEqual({
    ok: true,
    drift: [],
  });
}

describe("one payment, one document", () => {
  it("records the whole payment once", () => {
    const receipts = [receipt("t1", 20_900)];
    const result = allocatePayments({
      documents: [A],
      receipts,
      strategy: "proportional",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      documentKey: "source-a",
      amountMinor: 20_900,
    });
    expectPreserved(receipts, result);
  });
});

describe("one payment, several documents (§20)", () => {
  it("splits the brief's €300 example into €100 and €200, never €300 twice", () => {
    const receipts = [receipt("t1", 30_000)];
    const result = allocatePayments({
      documents: [A, B],
      receipts,
      strategy: "proportional",
    });

    expect(allocatedTotalFor(result.entries, "source-a")).toBe(10_000);
    expect(allocatedTotalFor(result.entries, "source-b")).toBe(20_000);

    // The whole point, stated twice on purpose.
    const total = result.entries.reduce(
      (sum, entry) => sum + entry.amountMinor,
      0,
    );
    expect(total).toBe(30_000);
    expect(total).not.toBe(60_000);
    expectPreserved(receipts, result);
  });

  it("gives the rounding remainder to the primary and still sums exactly", () => {
    // Three documents that do not divide evenly: 100.00 over 1/1/1.
    const documents: PayableDocument[] = [
      { ...A, documentKey: "a", countCode: "SH-A", valueMinor: 1 },
      { ...B, documentKey: "b", countCode: "SH-B", valueMinor: 1 },
      { ...B, documentKey: "c", countCode: "SH-C", valueMinor: 1 },
    ];
    const receipts = [receipt("t1", 10_000)];

    const result = allocatePayments({
      documents,
      receipts,
      strategy: "proportional",
    });

    expect(
      result.entries.reduce((sum, entry) => sum + entry.amountMinor, 0),
    ).toBe(10_000);
    expectPreserved(receipts, result);
  });

  it("puts everything on the primary under the primary strategy", () => {
    const receipts = [receipt("t1", 30_000)];
    const result = allocatePayments({
      documents: [A, B],
      receipts,
      strategy: "primary",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.documentKey).toBe("source-a");
    expectPreserved(receipts, result);
  });

  it("is deterministic: the same inputs allocate identically every time", () => {
    // An unstable split moves cents between documents on every reconciliation,
    // and each move rewrites an ERP document.
    const receipts = [receipt("t1", 30_001)];
    const first = allocatePayments({
      documents: [A, B],
      receipts,
      strategy: "proportional",
    });
    const second = allocatePayments({
      documents: [B, A],
      receipts,
      strategy: "proportional",
    });

    expect(first.entries).toEqual(second.entries);
  });
});

describe("several payments", () => {
  it("keeps each receipt separate and each split exact", () => {
    const receipts = [
      receipt("t1", 10_000, new Date("2026-01-01T10:00:00Z")),
      receipt("t2", 20_000, new Date("2026-01-05T10:00:00Z")),
    ];

    const result = allocatePayments({
      documents: [A, B],
      receipts,
      strategy: "proportional",
    });

    expect(
      result.entries.filter((entry) => entry.shopifyTransactionId === "t1")
        .reduce((sum, entry) => sum + entry.amountMinor, 0),
    ).toBe(10_000);
    expect(
      result.entries.filter((entry) => entry.shopifyTransactionId === "t2")
        .reduce((sum, entry) => sum + entry.amountMinor, 0),
    ).toBe(20_000);
    expectPreserved(receipts, result);
  });

  it("allocating the same receipts again produces the same entries", () => {
    /*
     * The idempotency the whole payment path rests on. The reconciler re-runs
     * on every webhook and every scheduled pass; if this drifted, MetaKocka
     * would be rewritten each time with a slightly different ledger.
     */
    const receipts = [receipt("t1", 10_000), receipt("t2", 20_000)];
    const once = allocatePayments({
      documents: [A, B],
      receipts,
      strategy: "proportional",
    });
    const twice = allocatePayments({
      documents: [A, B],
      receipts,
      strategy: "proportional",
    });
    expect(once).toEqual(twice);
  });
});

describe("a document the order no longer uses", () => {
  it("is excluded, so a warehouse move cannot pay the same money twice", () => {
    /*
     * The recorded failure: an order whose line moved warehouse kept its old
     * document, and the old document kept its payment — so a one-line order of
     * €209 was recorded as €418 across two documents.
     */
    const retired: PayableDocument = { ...A, retired: true };
    const receipts = [receipt("t1", 20_900)];

    const result = allocatePayments({
      documents: [retired, B],
      receipts,
      strategy: "proportional",
    });

    expect(allocatedTotalFor(result.entries, "source-a")).toBe(0);
    expect(allocatedTotalFor(result.entries, "source-b")).toBe(20_900);
    expectPreserved(receipts, result);
  });

  it("reports money it cannot place rather than dropping it", () => {
    // Every document retired and money still arrived. §11: a person decides,
    // and nothing is written against a document that describes none of it.
    const receipts = [receipt("t1", 20_900)];
    const result = allocatePayments({
      documents: [{ ...A, retired: true }],
      receipts,
      strategy: "proportional",
    });

    expect(result.entries).toHaveLength(0);
    expect(result.unallocated).toHaveLength(1);
    expect(result.unallocated[0]?.amountMinor).toBe(20_900);
    // Unplaced money is not counted as drift: it was deliberately not placed.
    expectPreserved(receipts, result);
  });
});

describe("degenerate cases", () => {
  it("puts a payment on the primary when every document is worth nothing", () => {
    // A fully discounted order that still paid for its postage.
    const receipts = [receipt("t1", 500)];
    const result = allocatePayments({
      documents: [
        { ...A, valueMinor: 0 },
        { ...B, valueMinor: 0 },
      ],
      receipts,
      strategy: "proportional",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.documentKey).toBe("source-a");
    expectPreserved(receipts, result);
  });

  it("ignores a zero-amount receipt instead of writing an empty payment", () => {
    const result = allocatePayments({
      documents: [A, B],
      receipts: [receipt("t1", 0)],
      strategy: "proportional",
    });
    expect(result.entries).toHaveLength(0);
  });

  it("detects drift if a split ever fails to preserve a receipt", () => {
    // Guards the guard: a broken allocation must be reported, not trusted.
    const receipts = [receipt("t1", 10_000)];
    const broken = {
      entries: [
        {
          documentKey: "source-a",
          shopifyTransactionId: "t1",
          amountMinor: 9_999,
          gateway: null,
          processedAt: null,
        },
      ],
      unallocated: [],
    };

    expect(
      allocationPreservesReceipts({ receipts, result: broken }),
    ).toEqual({
      ok: false,
      drift: [{ shopifyTransactionId: "t1", expected: 10_000, allocated: 9_999 }],
    });
  });
});
