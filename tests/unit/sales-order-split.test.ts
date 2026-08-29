import { describe, expect, it } from "vitest";

import { SALES_ORDER_DEFAULTS } from "~/adapters/db/repositories/sales-order-setting.server";
import { classifyQuantities, type CanonicalLine } from "~/domain/orders/canonical";
import { splitOrderMoney } from "~/domain/money/split";
import {
  planDocuments,
  WHOLE_ORDER_DOCUMENT,
  type DocumentAction,
  type ExistingDocument,
} from "~/domain/orders/reconcile";
import { verifyOrder } from "~/jobs/orders/verification";

/**
 * One Shopify order as one MetaKocka sales order (`sales_order_split`).
 *
 * MetaKocka's `warehouse` is document-level, so this connector has always
 * written one document per warehouse an order ships from. A shop that does not
 * keep its warehouses in MetaKocka gets no value from that and a good deal of
 * confusion: two documents for one order, each filed against a warehouse
 * nobody meant to use. `single` is the other answer — one document carrying
 * every line with no warehouse mark, which MetaKocka files against the company
 * default.
 *
 * The reconciler keys that document by `WHOLE_ORDER_DOCUMENT` rather than by a
 * supply source, because there is no source; the stored row's
 * `supply_source_id` is null, which is exactly what it means. These tests pin
 * the pure halves of that: the diff, the money and the verification all have to
 * agree that an unsplit order is one document holding the whole order.
 */

const kinds = (actions: DocumentAction[]) =>
  actions.map((action) =>
    action.kind === "retire"
      ? `retire:${action.countCode}`
      : `${action.kind}:${action.supplySourceId}`,
  );

function existing(
  input: Partial<ExistingDocument> & { supplySourceId: string | null },
): ExistingDocument {
  return {
    documentId: `doc-${input.supplySourceId ?? "whole"}`,
    countCode: "SH-1050",
    status: "written",
    present: true,
    paid: false,
    retired: false,
    lines: [],
    ...input,
  };
}

/* -------------------------------------------------------------------------- */
/* The default                                                                */
/* -------------------------------------------------------------------------- */

describe("the default", () => {
  it("splits per warehouse, so no existing shop changes shape", () => {
    expect(SALES_ORDER_DEFAULTS.salesOrderSplit).toBe("per_warehouse");
  });
});

/* -------------------------------------------------------------------------- */
/* The diff                                                                   */
/* -------------------------------------------------------------------------- */

describe("an unsplit shop's first order", () => {
  it("plans exactly one document, keyed to no warehouse", () => {
    const actions = planDocuments({
      desired: [
        {
          supplySourceId: WHOLE_ORDER_DOCUMENT,
          lines: [
            { sku: "A", quantity: 2 },
            { sku: "B", quantity: 1 },
          ],
        },
      ],
      existing: [],
    });

    expect(kinds(actions)).toEqual([`create:${WHOLE_ORDER_DOCUMENT}`]);
  });
});

describe("an unsplit shop reconciling an unchanged order", () => {
  it("writes nothing, however many times it runs", () => {
    const actions = planDocuments({
      desired: [
        {
          supplySourceId: WHOLE_ORDER_DOCUMENT,
          lines: [{ sku: "A", quantity: 2 }],
        },
      ],
      existing: [
        existing({
          supplySourceId: WHOLE_ORDER_DOCUMENT,
          lines: [{ sku: "A", quantity: 2 }],
        }),
      ],
    });

    expect(kinds(actions)).toEqual([`unchanged:${WHOLE_ORDER_DOCUMENT}`]);
  });
});

describe("a shop that turns the split off", () => {
  /*
   * The case this setting exists for, and the one with something to get wrong.
   * The per-warehouse documents MetaKocka already holds describe goods the one
   * new document is about to describe again — so they have to be retired in the
   * same pass, or the order exists twice in the ERP.
   */
  it("retires the per-warehouse documents and writes one for the order", () => {
    const actions = planDocuments({
      desired: [
        {
          supplySourceId: WHOLE_ORDER_DOCUMENT,
          lines: [
            { sku: "A", quantity: 2 },
            { sku: "B", quantity: 1 },
          ],
        },
      ],
      existing: [
        existing({
          supplySourceId: "main",
          countCode: "SH-1050-MAIN",
          lines: [{ sku: "A", quantity: 2 }],
        }),
        existing({
          supplySourceId: "spare",
          countCode: "SH-1050-SPARE",
          lines: [{ sku: "B", quantity: 1 }],
        }),
      ],
    });

    expect(kinds(actions)).toEqual([
      `create:${WHOLE_ORDER_DOCUMENT}`,
      "retire:SH-1050-MAIN",
      "retire:SH-1050-SPARE",
    ]);
  });
});

