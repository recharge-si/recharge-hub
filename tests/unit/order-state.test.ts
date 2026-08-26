import { describe, expect, it } from "vitest";

import {
  contentChangePolicy,
  diffOrder,
  paymentActionFor,
} from "~/domain/orders/state";
import {
  FINANCIAL_STATUSES,
  type FinancialStatus,
  type OrderSnapshot,
} from "~/domain/orders/types";

/**
 * The rules that decide what happens to an order after it arrives.
 *
 * This is the logic that was missing entirely: an order paid an hour after it
 * was placed produced no reaction at all, because nothing in the app compared
 * the order to itself. Everything here is pure, so the cases that matter — a
 * payment arriving, an edit landing after the ERP was told, a webhook turning
 * up out of order — are asserted directly rather than inferred from a database.
 */

function snapshot(over: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    financialStatus: "pending",
    fulfillmentState: "unfulfilled",
    currency: "EUR",
    totalMinor: 11998,
    shippingMinor: 499,
    discountMinor: 0,
    cancelled: false,
    party: "grega rotar|cesta 1|1000|ljubljana|slovenia",
    lines: [
      {
        shopifyLineItemId: "9001",
        sku: "MAST-490",
        title: "Carbon mast",
        quantity: 2,
        unitPriceWithTaxMinor: 5999,
        discountMinor: 0,
      },
    ],
    ...over,
  };
}

describe("diffOrder", () => {
  it("reports nothing for an order that has not moved", () => {
    const diff = diffOrder(snapshot(), snapshot());

    expect(diff.changed).toBe(false);
    expect(diff.contentChanged).toBe(false);
    expect(diff.summary).toEqual([]);
  });

  it("sees a payment without calling it a content change", () => {
    const diff = diffOrder(
      snapshot(),
      snapshot({ financialStatus: "paid" }),
    );

    expect(diff.paymentChanged).toBe(true);
    expect(diff.financialStatusFrom).toBe("pending");
    expect(diff.financialStatusTo).toBe("paid");
    // The document MetaKocka holds is still a correct description of the
    // order, so nothing about it needs a human.
    expect(diff.contentChanged).toBe(false);
  });

  it("sees a quantity change and says so in words", () => {
    const diff = diffOrder(
      snapshot(),
      snapshot({
        totalMinor: 17997,
        lines: [
          {
            shopifyLineItemId: "9001",
            sku: "MAST-490",
            title: "Carbon mast",
            quantity: 3,
            unitPriceWithTaxMinor: 5999,
            discountMinor: 0,
          },
        ],
      }),
    );

    expect(diff.contentChanged).toBe(true);
    expect(diff.lineChanges).toHaveLength(1);
    expect(diff.lineChanges[0]?.kind).toBe("quantity");
    expect(diff.summary.join(" ")).toContain("quantity changed from 2 to 3");
    // Minor units are never shown raw to a merchant.
    expect(diff.summary.join(" ")).toContain("119.98 to 179.97");
  });

  it("sees a line added and a line removed", () => {
    const diff = diffOrder(
      snapshot(),
      snapshot({
        lines: [
          {
            shopifyLineItemId: "9002",
            sku: "BOOM-210",
            title: "Boom",
            quantity: 1,
            unitPriceWithTaxMinor: 12000,
            discountMinor: 0,
          },
        ],
      }),
    );

    const kinds = diff.lineChanges.map((change) => change.kind).sort();
    expect(kinds).toEqual(["added", "removed"]);
  });

  it("treats a SKU swapped under one line id as a change", () => {
    const diff = diffOrder(
      snapshot(),
      snapshot({
        lines: [
          {
            shopifyLineItemId: "9001",
            sku: "MAST-500",
            title: "Carbon mast",
            quantity: 2,
            unitPriceWithTaxMinor: 5999,
            discountMinor: 0,
          },
        ],
      }),
    );

    expect(diff.lineChanges.map((change) => change.kind)).toEqual(["sku"]);
    expect(diff.contentChanged).toBe(true);
  });

  it("reports a cancellation once, not on every pass afterwards", () => {
    const cancelled = snapshot({ cancelled: true });

    expect(diffOrder(snapshot(), cancelled).cancelledNow).toBe(true);
    expect(diffOrder(cancelled, cancelled).cancelledNow).toBe(false);
  });

  it("does not treat fulfilment as a reason to touch MetaKocka", () => {
    const diff = diffOrder(
      snapshot(),
      snapshot({ fulfillmentState: "fulfilled" }),
    );

    expect(diff.changed).toBe(true);
    expect(diff.contentChanged).toBe(false);
    expect(diff.paymentChanged).toBe(false);
  });
});

