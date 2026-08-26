import { describe, expect, it } from "vitest";

import {
  allocationShortfalls,
  groupBySupplySource,
  type CanonicalAllocation,
  type CanonicalLine,
} from "~/domain/orders/canonical";
import { verifyQuantities } from "~/domain/orders/invariants";
import {
  planDocuments,
  retirementPlanFor,
  type DocumentAction,
  type ExistingDocument,
  type ObsoleteDocumentPolicy,
} from "~/domain/orders/reconcile";
import { splitOrderMoney } from "~/domain/money/split";
import {
  allocatePayments,
  allocationPreservesReceipts,
  type AllocatableReceipt,
  type PayableDocument,
  type PaymentAllocationStrategy,
} from "~/domain/payments/allocation";
import { summarisePayments, type OrderTransaction } from "~/domain/payments/transactions";

/**
 * The reconciliation loop, driven through every scenario the brief lists
 * (§32), as one continuous story per case.
 *
 * This is the vertical slice for orders, in the mould of
 * `order-to-metakocka.test.ts`: it stops at the network on purpose (§12 forbids
 * a live ERP in tests) and joins the real pure functions the jobs call, in the
 * order the jobs call them. The seam it exists to protect is exactly the one no
 * single-module test can see — that the location grouping, the document plan,
 * the money split, the payment allocation and the verification all agree about
 * the same order.
 *
 * The harness below is a **model of MetaKocka**, not a mock of this app. It
 * holds documents with lines and payments, applies the plan the way the write
 * path does, and is then asked the question that matters:
 *
 * ```text
 * SUM(quantity across the order's documents) = Shopify's quantities
 * ```
 *
 * Every scenario asserts that, and asserts how many documents were created —
 * because a connector can satisfy the quantity invariant and still be wrong if
 * it reached it by making a new document each time.
 */

/* -------------------------------------------------------------------------- */
/* The model                                                                  */
/* -------------------------------------------------------------------------- */

interface ShopifyLine {
  shopifyLineItemId: string;
  sku: string;
  quantity: number;
  unitPriceWithTaxMinor: number;
}

/** Where Shopify says each line ships from, as fulfilment orders report it. */
type Assignment = { locationId: string; lines: { lineId: string; quantity: number }[] };

interface ShopifyOrder {
  lines: ShopifyLine[];
  assignments: Assignment[];
  transactions: OrderTransaction[];
  totalMinor: number;
}

/** One MetaKocka sales order, as the ERP would hold it. */
interface ModelDocument {
  documentId: string;
  supplySourceId: string;
  countCode: string;
  lines: { sku: string; quantity: number }[];
  payments: { transactionId: string; amountMinor: number }[];
  present: boolean;
  retired: boolean;
}

interface RunResult {
  actions: DocumentAction[];
  created: string[];
  retired: string[];
  quantities: ReturnType<typeof verifyQuantities>;
  /** Every payment recorded anywhere, summed. Must equal the gross received. */
  recordedPaymentMinor: number;
}

class Connector {
  readonly documents: ModelDocument[] = [];
  private nextId = 1;

  constructor(
    /** The existing Shopify location to MetaKocka warehouse mapping, reused. */
    private readonly sourceByLocation: Record<string, string>,
    private readonly options: {
      obsoletePolicy?: ObsoleteDocumentPolicy;
      paymentStrategy?: PaymentAllocationStrategy;
    } = {},
  ) {}