describe("a shop that turns the split back on", () => {
  it("retires the whole-order document and writes one per warehouse", () => {
    /*
     * Under a split shop the caller passes the stored null through unchanged,
     * because there it means what it has always meant: a document this order
     * takes nothing from.
     */
    const actions = planDocuments({
      desired: [
        { supplySourceId: "main", lines: [{ sku: "A", quantity: 2 }] },
        { supplySourceId: "spare", lines: [{ sku: "B", quantity: 1 }] },
      ],
      existing: [
        existing({ supplySourceId: null, countCode: "SH-1050" }),
      ],
    });

    expect(kinds(actions)).toEqual([
      "create:main",
      "create:spare",
      "retire:SH-1050",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* The money                                                                  */
/* -------------------------------------------------------------------------- */

describe("the money on an unsplit order", () => {
  it("is one share carrying the whole charge, to the cent", () => {
    const shares = splitOrderMoney({
      perSource: [
        {
          sourceId: WHOLE_ORDER_DOCUMENT,
          sourceCode: "SH-1050",
          kind: "own",
          lineTotalMinor: 20900,
        },
      ],
      orderTotalMinor: 21400,
      shippingMinor: 990,
      discountMinor: 490,
    });

    expect(shares).toHaveLength(1);
    expect(shares[0]!.isPrimary).toBe(true);
    expect(shares[0]!.shippingMinor).toBe(990);
    expect(shares[0]!.discountMinor).toBe(490);
    // The rounding remainder lands on the primary, so one document adds up to
    // the Shopify total exactly — which is what the payment path relies on.
    expect(shares[0]!.totalMinor).toBe(21400);
  });
});

/* -------------------------------------------------------------------------- */
/* The verification                                                           */
/* -------------------------------------------------------------------------- */

const lines: CanonicalLine[] = [
  {
    shopifyLineItemId: "l1",
    sku: "A",
    title: "A thing",
    quantity: 2,
    unitPriceWithTaxMinor: 5000,
    discountMinor: 0,
    taxFactor: "0.22",
  },
  {
    shopifyLineItemId: "l2",
    sku: "B",
    title: "Another thing",
    quantity: 1,
    unitPriceWithTaxMinor: 10900,
    discountMinor: 0,
    taxFactor: "0.22",
  },
];

/**
 * What the reconciler states for an unsplit order: every unit is on the one
 * document, so every unit is managed.
 */
const classification = classifyQuantities(lines, [
  {
    shopifyLocationId: null,
    supplySourceId: null,
    disposition: "managed",
    lines: lines.map((line) => ({
      shopifyLineItemId: line.shopifyLineItemId,
      quantity: line.quantity,
    })),
  },
]);

describe("verifying an unsplit order", () => {
  it("counts every unit as represented, with nothing unresolved", () => {
    expect(classification.managedTotal).toBe(3);
    expect(classification.unresolvedTotal).toBe(0);
    expect(classification.externalTotal).toBe(0);
  });

  it("reconciles the one document against the whole order", () => {
    const verification = verifyOrder({
      lines,
      classification,
      documents: [
        {
          countCode: "SH-1050",
          retired: false,
          requestBody: {
            product_list: [
              { code: "A", amount: 2, price_with_tax: "50.00" },
              { code: "B", amount: 1, price_with_tax: "109.00" },
              { code: "SHIPPING", amount: 1, price_with_tax: "9.90" },
            ],
          },
        },
      ],
      orderTotalMinor: 21890,
      shippingMinor: 990,
      orderDiscountMinor: 0,
      shippingProductCode: "SHIPPING",
      discountConfigured: true,
      grossReceivedMinor: 0,
      representedPaymentMinor: 0,
    });

    expect(verification.quantities.expectedTotal).toBe(3);
    expect(verification.quantities.actualTotal).toBe(3);
    expect(verification.ok).toBe(true);
  });

  it("still catches a document short of the order", () => {
    const verification = verifyOrder({
      lines,
      classification,
      documents: [
        {
          countCode: "SH-1050",
          retired: false,
          requestBody: {
            product_list: [{ code: "A", amount: 2, price_with_tax: "50.00" }],
          },
        },
      ],
      orderTotalMinor: 21890,
      shippingMinor: 990,
      orderDiscountMinor: 0,
      shippingProductCode: "SHIPPING",
      discountConfigured: true,
      grossReceivedMinor: 0,
      representedPaymentMinor: 0,
    });

    expect(verification.ok).toBe(false);
    expect(verification.quantities.actualTotal).toBe(2);
  });
});
