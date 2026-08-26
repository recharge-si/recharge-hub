import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildSalesOrderBody,
  toDocumentDate,
} from "~/adapters/metakocka/documents";
import {
  minimiseOrderPayload,
  parseOrder,
} from "~/adapters/shopify/order-payload";
import { allocate } from "~/domain/allocation/allocate";
import { DEFAULT_RULE } from "~/domain/allocation/types";
import { splitOrderMoney } from "~/domain/money/split";

/**
 * CLAUDE.md §12: one test that runs the v1 slice — webhook in, allocations
 * out, two MetaKocka request bodies asserted field by field.
 *
 * It starts from a **recorded webhook payload on disk**, not from hand-built
 * inputs, and that is the point. `sales-order-body.test.ts` already pins what
 * the body builder does with a parsed order; what nothing pinned was the
 * join — that the parser's output is the shape the allocator and the money
 * split actually consume, with the same SKUs, the same minor units and the
 * same currency. Every bug this file exists to catch lives in that seam: a
 * price read from the wrong field, a quantity that never reaches the
 * allocator, a total the two documents no longer sum to.
 *
 * The demo is the one in §13: eight units where own stock is five, split 5/3
 * across two supply sources, landing as two MetaKocka documents.
 *
 * It stops at the network on purpose. §12 forbids a live ERP in tests, and
 * everything downstream of `buildSalesOrderBody` is the HTTP client, which has
 * its own tests against recorded fixtures.
 */

const PAYLOAD: unknown = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "tests/fixtures/shopify/orders_create_split.json"),
    "utf8",
  ),
);

/** What the two supply sources are configured as (§6, `supply_source`). */
interface Source {
  sourceId: string;
  sourceCode: string;
  kind: "own" | "partner";
  priority: number;
  warehouse: string;
  profitCenter: string;
}

const SOURCES: Record<"own" | "partner", Source> = {
  own: {
    sourceId: "own-1",
    sourceCode: "GLAVNO",
    kind: "own",
    priority: 10,
    warehouse: "glavno",
    profitCenter: "ProfitCenter1",
  },
  partner: {
    sourceId: "partner-1",
    sourceCode: "PARTNER1",
    kind: "partner",
    priority: 20,
    warehouse: "partner",
    profitCenter: "ProfitCenter1",
  },
};

