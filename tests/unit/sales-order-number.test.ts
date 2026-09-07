import { describe, expect, it } from "vitest";

import {
  buildSalesOrderBody,
  type SalesOrderInput,
} from "~/adapters/metakocka/documents";
import { SALES_ORDER_DEFAULTS } from "~/adapters/db/repositories/sales-order-setting.server";
import {
  DEFAULT_CUSTOMER_ORDER_TEMPLATE,
  MAX_ORDER_REFERENCE_LENGTH,
  salesOrderNumberFor,
  type OrderReferenceContext,
} from "~/domain/orders/reference";

/**
 * The number a MetaKocka sales order is filed under (`count_code`).
 *
 * MetaKocka's screen labels it *Sales ord. no.*, and until this setting existed
 * it was always the customer's order reference plus the warehouse code — so a
 * merchant whose books are kept in MetaKocka got `SH-1050-GLAVNO` where their
 * accountant expected `1/2026`.
 *
 * The rule that must not bend while that becomes a choice: **`count_code` is a
 * number, never an identity.** §3 verified MetaKocka does not enforce
 * uniqueness on it, so this app has always identified documents by the Shopify
 * order id and its own `(shop_id, count_code)` claim. That claim is derived
 * from the frozen `customer_order_ref` and is untouched by anything here, which
 * is what makes both choices — and switching between them — safe.
 */

const context: OrderReferenceContext = {
  name: "#1050",
  number: "1050",
  id: "gid://shopify/Order/1050",
  customerEmail: "buyer@example.test",
};

describe("the default", () => {
  it("numbers documents from the app, as this connector always has", () => {
    expect(SALES_ORDER_DEFAULTS.salesOrderNumbering).toBe("app");
    expect(SALES_ORDER_DEFAULTS.salesOrderNumberTemplate).toBeNull();
  });

  /*
   * The default is the customer's order reference *itself*, not a second copy
   * of `DEFAULT_CUSTOMER_ORDER_TEMPLATE`. A merchant who customised their
   * reference gets a document number that still matches it — and the two can
   * never drift apart, which a copied default would guarantee they eventually
   * did.
   */
  it("follows a customised reference rather than the default pattern", () => {
    expect(
      salesOrderNumberFor({
        numbering: "app",
        template: null,
        customerOrderRef: "WEB/1050",
        context,
        sourceCode: null,
      }),
    ).toBe("WEB/1050");

    expect(DEFAULT_CUSTOMER_ORDER_TEMPLATE).toBe("SH-{order.number}");
  });
});

describe("a pattern of the merchant's own", () => {
  it("renders it against their order", () => {
    expect(
      salesOrderNumberFor({
        numbering: "app",
        template: "ORD-{order.number}",
        customerOrderRef: "SH-1050",
        context,
        sourceCode: null,
      }),
    ).toBe("ORD-1050");
  });

  /*
   * Sibling documents cannot share a number, and the merchant is not asked to
   * write a pattern that guarantees that.
   */
  it("suffixes the warehouse on a split order", () => {
    expect(
      salesOrderNumberFor({
        numbering: "app",
        template: "ORD-{order.number}",
        customerOrderRef: "SH-1050",
        context,
        sourceCode: "GLAVNO",
      }),
    ).toBe("ORD-1050-GLAVNO");
  });

  /*
   * A pattern that renders to nothing for this particular order — a guest
   * checkout under `{customer.email}` — falls back rather than producing a
   * document with a blank number, which MetaKocka would silently fill in with
   * its own for exactly the orders that tripped it.
   */
  it("falls back rather than sending nothing", () => {
    const number = salesOrderNumberFor({
      numbering: "app",
      template: "{customer.email}",
      customerOrderRef: "SH-1050",
      context: { ...context, customerEmail: null },
      sourceCode: null,
    });

    expect(number).toBe("SH-1050");
  });

  it("never exceeds the reference length MetaKocka is sent", () => {
    const number = salesOrderNumberFor({
      numbering: "app",
      template: "X".repeat(MAX_ORDER_REFERENCE_LENGTH),
      customerOrderRef: "SH-1050",
      context,
      sourceCode: "GLAVNO",
    });

    expect(number!.length).toBeLessThanOrEqual(MAX_ORDER_REFERENCE_LENGTH);
  });
});

describe("letting MetaKocka number them", () => {
  it("produces no number at all", () => {
    expect(
      salesOrderNumberFor({
        numbering: "metakocka",
        template: "ORD-{order.number}",
        customerOrderRef: "SH-1050",
        context,
        sourceCode: "GLAVNO",
      }),
    ).toBeNull();
  });

  /*
   * The mechanism, and the one thing that has to be true of the body: the field
   * is **absent**, not empty. §3 records that MetaKocka validates almost
   * nothing, so an empty string is a value it would accept and file under.
   */
  it("omits count_code from the document body", () => {
    const body = buildSalesOrderBody(salesOrder(null)) as Record<
      string,
      unknown
    >;

    expect("count_code" in body).toBe(false);
    // The reference still goes, because it is what links siblings and what the
    // ambiguous-write recovery searches by.
    expect(body.buyer_order).toBe("SH-1050");
  });

  it("sends it when the app does the numbering", () => {
    const body = buildSalesOrderBody(salesOrder("ORD-1050")) as Record<
      string,
      unknown
    >;

    expect(body.count_code).toBe("ORD-1050");
  });
});

function salesOrder(countCode: string | null): SalesOrderInput {
  return {
    countCode,
    buyerOrder: "SH-1050",
    docDate: new Date("2026-08-29T10:00:00.000Z"),
    currencyCode: "EUR",
    partner: { customer: "Buyer", street: "Street 1", place: "Ljubljana" },
    lines: [
      {
        code: "SKU-1",
        amount: 1,
        priceWithTaxMinor: 5000,
        taxFactor: "0.22",
      },
    ],
  };
}