  /** One pass of the loop, from a Shopify state to a MetaKocka state. */
  run(order: ShopifyOrder): RunResult {
    const canonicalLines: CanonicalLine[] = order.lines.map((line) => ({
      shopifyLineItemId: line.shopifyLineItemId,
      sku: line.sku,
      title: line.sku,
      quantity: line.quantity,
      unitPriceWithTaxMinor: line.unitPriceWithTaxMinor,
      discountMinor: 0,
      taxFactor: "0.22",
    }));

    const allocations: CanonicalAllocation[] = order.assignments.map(
      (assignment) => ({
        shopifyLocationId: assignment.locationId,
        supplySourceId: this.sourceByLocation[assignment.locationId] ?? null,
        disposition: this.sourceByLocation[assignment.locationId]
          ? ("managed" as const)
          : ("unresolved" as const),
        lines: assignment.lines.map((line) => ({
          shopifyLineItemId: line.lineId,
          quantity: line.quantity,
        })),
      }),
    );

    // Shopify must account for the whole order; anything it does not is the
    // caller's problem and never silently dropped.
    expect(allocationShortfalls(canonicalLines, allocations).shortfalls).toEqual(
      [],
    );

    const grouped = groupBySupplySource(allocations);
    const skuOf = new Map(
      order.lines.map((line) => [line.shopifyLineItemId, line] as const),
    );

    const desired = [...grouped.bySource.entries()].map(
      ([supplySourceId, lines]) => ({
        supplySourceId,
        lines: lines.map((line) => ({
          sku: skuOf.get(line.shopifyLineItemId)!.sku,
          quantity: line.quantity,
        })),
      }),
    );

    const existing: ExistingDocument[] = this.documents.map((document) => ({
      documentId: document.documentId,
      supplySourceId: document.supplySourceId,
      countCode: document.countCode,
      status: document.present ? "written" : "failed",
      present: document.present,
      paid: document.payments.length > 0,
      retired: document.retired,
      lines: document.lines,
    }));

    const actions = planDocuments({ desired, existing });

    const created: string[] = [];
    const retired: string[] = [];

    for (const action of actions) {
      if (action.kind === "retire") {
        const document = this.documents.find(
          (entry) => entry.documentId === action.documentId,
        )!;
        const plan = retirementPlanFor(
          action,
          this.options.obsoletePolicy ?? "empty",
        );

        document.retired = true;
        // Retiring always stops the document being paid; the money is
        // reallocated below, never left in two places.
        document.payments = [];

        if (plan.kind === "empty") document.lines = [];
        if (plan.kind === "delete") {
          this.documents.splice(this.documents.indexOf(document), 1);
        }
        retired.push(action.countCode);
        continue;
      }

      const lines =
        desired.find(
          (entry) => entry.supplySourceId === action.supplySourceId,
        )?.lines ?? [];

      if (action.kind === "create") {
        const countCode = `SH-1050-${action.supplySourceId.toUpperCase()}`;
        this.documents.push({
          documentId: `doc-${this.nextId++}`,
          supplySourceId: action.supplySourceId,
          countCode,
          lines,
          payments: [],
          present: true,
          retired: false,
        });
        created.push(countCode);
        continue;
      }

      const document = this.documents.find(
        (entry) => entry.supplySourceId === action.supplySourceId,
      )!;
      // Reviving is what stops a line that moved away and back producing a
      // third document: the row, and therefore the count_code claim, survives.
      document.retired = false;
      document.lines = lines;
    }

    /* -------------------------------------------------------------------- */
    /* Payments                                                             */
    /* -------------------------------------------------------------------- */

    const summary = summarisePayments(order.transactions, order.totalMinor);

    const shares = splitOrderMoney({
      perSource: desired.map((entry) => ({
        sourceId: entry.supplySourceId,
        sourceCode: entry.supplySourceId,
        kind: "own" as const,
        lineTotalMinor: entry.lines.reduce(
          (total, line) =>
            total +
            line.quantity *
              (order.lines.find((source) => source.sku === line.sku)
                ?.unitPriceWithTaxMinor ?? 0),
          0,
        ),
      })),
      orderTotalMinor: order.totalMinor,
      shippingMinor: 0,
      discountMinor: 0,
    });

    const payable: PayableDocument[] = this.documents.map((document) => ({
      documentKey: document.supplySourceId,
      countCode: document.countCode,
      isPrimary:
        shares.find((share) => share.sourceId === document.supplySourceId)
          ?.isPrimary ?? false,
      valueMinor:
        shares.find((share) => share.sourceId === document.supplySourceId)
          ?.totalMinor ?? 0,
      retired: document.retired,
    }));

    const receipts: AllocatableReceipt[] = order.transactions
      .filter(
        (transaction) =>
          transaction.status === "success" &&
          (transaction.kind === "sale" || transaction.kind === "capture"),
      )
      .map((transaction) => ({
        shopifyTransactionId: transaction.shopifyTransactionId,
        amountMinor: transaction.amountMinor,
        gateway: transaction.gateway,
        processedAt: transaction.processedAt,
      }));

    const allocated = allocatePayments({
      documents: payable,
      receipts,
      strategy: this.options.paymentStrategy ?? "proportional",
    });

    // The guard the payment path runs at runtime, asserted here too: money is
    // neither invented nor lost by the split.
    expect(
      allocationPreservesReceipts({ receipts, result: allocated }).ok,
    ).toBe(true);

    // Replacement, not accumulation. Every document is told the whole set it
    // should carry, which is what makes a repeated pass a no-op.
    for (const document of this.documents) {
      document.payments = allocated.entries
        .filter((entry) => entry.documentKey === document.supplySourceId)
        .map((entry) => ({
          transactionId: entry.shopifyTransactionId,
          amountMinor: entry.amountMinor,
        }));
    }

    const recordedPaymentMinor = this.documents.reduce(
      (total, document) =>
        total +
        document.payments.reduce((sum, entry) => sum + entry.amountMinor, 0),
      0,
    );

    // §24: what the ERP was told equals what Shopify says was received.
    expect(recordedPaymentMinor).toBe(summary.grossReceivedMinor);

    return {
      actions,
      created,
      retired,
      quantities: verifyQuantities({
        expected: canonicalLines.map((line) => ({
          sku: line.sku,
          quantity: line.quantity,
        })),
        actual: this.documents.flatMap((document) => document.lines),
      }),
      recordedPaymentMinor,
    };
  }

