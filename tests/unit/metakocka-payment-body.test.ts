import { describe, expect, it } from "vitest";

import {
  buildSalesOrderBody,
  type DocumentPayment,
  type SalesOrderInput,
} from "~/adapters/metakocka/documents";
import { emptiedBody } from "~/jobs/orders/document-reconciler";

/**
 * What `mark_paid` carries, and why sending the whole array is the safe move
 * (brief §18, §21; docs/metakocka-verification.md).
 *
 * The verified MetaKocka behaviour this rests on: **`put_document` with an
 * `mk_id` replaces the document, and `mark_paid` on an update deletes the
 * previous payment and replaces it.** Sent one payment at a time that is a
 * trap — the second capture of a two-part payment erases the first. Sent as
 * the complete desired ledger it is the property the connector wants: the
 * document ends up carrying exactly these payments, and sending the same list
 * again changes nothing.
 *
 * These tests pin the body, not the network. §12 forbids a live ERP in tests
 * and `buildSalesOrderBody` is deterministic, so the bytes are assertable.
 */

const BASE: SalesOrderInput = {
  countCode: "SH-1050-GLAVNO",
  buyerOrder: "SH-1050",
  docDate: new Date("2026-01-05T09:00:00Z"),
  currencyCode: "EUR",
  partner: { customer: "Ana Novak", street: "Cesta 1" },
  warehouse: "glavno",
  lines: [
    { code: "SKU-A", amount: 2, priceWithTaxMinor: 10_450, taxFactor: "0.22" },
  ],
};

function payment(
  amountMinor: number,
  paymentType = "TRR",
  paidAt = new Date("2026-01-05T09:00:00Z"),
): DocumentPayment {
  return { paymentType, paidAt, amountMinor };
}

function markPaidOf(body: ReturnType<typeof buildSalesOrderBody>) {
  return (body as { mark_paid?: unknown[] }).mark_paid;
}

describe("a document with no payment", () => {
  it("omits mark_paid entirely, so an update leaves an existing one alone", () => {
    /*
     * The three states are genuinely different and conflating any two loses
     * money. Absent means "do not touch the payment"; an empty array means
     * "this document should carry none"; entries mean "exactly these".
     */
    const body = buildSalesOrderBody(BASE);
    expect(markPaidOf(body)).toBeUndefined();
  });
});

describe("a document paid once", () => {
  it("carries one entry, dated in the ERP timezone", () => {
    const body = buildSalesOrderBody({
      ...BASE,
      payments: [payment(20_900)],
    });

    expect(markPaidOf(body)).toEqual([
      { payment_type: "TRR", date: "05.01.2026", amount: "209.00" },
    ]);
  });

  it("still accepts the single-payment shorthand every older caller uses", () => {
    const body = buildSalesOrderBody({
      ...BASE,
      markPaid: {
        paymentType: "TRR",
        paidAt: new Date("2026-01-05T09:00:00Z"),
        amountMinor: 20_900,
      },
    });

    expect(markPaidOf(body)).toEqual([
      { payment_type: "TRR", date: "05.01.2026", amount: "209.00" },
    ]);
  });

  it("lets the reconciled ledger win over the shorthand", () => {
    // Both set is not a normal state, but the ledger is the authority and a
    // silent tie-break in the other direction would be a lost payment.
    const body = buildSalesOrderBody({
      ...BASE,
      markPaid: {
        paymentType: "CARD",
        paidAt: new Date("2026-01-05T09:00:00Z"),
        amountMinor: 999,
      },
      payments: [payment(20_900)],
    });

    expect(markPaidOf(body)).toEqual([
      { payment_type: "TRR", date: "05.01.2026", amount: "209.00" },
    ]);
  });
});

describe("a document paid more than once (§18)", () => {
  it("carries every receipt as its own entry, in the order given", () => {
    const body = buildSalesOrderBody({
      ...BASE,
      payments: [
        payment(10_000, "TRR", new Date("2026-01-05T09:00:00Z")),
        payment(20_000, "CARD", new Date("2026-01-09T14:00:00Z")),
        payment(20_000, "CARD", new Date("2026-02-01T14:00:00Z")),
      ],
    });

    expect(markPaidOf(body)).toEqual([
      { payment_type: "TRR", date: "05.01.2026", amount: "100.00" },
      { payment_type: "CARD", date: "09.01.2026", amount: "200.00" },
      { payment_type: "CARD", date: "01.02.2026", amount: "200.00" },
    ]);
  });

  it("is byte-identical when the same ledger is built again", () => {
    /*
     * The property the update path depends on: the body is compared against
     * the last one sent to decide whether anything needs writing. An unstable
     * build would rewrite every document on every reconciliation.
     */
    const payments = [payment(10_000), payment(20_000, "CARD")];
    expect(
      JSON.stringify(buildSalesOrderBody({ ...BASE, payments })),
    ).toBe(JSON.stringify(buildSalesOrderBody({ ...BASE, payments })));
  });
});

describe("a document whose payment moved elsewhere", () => {
  it("sends an empty mark_paid, which is what clears it", () => {
    /*
     * A receipt reallocated after a warehouse move. Omitting the key would
     * leave the old payment in place — the document would go on carrying money
     * for goods that are now on another document, and the order would read as
     * paid twice.
     */
    const body = buildSalesOrderBody({ ...BASE, payments: [] });
    expect(markPaidOf(body)).toEqual([]);
  });
});

describe("emptying an obsolete document", () => {
  it("removes the lines and the payment together, and keeps everything else", () => {
    const original = buildSalesOrderBody({
      ...BASE,
      payments: [payment(20_900)],
    }) as Record<string, unknown>;

    const emptied = emptiedBody(original);

    expect(emptied.product_list).toEqual([]);
    expect(emptied.mark_paid).toEqual([]);
    // The whole body is replayed because MetaKocka replaces rather than
    // patches: a partial update would delete the partner and the dates too.
    expect(emptied.count_code).toBe("SH-1050-GLAVNO");
    expect(emptied.buyer_order).toBe("SH-1050");
    expect(emptied.partner).toEqual(original.partner);
    expect(emptied.warehouse).toBe("glavno");
  });
});

describe("money never touches a float", () => {
  it("renders awkward amounts exactly", () => {
    const body = buildSalesOrderBody({
      ...BASE,
      payments: [payment(1999), payment(1, "CARD"), payment(100_000_00)],
    });

    expect(markPaidOf(body)).toEqual([
      { payment_type: "TRR", date: "05.01.2026", amount: "19.99" },
      { payment_type: "CARD", date: "05.01.2026", amount: "0.01" },
      { payment_type: "TRR", date: "05.01.2026", amount: "100000.00" },
    ]);
  });
});
