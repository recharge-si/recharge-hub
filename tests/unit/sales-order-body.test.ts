import { describe, expect, it } from "vitest";

import {
  buildSalesOrderBody,
  minorToDecimalString,
  toDocumentDate,
  toPaymentDate,
} from "~/adapters/metakocka/documents";
import { allocate } from "~/domain/allocation/allocate";
import { DEFAULT_RULE } from "~/domain/allocation/types";
import { splitOrderMoney } from "~/domain/money/split";

/**
 * CLAUDE.md section 12 asks for one test that runs the v1 slice and asserts the
 * MetaKocka request bodies field by field. This is that test, built around the
 * demo in section 13: an order for 8 units where own stock is 5 splits 5/3 and
 * lands as two documents whose totals sum to the Shopify total.
 *
 * It stops short of the network. The allocator, the money split and the body
 * builder are the parts that decide what MetaKocka is told, and they are all
 * pure — so the assertions here are about the exact payload, not about whether
 * an HTTP call was made.
 */

const DOC_DATE = new Date("2026-08-25T09:30:00.000Z");

describe("the section 13 demo, end to end through the pure layers", () => {
  const supply = [
    {
      sourceId: "own-1",
      sourceCode: "OWN",
      sku: "MAST-490",
      available: 5,
      kind: "own" as const,
      priority: 10,
      canSplit: true,
      enabled: true,
    },
    {
      sourceId: "partner-1",
      sourceCode: "PARTNER",
      sku: "MAST-490",
      available: 50,
      kind: "partner" as const,
      priority: 20,
      canSplit: true,
      enabled: true,
    },
  ];

  const { allocations, shortfalls } = allocate({
    lines: [{ lineId: "line-1", sku: "MAST-490", quantity: 8 }],
    supply,
    rules: [DEFAULT_RULE],
    now: DOC_DATE,
  });

  // 59.99 each, tax included.
  const unitMinor = 5999;
  const shippingMinor = 499;
  const orderTotalMinor = 8 * unitMinor + shippingMinor;

  it("splits 5 from own stock and 3 from the partner", () => {
    expect(shortfalls).toEqual([]);
    expect(allocations.map((a) => [a.sourceId, a.quantity])).toEqual([
      ["own-1", 5],
      ["partner-1", 3],
    ]);
  });

  const shares = splitOrderMoney({
    perSource: [
      {
        sourceId: "own-1",
        sourceCode: "OWN",
        kind: "own",
        lineTotalMinor: 5 * unitMinor,
      },
      {
        sourceId: "partner-1",
        sourceCode: "PARTNER",
        kind: "partner",
        lineTotalMinor: 3 * unitMinor,
      },
    ],
    orderTotalMinor,
    shippingMinor,
    discountMinor: 0,
  });

  it("makes the larger document primary and gives it the shipping", () => {
    const primary = shares.find((share) => share.isPrimary)!;
    expect(primary.sourceId).toBe("own-1");
    expect(primary.shippingMinor).toBe(shippingMinor);
    expect(shares.find((s) => !s.isPrimary)?.shippingMinor).toBe(0);
  });

  it("the two documents sum to the Shopify total exactly", () => {
    const sum = shares.reduce((total, share) => total + share.totalMinor, 0);
    expect(sum).toBe(orderTotalMinor);
  });

  const partner = {
    customer: "Janez Novak",
    street: "Slovenska cesta 100",
    postNumber: "1000",
    place: "Ljubljana",
    country: "Slovenia",
    isBusiness: false,
    email: "janez@example.com",
    phone: null,
  };

  const bodyFor = (sourceCode: string, warehouse: string, quantity: number) =>
    buildSalesOrderBody({
      countCode: `SH-1042-${sourceCode}`,
      buyerOrder: "SH-1042",
      docDate: DOC_DATE,
      currencyCode: "EUR",
      partner,
      receiver: null,
      warehouse,
      profitCenter: "ProfitCenter1",
      lines: [
        {
          code: "MAST-490",
          amount: quantity,
          priceWithTaxMinor: unitMinor,
          taxFactor: "0.22",
        },
      ],
    });

  it("builds the own-warehouse document field by field", () => {
    expect(bodyFor("OWN", "glavno", 5)).toEqual({
      doc_type: "sales_order",
      count_code: "SH-1042-OWN",
      doc_date: "25.08.2026",
      currency_code: "EUR",
      buyer_order: "SH-1042",
      partner: {
        business_entity: "false",
        taxpayer: "false",
        foreign_county: "false",
        tax_id_number: "",
        customer: "Janez Novak",
        street: "Slovenska cesta 100",
        post_number: "1000",
        place: "Ljubljana",
        country: "Slovenia",
        partner_contact: {
          name: "Janez Novak",
          email: "janez@example.com",
        },
      },
      warehouse: "glavno",
      profit_center: "ProfitCenter1",
      product_list: [
        {
          code: "MAST-490",
          amount: "5",
          price_with_tax: "59.99",
          tax_factor: "0.22",
        },
      ],
    });
  });

  it("builds the partner document against its own warehouse", () => {
    const body = bodyFor("PARTNER", "partner", 3);
    expect(body.count_code).toBe("SH-1042-PARTNER");
    expect(body.warehouse).toBe("partner");
    expect(body.product_list[0]?.amount).toBe("3");
    // Both documents carry the same buyer_order: that is what links them (§3).
    expect(body.buyer_order).toBe("SH-1042");
  });

  it("sends no name or unit, so a line can only ever be a catalogue product", () => {
    /*
     * MetaKocka answers an unknown code with
     * "Product with code X not found - unit must be set to add new product" —
     * an invitation to have order lines create catalogue entries. It also
     * overrides any name sent with the catalogue's own, so a name achieves
     * nothing for a product that exists and describes a manual line for one
     * that does not. Neither field is ever sent.
     */
    const line = bodyFor("OWN", "glavno", 5).product_list[0]!;
    expect(Object.keys(line)).not.toContain("name");
    expect(Object.keys(line)).not.toContain("unit");
  });

  it("carries the pricelist the order is priced against", () => {
    const body = buildSalesOrderBody({
      countCode: "SH-1042-OWN",
      buyerOrder: "SH-1042",
      docDate: DOC_DATE,
      currencyCode: "EUR",
      partner,
      salesPricelistCode: "1",
      lines: [],
    });
    expect(body.sales_pricelist_code).toBe("1");
  });

  it("omits the pricelist rather than sending an empty one", () => {
    const body = buildSalesOrderBody({
      countCode: "SH-1042-OWN",
      buyerOrder: "SH-1042",
      docDate: DOC_DATE,
      currencyCode: "EUR",
      partner,
      salesPricelistCode: null,
      lines: [],
    });
    expect(Object.keys(body)).not.toContain("sales_pricelist_code");
  });

  describe("the partner", () => {
    /*
     * Verified against company 6789: inline partner data does not match an
     * existing record, it creates another one. Two documents for the same
     * customer left two "Grega Rotar" partners behind. A resolved partner is
     * referenced instead, and MetaKocka then creates nothing.
     */
    const resolved = {
      ...partner,
      mkId: "400071680303",
      mkAddressId: "400082841143",
    };

    it("references a resolved partner rather than redescribing it", () => {
      const body = buildSalesOrderBody({
        countCode: "SH-1042-OWN",
        buyerOrder: "SH-1042",
        docDate: DOC_DATE,
        currencyCode: "EUR",
        partner: resolved,
        lines: [],
      });

      expect(body.partner).toEqual({
        mk_id: "400071680303",
        mk_address_id: "400082841143",
        customer: "Janez Novak",
        street: "Slovenska cesta 100",
      });
    });

    it("keeps the address identification, which MetaKocka insists on", () => {
      // "Partner must have mk_address_id or customer and street for address
      // identification." An id on its own is refused.
      const body = buildSalesOrderBody({
        countCode: "SH-1042-OWN",
        buyerOrder: "SH-1042",
        docDate: DOC_DATE,
        currencyCode: "EUR",
        partner: { ...resolved, mkAddressId: null },
        lines: [],
      });

      const sent = body.partner as Record<string, unknown>;
      expect(sent.mk_id).toBe("400071680303");
      expect(sent.customer).toBe("Janez Novak");
      expect(sent.street).toBe("Slovenska cesta 100");
    });

    it("falls back to full details when nothing has been resolved", () => {
      const body = buildSalesOrderBody({
        countCode: "SH-1042-OWN",
        buyerOrder: "SH-1042",
        docDate: DOC_DATE,
        currencyCode: "EUR",
        partner,
        lines: [],
      });

      const sent = body.partner as Record<string, unknown>;
      expect(sent.mk_id).toBeUndefined();
      expect(sent.post_number).toBe("1000");
      expect(sent.country).toBe("Slovenia");
    });
  });

  it("never sends customer_order, which MetaKocka silently discards", () => {
    expect(Object.keys(bodyFor("OWN", "glavno", 5))).not.toContain(
      "customer_order",
    );
  });

  it("never sets create_invoice: invoicing stays a merchant decision", () => {
    expect(Object.keys(bodyFor("OWN", "glavno", 5))).not.toContain(
      "create_invoice",
    );
  });

  it("omits an absent warehouse rather than sending an empty string", () => {
    const body = buildSalesOrderBody({
      countCode: "SH-1042-X",
      buyerOrder: "SH-1042",
      docDate: DOC_DATE,
      currencyCode: "EUR",
      partner,
      lines: [],
      warehouse: null,
    });
    expect(Object.keys(body)).not.toContain("warehouse");
  });
});