  /** Quantity of one SKU on one warehouse's document. */
  quantityAt(supplySourceId: string, sku: string): number {
    return (
      this.documents
        .find((document) => document.supplySourceId === supplySourceId)
        ?.lines.find((line) => line.sku === sku)?.quantity ?? 0
    );
  }

  paidAt(supplySourceId: string): number {
    return (
      this.documents
        .find((document) => document.supplySourceId === supplySourceId)
        ?.payments.reduce((total, entry) => total + entry.amountMinor, 0) ?? 0
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const MAPPING = { "loc-a": "src-a", "loc-b": "src-b" };

function line(
  id: string,
  sku: string,
  quantity: number,
  price = 10_000,
): ShopifyLine {
  return {
    shopifyLineItemId: id,
    sku,
    quantity,
    unitPriceWithTaxMinor: price,
  };
}

function sale(
  id: string,
  amountMinor: number,
  processedAt = new Date("2026-01-05T09:00:00Z"),
): OrderTransaction {
  return {
    shopifyTransactionId: id,
    kind: "sale",
    status: "success",
    amountMinor,
    currency: "EUR",
    gateway: "shopify_payments",
    processedAt,
    parentTransactionId: null,
  };
}

function order(input: Partial<ShopifyOrder> & Pick<ShopifyOrder, "lines" | "assignments">): ShopifyOrder {
  return {
    transactions: [],
    totalMinor: input.lines.reduce(
      (total, entry) => total + entry.quantity * entry.unitPriceWithTaxMinor,
      0,
    ),
    ...input,
  };
}

/* -------------------------------------------------------------------------- */
/* Scenarios                                                                  */
/* -------------------------------------------------------------------------- */

describe("an order arriving, and arriving again", () => {
  it("creates one document per warehouse", () => {
    const connector = new Connector(MAPPING);

    const result = connector.run(
      order({
        lines: [line("l1", "SKU-A", 2), line("l2", "SKU-B", 1), line("l3", "SKU-C", 3)],
        assignments: [
          {
            locationId: "loc-a",
            lines: [
              { lineId: "l1", quantity: 2 },
              { lineId: "l2", quantity: 1 },
            ],
          },
          { locationId: "loc-b", lines: [{ lineId: "l3", quantity: 3 }] },
        ],
      }),
    );

    expect(result.created).toEqual(["SH-1050-SRC-A", "SH-1050-SRC-B"]);
    expect(result.quantities.ok).toBe(true);
    expect(connector.quantityAt("src-a", "SKU-A")).toBe(2);
    expect(connector.quantityAt("src-b", "SKU-C")).toBe(3);
  });

  it("does nothing at all on a duplicate webhook or a repeated pass", () => {
    const connector = new Connector(MAPPING);
    const state = order({
      lines: [line("l1", "SKU-A", 2)],
      assignments: [{ locationId: "loc-a", lines: [{ lineId: "l1", quantity: 2 }] }],
    });

    connector.run(state);

    for (let pass = 0; pass < 5; pass += 1) {
      const again = connector.run(state);
      expect(again.created).toEqual([]);
      expect(again.actions.every((action) => action.kind === "unchanged")).toBe(
        true,
      );
      expect(again.quantities.ok).toBe(true);
      expect(connector.quantityAt("src-a", "SKU-A")).toBe(2);
    }

    expect(connector.documents).toHaveLength(1);
  });

  it("survives an out-of-order event, because it reads the current order", () => {
    /*
     * The old shape of this bug: a late `orders/updated` describing yesterday's
     * order re-applied it. Here the event is only a trigger — the pass is fed
     * the *current* state — so a late trigger is one extra comparison.
     */
    const connector = new Connector(MAPPING);
    const current = order({
      lines: [line("l1", "SKU-A", 5)],
      assignments: [{ locationId: "loc-a", lines: [{ lineId: "l1", quantity: 5 }] }],
    });

    connector.run(current);
    const late = connector.run(current);

    expect(late.created).toEqual([]);
    expect(connector.quantityAt("src-a", "SKU-A")).toBe(5);
  });
});

describe("editing the order", () => {
  it("adds a product to the existing document", () => {
    const connector = new Connector(MAPPING);
    connector.run(
      order({
        lines: [line("l1", "SKU-A", 1)],
        assignments: [{ locationId: "loc-a", lines: [{ lineId: "l1", quantity: 1 }] }],
      }),
    );

    const edited = connector.run(
      order({
        lines: [line("l1", "SKU-A", 1), line("l2", "SKU-B", 2)],
        assignments: [
          {
            locationId: "loc-a",
            lines: [
              { lineId: "l1", quantity: 1 },
              { lineId: "l2", quantity: 2 },
            ],
          },
        ],
      }),
    );

    expect(edited.created).toEqual([]);
    expect(connector.documents).toHaveLength(1);
    expect(connector.quantityAt("src-a", "SKU-A")).toBe(1);
    expect(connector.quantityAt("src-a", "SKU-B")).toBe(2);
  });

  it("takes a quantity up and back down without drifting", () => {
    const connector = new Connector(MAPPING);
    const at = (quantity: number) =>
      order({
        lines: [line("l1", "SKU-A", quantity)],
        assignments: [
          { locationId: "loc-a", lines: [{ lineId: "l1", quantity }] },
        ],
      });

    connector.run(at(2));
    connector.run(at(5));
    expect(connector.quantityAt("src-a", "SKU-A")).toBe(5);

    const down = connector.run(at(1));
    expect(down.quantities.ok).toBe(true);
    expect(connector.quantityAt("src-a", "SKU-A")).toBe(1);
    expect(connector.documents).toHaveLength(1);
  });

  it("removes a line the customer no longer takes", () => {
    const connector = new Connector(MAPPING);
    connector.run(
      order({
        lines: [line("l1", "SKU-A", 2), line("l2", "SKU-B", 1)],
        assignments: [
          {
            locationId: "loc-a",
            lines: [
              { lineId: "l1", quantity: 2 },
              { lineId: "l2", quantity: 1 },
            ],
          },
        ],
      }),
    );

    const after = connector.run(
      order({
        lines: [line("l1", "SKU-A", 2)],
        assignments: [{ locationId: "loc-a", lines: [{ lineId: "l1", quantity: 2 }] }],
      }),
    );

    expect(after.quantities.ok).toBe(true);
    expect(connector.quantityAt("src-a", "SKU-B")).toBe(0);
  });
});

describe("moving between locations (§7, §8)", () => {
  it("moves the whole line: 2 at B, none at A, 2 in total", () => {
    const connector = new Connector(MAPPING);
    connector.run(
      order({
        lines: [line("l1", "SKU-A", 2)],
        assignments: [{ locationId: "loc-a", lines: [{ lineId: "l1", quantity: 2 }] }],
      }),
    );

    const moved = connector.run(
      order({
        lines: [line("l1", "SKU-A", 2)],
        assignments: [{ locationId: "loc-b", lines: [{ lineId: "l1", quantity: 2 }] }],
      }),
    );

    expect(connector.quantityAt("src-a", "SKU-A")).toBe(0);
    expect(connector.quantityAt("src-b", "SKU-A")).toBe(2);
    // The forbidden outcome, asserted as arithmetic.
    expect(moved.quantities.actualTotal).toBe(2);
    expect(moved.quantities.ok).toBe(true);
    expect(moved.retired).toEqual(["SH-1050-SRC-A"]);
  });

  it("moves part of a line: 2 at A and 3 at B, and 5 in total", () => {
    const connector = new Connector(MAPPING);
    connector.run(
      order({
        lines: [line("l1", "SKU-A", 5)],
        assignments: [{ locationId: "loc-a", lines: [{ lineId: "l1", quantity: 5 }] }],
      }),
    );

    const split = connector.run(
      order({
        lines: [line("l1", "SKU-A", 5)],
        assignments: [
          { locationId: "loc-a", lines: [{ lineId: "l1", quantity: 2 }] },
          { locationId: "loc-b", lines: [{ lineId: "l1", quantity: 3 }] },
        ],
      }),
    );

    expect(connector.quantityAt("src-a", "SKU-A")).toBe(2);
    expect(connector.quantityAt("src-b", "SKU-A")).toBe(3);
    expect(split.quantities.actualTotal).toBe(5);
    expect(split.created).toEqual(["SH-1050-SRC-B"]);
  });

  it("moves a line away and back without ever creating a third document", () => {
    const connector = new Connector(MAPPING);
    const at = (locationId: string) =>
      order({
        lines: [line("l1", "SKU-A", 2)],
        assignments: [{ locationId, lines: [{ lineId: "l1", quantity: 2 }] }],
      });

    connector.run(at("loc-a"));
    connector.run(at("loc-b"));
    const back = connector.run(at("loc-a"));

    expect(back.created).toEqual([]);
    expect(connector.documents).toHaveLength(2);
    expect(connector.quantityAt("src-a", "SKU-A")).toBe(2);
    expect(connector.quantityAt("src-b", "SKU-A")).toBe(0);
    expect(back.quantities.actualTotal).toBe(2);
  });
});

describe("splitting and merging (§9)", () => {
  it("splits one document into two, reusing the first", () => {
    const connector = new Connector(MAPPING);
    connector.run(
      order({
        lines: [line("l1", "SKU-A", 1), line("l2", "SKU-B", 1)],
        assignments: [
          {
            locationId: "loc-a",
            lines: [
              { lineId: "l1", quantity: 1 },
              { lineId: "l2", quantity: 1 },
            ],
          },
        ],
      }),
    );

    const split = connector.run(
      order({
        lines: [line("l1", "SKU-A", 1), line("l2", "SKU-B", 1)],
        assignments: [
          { locationId: "loc-a", lines: [{ lineId: "l1", quantity: 1 }] },
          { locationId: "loc-b", lines: [{ lineId: "l2", quantity: 1 }] },
        ],
      }),
    );

    expect(split.created).toEqual(["SH-1050-SRC-B"]);
    expect(connector.quantityAt("src-a", "SKU-B")).toBe(0);
    expect(connector.quantityAt("src-b", "SKU-B")).toBe(1);
    expect(split.quantities.ok).toBe(true);
  });

  it("merges two documents into one and leaves no stale quantity", () => {
    const connector = new Connector(MAPPING);
    connector.run(
      order({
        lines: [line("l1", "SKU-A", 1), line("l2", "SKU-B", 1)],
        assignments: [
          { locationId: "loc-a", lines: [{ lineId: "l1", quantity: 1 }] },
          { locationId: "loc-b", lines: [{ lineId: "l2", quantity: 1 }] },
        ],
      }),
    );

    const merged = connector.run(
      order({
        lines: [line("l1", "SKU-A", 1), line("l2", "SKU-B", 1)],
        assignments: [
          {
            locationId: "loc-a",
            lines: [
              { lineId: "l1", quantity: 1 },
              { lineId: "l2", quantity: 1 },
            ],
          },
        ],
      }),
    );

    expect(merged.created).toEqual([]);
    expect(connector.quantityAt("src-a", "SKU-B")).toBe(1);
    // §9: MK-B must not go on holding SKU-B.
    expect(connector.quantityAt("src-b", "SKU-B")).toBe(0);
    expect(merged.quantities.ok).toBe(true);
  });

  it("leaves the stale quantity, and reports it, under the cautious policy", () => {
    /*
     * The honest consequence of `report`: the document is untouched, so the
     * quantity invariant *fails* and says so. That is the trade the merchant
     * chose, and the point is that it is visible rather than silent.
     */
    const connector = new Connector(MAPPING, { obsoletePolicy: "report" });
    connector.run(
      order({
        lines: [line("l1", "SKU-A", 2)],
        assignments: [{ locationId: "loc-a", lines: [{ lineId: "l1", quantity: 2 }] }],
      }),
    );

    const moved = connector.run(
      order({
        lines: [line("l1", "SKU-A", 2)],
        assignments: [{ locationId: "loc-b", lines: [{ lineId: "l1", quantity: 2 }] }],
      }),
    );

    expect(moved.quantities.ok).toBe(false);
    expect(moved.quantities.discrepancies).toEqual([
      { sku: "SKU-A", expected: 2, actual: 4, difference: 2 },
    ]);
    // And still no new document beyond the one the move needed.
    expect(moved.created).toEqual(["SH-1050-SRC-B"]);
  });
});

describe("payments across the whole story (§20, §21)", () => {
  it("splits one payment by document value and never doubles it", () => {
    const connector = new Connector(MAPPING);

    const result = connector.run(
      order({
        // 100.00 from A, 200.00 from B, paid once for 300.00.
        lines: [line("l1", "SKU-A", 1, 10_000), line("l2", "SKU-B", 1, 20_000)],
        assignments: [
          { locationId: "loc-a", lines: [{ lineId: "l1", quantity: 1 }] },
          { locationId: "loc-b", lines: [{ lineId: "l2", quantity: 1 }] },
        ],
        transactions: [sale("t1", 30_000)],
      }),
    );

    expect(connector.paidAt("src-a")).toBe(10_000);
    expect(connector.paidAt("src-b")).toBe(20_000);
    expect(result.recordedPaymentMinor).toBe(30_000);
    expect(result.recordedPaymentMinor).not.toBe(60_000);
  });

  it("records a second capture without erasing the first", () => {
    const connector = new Connector(MAPPING);
    const lines = [line("l1", "SKU-A", 1, 30_000)];
    const assignments = [
      { locationId: "loc-a", lines: [{ lineId: "l1", quantity: 1 }] },
    ];

    connector.run(order({ lines, assignments, transactions: [sale("t1", 10_000)] }));
    expect(connector.paidAt("src-a")).toBe(10_000);

    const after = connector.run(
      order({
        lines,
        assignments,
        transactions: [
          sale("t1", 10_000),
          sale("t2", 20_000, new Date("2026-01-09T09:00:00Z")),
        ],
      }),
    );

    // Both, because the whole ledger is sent every time.
    expect(connector.paidAt("src-a")).toBe(30_000);
    expect(after.recordedPaymentMinor).toBe(30_000);
  });

  it("moves the payment with the goods when a line changes warehouse", () => {
    /*
     * The recorded failure this prevents: a one-line order of 209.00 recorded
     * as 418.00 across two documents, because the document left behind kept
     * its payment.
     */
    const connector = new Connector(MAPPING);
    const at = (locationId: string) =>
      order({
        lines: [line("l1", "SKU-A", 1, 20_900)],
        assignments: [{ locationId, lines: [{ lineId: "l1", quantity: 1 }] }],
        transactions: [sale("t1", 20_900)],
      });

    connector.run(at("loc-a"));
    expect(connector.paidAt("src-a")).toBe(20_900);

    const moved = connector.run(at("loc-b"));

    expect(connector.paidAt("src-a")).toBe(0);
    expect(connector.paidAt("src-b")).toBe(20_900);
    expect(moved.recordedPaymentMinor).toBe(20_900);
  });

  it("keeps a refund out of the documents while netting it in the ledger", () => {
    const connector = new Connector(MAPPING);
    const transactions: OrderTransaction[] = [
      sale("t1", 30_000),
      {
        shopifyTransactionId: "t2",
        kind: "refund",
        status: "success",
        amountMinor: 5_000,
        currency: "EUR",
        gateway: "shopify_payments",
        processedAt: new Date("2026-02-01T09:00:00Z"),
        parentTransactionId: "t1",
      },
    ];

    const result = connector.run(
      order({
        lines: [line("l1", "SKU-A", 1, 30_000)],
        assignments: [
          { locationId: "loc-a", lines: [{ lineId: "l1", quantity: 1 }] },
        ],
        transactions,
      }),
    );

    // The document still carries the 300.00 that was actually received; the
    // 50.00 back is a credit note in MetaKocka, not a shrunken receipt.
    expect(connector.paidAt("src-a")).toBe(30_000);
    expect(result.recordedPaymentMinor).toBe(30_000);

    const summary = summarisePayments(transactions, 30_000);
    expect(summary.netPaidMinor).toBe(25_000);
    expect(summary.state).toBe("partially_refunded");
  });

  it("does not record an authorisation as money", () => {
    const connector = new Connector(MAPPING);

    const result = connector.run(
      order({
        lines: [line("l1", "SKU-A", 1, 20_000)],
        assignments: [
          { locationId: "loc-a", lines: [{ lineId: "l1", quantity: 1 }] },
        ],
        transactions: [
          {
            shopifyTransactionId: "t1",
            kind: "authorization",
            status: "success",
            amountMinor: 20_000,
            currency: "EUR",
            gateway: "shopify_payments",
            processedAt: new Date("2026-01-05T09:00:00Z"),
            parentTransactionId: null,
          },
        ],
      }),
    );

    expect(result.recordedPaymentMinor).toBe(0);
    expect(connector.paidAt("src-a")).toBe(0);
  });

  it("puts everything on the primary document under that strategy", () => {
    const connector = new Connector(MAPPING, { paymentStrategy: "primary" });

    connector.run(
      order({
        lines: [line("l1", "SKU-A", 1, 10_000), line("l2", "SKU-B", 1, 20_000)],
        assignments: [
          { locationId: "loc-a", lines: [{ lineId: "l1", quantity: 1 }] },
          { locationId: "loc-b", lines: [{ lineId: "l2", quantity: 1 }] },
        ],
        transactions: [sale("t1", 30_000)],
      }),
    );

    // The 200.00 document is the primary: highest line total (§8.6).
    expect(connector.paidAt("src-b")).toBe(30_000);
    expect(connector.paidAt("src-a")).toBe(0);
  });
});

describe("an unmapped location", () => {
  it("is left out of the documents rather than guessed at", () => {
    // The lines are still visible as unmapped, so the exception can name the
    // location instead of saying "part of this order could not be allocated".
    const grouped = groupBySupplySource([
      { shopifyLocationId: "loc-a", supplySourceId: "src-a", disposition: "managed" as const, lines: [{ shopifyLineItemId: "l1", quantity: 1 }] },
      { shopifyLocationId: "loc-z", supplySourceId: null, disposition: "unresolved" as const, lines: [{ shopifyLineItemId: "l2", quantity: 2 }] },
    ]);

    expect([...grouped.bySource.keys()]).toEqual(["src-a"]);
    expect(grouped.unmappedLocations).toEqual([
      { shopifyLocationId: "loc-z", lines: [{ shopifyLineItemId: "l2", quantity: 2 }] },
    ]);
  });

  it("folds two Shopify locations that share one MetaKocka warehouse", () => {
    /*
     * A shop floor and its stockroom, counted together in the ERP. Two entries
     * would become two documents racing for one count_code, because MetaKocka's
     * warehouse is document-level (§3).
     */
    const grouped = groupBySupplySource([
      { shopifyLocationId: "loc-a", supplySourceId: "src-a", disposition: "managed" as const, lines: [{ shopifyLineItemId: "l1", quantity: 1 }] },
      { shopifyLocationId: "loc-a2", supplySourceId: "src-a", disposition: "managed" as const, lines: [{ shopifyLineItemId: "l1", quantity: 2 }] },
    ]);

    expect(grouped.bySource.get("src-a")).toEqual([
      { shopifyLineItemId: "l1", quantity: 3 },
    ]);
  });
});

describe("a line Shopify has not assigned anywhere", () => {
  it("is reported as a shortfall rather than quietly dropped", () => {
    // A digital line, or a third-party fulfilment this app's scopes cannot
    // read. The connector allocates the remainder from stock rules; what it
    // must never do is send a document that is silently short.
    const shortfalls = allocationShortfalls(
      [
        {
          shopifyLineItemId: "l1",
          sku: "SKU-A",
          title: "A",
          quantity: 3,
          unitPriceWithTaxMinor: 1000,
          discountMinor: 0,
          taxFactor: "0.22",
        },
      ],
      [
        {
          shopifyLocationId: "loc-a",
          supplySourceId: "src-a",
          disposition: "managed" as const,
          lines: [{ shopifyLineItemId: "l1", quantity: 1 }],
        },
      ],
    );

    expect(shortfalls.shortfalls).toEqual([
      {
        shopifyLineItemId: "l1",
        sku: "SKU-A",
        title: "A",
        requiredQuantity: 3,
        assignedQuantity: 1,
        shortfallQuantity: 2,
      },
    ]);
  });

  it("reports an over-assignment rather than averaging it away", () => {
    const result = allocationShortfalls(
      [
        {
          shopifyLineItemId: "l1",
          sku: "SKU-A",
          title: "A",
          quantity: 1,
          unitPriceWithTaxMinor: 1000,
          discountMinor: 0,
          taxFactor: "0.22",
        },
      ],
      [
        {
          shopifyLocationId: "loc-a",
          supplySourceId: "src-a",
          disposition: "managed" as const,
          lines: [{ shopifyLineItemId: "l1", quantity: 3 }],
        },
      ],
    );

    expect(result.shortfalls).toEqual([]);
    expect(result.overAssigned[0]?.shortfallQuantity).toBe(-2);
  });
});