describe("the customer arriving", () => {
  /*
   * The failure this was written for. An order created with no address, given
   * one in Shopify a minute later, synced — and the diff, which watched only
   * payment, money and lines, reported nothing. So the payload carrying the new
   * address was discarded and the order could never be sent to MetaKocka,
   * however many times anyone pressed retry.
   */
  it("sees an address arrive on an order that had none", () => {
    const diff = diffOrder(snapshot({ party: null }), snapshot());

    expect(diff.changed).toBe(true);
    expect(diff.partyArrived).toBe(true);
    expect(diff.partyChanged).toBe(true);
  });

  it("does not call an arriving customer a divergence", () => {
    // There is no document to be wrong: this is the order becoming sendable.
    // Raising an exception here would greet the merchant with a new problem at
    // the moment they had just fixed one.
    const diff = diffOrder(snapshot({ party: null }), snapshot());
    expect(diff.contentChanged).toBe(false);
  });

  it("does call a customer who changed a divergence", () => {
    // A document already filed against somebody else is wrong in the way §8.8
    // cares about.
    const diff = diffOrder(
      snapshot(),
      snapshot({ party: "someone else|cesta 2|2000|maribor|slovenia" }),
    );

    expect(diff.partyChanged).toBe(true);
    expect(diff.partyArrived).toBe(false);
    expect(diff.contentChanged).toBe(true);
  });

  it("never repeats the customer details in what it says", () => {
    // The summary reaches the event log and exception messages, and neither is
    // covered by the §2.4 retention job.
    const diff = diffOrder(
      snapshot({ party: null }),
      snapshot({ party: "grega rotar|spodnje pirnice 19n|1215|medvode|slovenia" }),
    );

    const said = diff.summary.join(" ").toLowerCase();
    expect(said).not.toContain("grega");
    expect(said).not.toContain("pirnice");
    expect(said).toContain("customer");
  });
});

describe("paymentActionFor", () => {
  const unpaid = { alreadyMarkedPaid: false };

  it("records a payment whichever state the order came from", () => {
    // The reconciler exists because webhooks are lost, so it routinely sees a
    // status jump several steps. Matching on the destination is what makes
    // that work.
    for (const from of ["pending", "authorized", "unknown"] as const) {
      expect(paymentActionFor(from, "paid", unpaid)).toEqual({
        kind: "mark_paid",
      });
    }
  });

  it("does nothing when every document already carries the payment", () => {
    // §8.7: mark_paid on an update deletes the previous payment and replaces
    // it, so a redelivered orders/paid must not send a second one.
    const action = paymentActionFor("paid", "paid", {
      alreadyMarkedPaid: true,
    });
    expect(action.kind).toBe("none");
  });

  it("still asks for the payment when the status did not change", () => {
    // An order paid in this database and unpaid in the ERP: the payment job
    // failed, or the worker died mid-write. Every pass is another chance.
    expect(paymentActionFor("paid", "paid", unpaid)).toEqual({
      kind: "mark_paid",
    });
  });

  it("never guesses at a part payment", () => {
    const action = paymentActionFor("pending", "partially_paid", unpaid);
    expect(action).toMatchObject({
      kind: "exception",
      exception: "partially_paid",
    });
  });

  it("turns a void and a refund into a human decision, not a deletion", () => {
    expect(paymentActionFor("paid", "voided", unpaid)).toMatchObject({
      kind: "exception",
      exception: "voided_payment",
    });
    expect(paymentActionFor("paid", "refunded", unpaid)).toMatchObject({
      kind: "exception",
      exception: "refund_received",
    });
    expect(
      paymentActionFor("paid", "partially_refunded", unpaid),
    ).toMatchObject({ kind: "exception", exception: "refund_received" });
  });

  it("does not read a step backwards as money being taken away", () => {
    // Shopify says a payment was undone with voided or refunded. Anything else
    // moving back to pending is bookkeeping, not a reversal.
    expect(paymentActionFor("paid", "pending", unpaid).kind).toBe("none");
    expect(paymentActionFor("paid", "authorized", unpaid).kind).toBe("none");
  });

  it("has an answer for every status Shopify can report", () => {
    for (const to of FINANCIAL_STATUSES) {
      const action = paymentActionFor("pending", to as FinancialStatus, unpaid);
      expect(["none", "mark_paid", "exception"]).toContain(action.kind);
    }
  });
});

describe("contentChangePolicy", () => {
  it("re-allocates an edit that has not reached MetaKocka", () => {
    expect(
      contentChangePolicy({ contentChanged: true, writtenDocuments: 0 }),
    ).toEqual({ kind: "reallocate" });
  });

  it("resends an order the ERP already holds", () => {
    // MetaKocka treats an update as a replacement, so the document is rebuilt
    // whole and swapped rather than a second one being created.
    expect(
      contentChangePolicy({ contentChanged: true, writtenDocuments: 1 }),
    ).toEqual({ kind: "resend" });
  });

  it("leaves it to a person when the merchant has turned updates off", () => {
    // The old behaviour, kept whole: the document may already be invoiced
    // (§8.8), and only the merchant knows whether it has.
    expect(
      contentChangePolicy({
        contentChanged: true,
        writtenDocuments: 1,
        updatesAllowed: false,
      }),
    ).toEqual({ kind: "diverged" });
  });

  it("does nothing when the content did not change", () => {
    expect(
      contentChangePolicy({ contentChanged: false, writtenDocuments: 2 }),
    ).toEqual({ kind: "ignore" });
  });
});