describe("an order webhook becomes two MetaKocka sales orders", () => {
  const order = parseOrder(PAYLOAD);

  it("reads the order the webhook actually sent", () => {
    expect(order.shopifyOrderId).toBe("5551234567890");
    expect(order.orderNumber).toBe("1042");
    expect(order.currency).toBe("EUR");
    expect(order.financialStatus).toBe("paid");
    expect(order.taxesIncluded).toBe(true);
    // 8 x 59.99 plus 4.99 shipping.
    expect(order.totalMinor).toBe(48491);
    expect(order.shippingMinor).toBe(499);
    expect(order.discountMinor).toBe(0);
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0]).toMatchObject({
      sku: "MAST-490",
      quantity: 8,
      unitPriceWithTaxMinor: 5999,
      // Derived from the line's own tax lines, never a product default (§8.6).
      taxFactor: "0.22",
    });
    expect(order.partner?.customer).toBe("Janez Novak");
  });

  it("does not store the shopper's browser (§2.4)", () => {
    const stored = minimiseOrderPayload(PAYLOAD);
    expect(JSON.stringify(stored)).not.toContain("81.4.6.10");
    expect(JSON.stringify(stored)).not.toContain("user_agent");
  });

  const { allocations, shortfalls } = allocate({
    lines: order.lines.map((line, index) => ({
      lineId: `line-${index}`,
      sku: line.sku,
      quantity: line.quantity,
    })),
    supply: [
      {
        ...SOURCES.own,
        sku: "MAST-490",
        available: 5,
        canSplit: true,
        enabled: true,
      },
      {
        ...SOURCES.partner,
        sku: "MAST-490",
        available: 50,
        canSplit: true,
        enabled: true,
      },
    ],
    rules: [DEFAULT_RULE],
    now: order.createdAt!,
  });

  it("splits the line 5 from own stock and 3 from the partner", () => {
    expect(shortfalls).toEqual([]);
    expect(allocations.map((a) => [a.sourceId, a.quantity])).toEqual([
      ["own-1", 5],
      ["partner-1", 3],
    ]);
  });

  /** Line value per source, exactly as `jobs/order-shares` computes it. */
  const perSource = [SOURCES.own, SOURCES.partner].map((source) => ({
    sourceId: source.sourceId,
    sourceCode: source.sourceCode,
    kind: source.kind,
    lineTotalMinor: allocations
      .filter((allocation) => allocation.sourceId === source.sourceId)
      .reduce(
        (total, allocation) =>
          total + allocation.quantity * order.lines[0]!.unitPriceWithTaxMinor,
        0,
      ),
  }));

  const shares = splitOrderMoney({
    perSource,
    orderTotalMinor: order.totalMinor,
    shippingMinor: order.shippingMinor,
    discountMinor: order.discountMinor,
  });

  it("puts the shipping on the primary document and only there (§8.6)", () => {
    const primary = shares.find((share) => share.isPrimary)!;
    expect(primary.sourceCode).toBe("GLAVNO");
    expect(primary.shippingMinor).toBe(499);
    expect(shares.find((share) => !share.isPrimary)?.shippingMinor).toBe(0);
  });

  it("the two documents sum to the Shopify total, to the cent", () => {
    expect(shares.reduce((sum, share) => sum + share.totalMinor, 0)).toBe(
      order.totalMinor,
    );
  });

  /* ---------------------------------------------------------------------- */
  /* The request bodies, field by field                                     */
  /* ---------------------------------------------------------------------- */

  const bodyFor = (source: Source) =>
    buildSalesOrderBody({
      countCode: `SH-${order.orderNumber}-${source.sourceCode}`,
      buyerOrder: `SH-${order.orderNumber}`,
      docDate: order.createdAt!,
      currencyCode: order.currency,
      // Non-null by construction: the fixture carries a billing address, and
      // §11 is explicit that an order without one is an exception rather than
      // a document.
      partner: order.partner!,
      receiver: null,
      warehouse: source.warehouse,
      profitCenter: source.profitCenter,
      lines: allocations
        .filter((allocation) => allocation.sourceId === source.sourceId)
        .map((allocation) => ({
          code: allocation.sku,
          amount: allocation.quantity,
          priceWithTaxMinor: order.lines[0]!.unitPriceWithTaxMinor,
          taxFactor: order.lines[0]!.taxFactor,
        })),
    });

  it("builds the own-warehouse document", () => {
    expect(bodyFor(SOURCES.own)).toEqual({
      doc_type: "sales_order",
      count_code: "SH-1042-GLAVNO",
      // dd.mm.yyyy, in the ERP's timezone. The ISO form only works with a
      // hardcoded +02:00, which is wrong for five months of the year (§3).
      doc_date: toDocumentDate(order.createdAt!),
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
          email: "janez@example.test",
          phone: "+386 1 234 5678",
          gsm: "+386 1 234 5678",
        },
      },
      warehouse: "glavno",
      profit_center: "ProfitCenter1",
      product_list: [
        {
          code: "MAST-490",
          amount: "5",
          // Gross, because the shop is tax-inclusive (§8.6).
          price_with_tax: "59.99",
          tax_factor: "0.22",
        },
      ],
    });
  });

  it("builds the partner document against its own warehouse", () => {
    const body = bodyFor(SOURCES.partner);

    expect(body.count_code).toBe("SH-1042-PARTNER1");
    expect(body.warehouse).toBe("partner");
    expect(body.profit_center).toBe("ProfitCenter1");
    expect(body.product_list).toEqual([
      {
        code: "MAST-490",
        amount: "3",
        price_with_tax: "59.99",
        tax_factor: "0.22",
      },
    ]);
    // The same buyer_order on both: §3 verified that this, not
    // `customer_order`, is what links sibling documents.
    expect(body.buyer_order).toBe("SH-1042");
  });

  it("sends no unit and no name, so a line can only be a catalogue product", () => {
    // §3: an unknown code plus `unit` makes MetaKocka create the article from
    // the order. Neither field is ever sent.
    for (const source of [SOURCES.own, SOURCES.partner]) {
      for (const line of bodyFor(source).product_list) {
        expect(Object.keys(line)).not.toContain("unit");
        expect(Object.keys(line)).not.toContain("name");
      }
    }
  });

  it("gives the two documents different count_codes, which is the duplicate guard", () => {
    // §8.4: MetaKocka's `count_code` is not unique on its side, so the
    // uniqueness of this string in our own table is the only thing preventing
    // a second document.
    expect(bodyFor(SOURCES.own).count_code).not.toBe(
      bodyFor(SOURCES.partner).count_code,
    );
  });
});
