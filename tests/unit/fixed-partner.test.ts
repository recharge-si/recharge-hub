import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildSalesOrderBody } from "~/adapters/metakocka/documents";
import { parseOrder } from "~/adapters/shopify/order-payload";
import {
  choosePartner,
  parsePartnerOverride,
  type PartnerOverride,
} from "~/domain/orders/partner";

/**
 * One MetaKocka customer for every sales order: the precedence between a
 * partner entered on the order, the shop's fixed partner and the Shopify
 * customer, and what reaches the sales order body when the fixed one wins.
 */

const FIXED: PartnerOverride = {
  customer: "Spletna prodaja",
  street: "Trzaska cesta 1",
  postNumber: "1000",
  place: "Ljubljana",
  country: "Slovenia",
  isBusiness: false,
  taxNumber: null,
  email: null,
  phone: null,
};

const ON_ORDER: PartnerOverride = {
  ...FIXED,
  customer: "Hand-entered buyer",
};

const BILLING = { customer: "Janez Novak" };
const SHIPPING = { customer: "Gift receiver" };

describe("choosePartner", () => {
  it("files against the Shopify billing customer when nothing is set", () => {
    expect(
      choosePartner({
        override: null,
        fixed: null,
        billing: BILLING,
        shipping: SHIPPING,
      }),
    ).toEqual({ source: "shopify", partner: BILLING });
  });

  it("falls back to the shipping address without a billing one", () => {
    expect(
      choosePartner({
        override: null,
        fixed: null,
        billing: null,
        shipping: SHIPPING,
      }),
    ).toEqual({ source: "shopify", partner: SHIPPING });
  });

  it("uses the shop's fixed partner over the Shopify customer", () => {
    expect(
      choosePartner({
        override: null,
        fixed: FIXED,
        billing: BILLING,
        shipping: SHIPPING,
      }),
    ).toEqual({ source: "fixed", partner: FIXED });
  });

  it("uses the fixed partner for an order Shopify has no address on", () => {
    expect(
      choosePartner({
        override: null,
        fixed: FIXED,
        billing: null,
        shipping: null,
      })?.source,
    ).toBe("fixed");
  });

  it("lets a partner entered on the order win over the fixed one", () => {
    expect(
      choosePartner({
        override: ON_ORDER,
        fixed: FIXED,
        billing: BILLING,
        shipping: SHIPPING,
      }),
    ).toEqual({ source: "order", partner: ON_ORDER });
  });

  it("has no partner when there is nothing at all", () => {
    expect(
      choosePartner({
        override: null,
        fixed: null,
        billing: null,
        shipping: null,
      }),
    ).toBeNull();
  });

  it("reads a stored fixed partner back, and ignores a broken one", () => {
    expect(parsePartnerOverride(JSON.parse(JSON.stringify(FIXED)))).toEqual(
      FIXED,
    );
    expect(parsePartnerOverride({ street: "no name" })).toBeNull();
  });
});

describe("a sales order filed against the fixed partner", () => {
  const order = parseOrder(
    JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          "tests/fixtures/shopify/orders_create_split.json",
        ),
        "utf8",
      ),
    ),
  );

  const chosen = choosePartner({
    override: null,
    fixed: FIXED,
    billing: order.partner,
    shipping: order.receiver,
  });

  const body = buildSalesOrderBody({
    countCode: "SH-1042",
    buyerOrder: "SH-1042",
    docDate: order.createdAt!,
    currencyCode: order.currency,
    partner: chosen!.partner,
    receiver: order.receiver,
    warehouse: null,
    profitCenter: null,
    lines: [
      {
        code: "MAST-490",
        amount: 1,
        priceWithTaxMinor: 5999,
        taxFactor: "0.22",
      },
    ],
  });

  it("names the fixed partner, not the Shopify buyer", () => {
    expect(body.partner).toMatchObject({
      customer: "Spletna prodaja",
      street: "Trzaska cesta 1",
    });
    expect(JSON.stringify(body.partner)).not.toContain("Janez Novak");
  });

  it("keeps the line's own VAT, so the tax treatment does not move", () => {
    expect(body.product_list[0]?.tax_factor).toBe("0.22");
  });
});