describe("money and dates on the wire", () => {
  it("writes minor units without ever touching a float", () => {
    expect(minorToDecimalString(5999)).toBe("59.99");
    expect(minorToDecimalString(0)).toBe("0.00");
    expect(minorToDecimalString(5)).toBe("0.05");
    expect(minorToDecimalString(100)).toBe("1.00");
    expect(minorToDecimalString(-250)).toBe("-2.50");
    expect(minorToDecimalString(123456789)).toBe("1234567.89");
  });

  describe("the document date", () => {
    /*
     * Verified against company 6789 by probing put_document with an invalid
     * profit centre, which MetaKocka refuses before creating anything. The
     * headline: "+02:00" is a literal it insists on, not a timezone. "+01:00"
     * is refused in January as readily as in August, and "+02:00" is accepted
     * in January — so any implementation that computed the real Ljubljana
     * offset would break every document from late October to late March.
     * dd.mm.yyyy sidesteps the whole trap and is what mark_paid already uses.
     */
    it("is dd.mm.yyyy, the format MetaKocka accepts", () => {
      expect(toDocumentDate(new Date("2026-08-25T09:52:00Z"))).toBe(
        "25.08.2026",
      );
    });

    it("stays dd.mm.yyyy in winter, when an offset would have changed", () => {
      expect(toDocumentDate(new Date("2026-01-15T09:00:00Z"))).toBe(
        "15.01.2026",
      );
    });

    it("never emits an ISO offset, which is the shape that was rejected", () => {
      const instants = [
        "2026-08-25T09:52:00Z",
        "2026-01-15T23:59:59Z",
        "2026-03-29T01:30:00Z",
        "2026-10-25T01:30:00Z",
        "2026-12-31T23:00:00Z",
      ];
      for (const instant of instants) {
        const formatted = toDocumentDate(new Date(instant));
        expect(formatted).not.toContain("+");
        expect(formatted).not.toContain("-");
        expect(formatted).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
      }
    });

    it("books a late foreign order on the ERP's day", () => {
      // 23:30 in New York on the 25th is 05:30 on the 26th in Ljubljana, and a
      // Slovenian company books it on the 26th.
      expect(toDocumentDate(new Date("2026-08-26T03:30:00Z"))).toBe(
        "26.08.2026",
      );
    });

    it("can be pointed at another zone if a company books elsewhere", () => {
      expect(
        toDocumentDate(new Date("2026-08-26T03:30:00Z"), "America/New_York"),
      ).toBe("25.08.2026");
    });
  });

  it("uses dd.mm.yyyy for mark_paid too, in the ERP timezone", () => {
    expect(toPaymentDate(new Date("2011-03-12T00:00:00Z"))).toBe("12.03.2011");
    expect(toPaymentDate(new Date("2026-08-25T23:30:00Z"))).toBe("26.08.2026");
  });
});
