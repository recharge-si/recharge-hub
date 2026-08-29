import { describe, expect, it } from "vitest";

import {
  componentOf,
  computeReadiness,
  describeDirection,
  type ReadinessFacts,
} from "~/domain/readiness";

/**
 * The one definition of "configured" (the product UX brief, section 23).
 *
 * Three screens used to answer this question and they answered it differently,
 * so what is asserted here is not only each verdict but the fact that there is
 * exactly one place producing it. Everything below is a pure call: readiness is
 * shown on the home page and never waits on MetaKocka.
 */

/** A fully configured shop that has finished setup. */
function facts(over: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    metakocka: {
      connected: true,
      verified: true,
      companyId: "6789",
      apiUserEmail: "api@example.test",
    },
    warehouses: { connectedCount: 2, incompleteNames: [] },
    stock: {
      defaultDirection: "mk_to_shopify",
      intoShopifyCount: 2,
      intoMetakockaCount: 0,
      failingNames: [],
    },
    payments: {
      enabled: true,
      seenGateways: ["shopify_payments"],
      mappedGateways: ["shopify_payments"],
      fallback: "Kartica",
    },
    orders: {
      shippingProductCode: "SHIPPING",
      discountRepresentation: "document_discount_value",
      salesOrderSplit: "per_warehouse",
    },
    products: { matched: 40, unmatched: 0 },
    setupCompletedAt: new Date("2026-08-26T09:00:00Z"),
    ...over,
  };
}

describe("computeReadiness", () => {
  it("reports a fully configured, activated shop as ready", () => {
    const readiness = computeReadiness(facts());

    expect(readiness.overall).toBe("ready");
    expect(readiness.blocking).toEqual([]);
    expect(readiness.activated).toBe(true);
    expect(componentOf(readiness, "orders").summary).toBe("Automatic");
  });

  it("reports a fresh install as needing the connection first", () => {
    const readiness = computeReadiness(
      facts({
        metakocka: {
          connected: false,
          verified: false,
          companyId: null,
          apiUserEmail: null,
        },
        warehouses: { connectedCount: 0, incompleteNames: [] },
        stock: {
          defaultDirection: "mk_to_shopify",
          intoShopifyCount: 0,
          intoMetakockaCount: 0,
          failingNames: [],
        },
        payments: {
          enabled: true,
          seenGateways: [],
          mappedGateways: [],
          fallback: null,
        },
        products: { matched: 0, unmatched: 0 },
        setupCompletedAt: null,
      }),
    );

    expect(readiness.overall).toBe("needs_attention");
    expect(readiness.activated).toBe(false);
    expect(componentOf(readiness, "metakocka").summary).toBe("Not connected");
    expect(readiness.blocking.map((entry) => entry.key)).toEqual([
      "metakocka",
      "warehouses",
      "orders",
      "payments",
    ]);
  });

  it("treats saved-but-unverified credentials as not connected yet", () => {
    const readiness = computeReadiness(
      facts({
        metakocka: {
          connected: true,
          verified: false,
          companyId: "6789",
          apiUserEmail: "api@example.test",
        },
      }),
    );

    const metakocka = componentOf(readiness, "metakocka");
    expect(metakocka.status).toBe("needs_attention");
    expect(metakocka.summary).toBe("Not verified");
    // Orders cannot be automatic while the connection is unproven.
    expect(componentOf(readiness, "orders").status).toBe("needs_attention");
  });

  it("blocks activation when a Shopify-counted location has no API user email", () => {
    const readiness = computeReadiness(
      facts({
        metakocka: {
          connected: true,
          verified: true,
          companyId: "6789",
          apiUserEmail: null,
        },
        stock: {
          defaultDirection: "mk_to_shopify",
          intoShopifyCount: 1,
          intoMetakockaCount: 1,
          failingNames: [],
        },
      }),
    );

    const stock = componentOf(readiness, "stock");
    expect(stock.status).toBe("needs_attention");
    expect(stock.required).toBe(true);
    expect(stock.reason).toContain("API user email");
    expect(readiness.blocking.map((entry) => entry.key)).toContain("stock");
  });

  it("does not ask for an API user email when nothing writes into MetaKocka", () => {
    const readiness = computeReadiness(
      facts({
        metakocka: {
          connected: true,
          verified: true,
          companyId: "6789",
          apiUserEmail: null,
        },
      }),
    );

    expect(componentOf(readiness, "stock").status).toBe("ready");
    expect(readiness.overall).toBe("ready");
  });

  it("calls stock disabled, not broken, when the merchant turned it off", () => {
    const readiness = computeReadiness(
      facts({
        stock: {
          defaultDirection: "none",
          intoShopifyCount: 0,
          intoMetakockaCount: 0,
          failingNames: [],
        },
      }),
    );

    const stock = componentOf(readiness, "stock");
    expect(stock.status).toBe("disabled");
    expect(stock.required).toBe(false);
    expect(readiness.overall).toBe("ready");
  });

  it("reports a location that is failing without blocking activation", () => {
    const readiness = computeReadiness(
      facts({
        stock: {
          defaultDirection: "mk_to_shopify",
          intoShopifyCount: 2,
          intoMetakockaCount: 0,
          failingNames: ["Partner Supply"],
        },
      }),
    );

    const stock = componentOf(readiness, "stock");
    expect(stock.status).toBe("needs_attention");
    expect(stock.required).toBe(false);
    expect(stock.reason).toContain("Partner Supply");
    expect(readiness.overall).toBe("ready");
  });

  it("names a half-finished location without calling warehouses broken", () => {
    const readiness = computeReadiness(
      facts({
        warehouses: { connectedCount: 1, incompleteNames: ["Partner Supply"] },
      }),
    );

    const warehouses = componentOf(readiness, "warehouses");
    expect(warehouses.status).toBe("ready");
    expect(warehouses.reason).toContain("Partner Supply");
  });

  /*
   * A shop writing one unsplit sales order files orders with no warehouse on
   * them at all, so telling it that nothing can be filed until a location is
   * mapped is simply untrue. The mapping still matters — stock synchronization
   * has nowhere to run without it — so the component stays required and only
   * the reason changes.
   */
  it("gives an unsplit shop the stock reason for an unmapped location", () => {
    const readiness = computeReadiness(
      facts({
        warehouses: { connectedCount: 0, incompleteNames: [] },
        orders: {
          shippingProductCode: "SHIPPING",
          discountRepresentation: "document_discount_value",
          salesOrderSplit: "single",
        },
      }),
    );

    const warehouses = componentOf(readiness, "warehouses");
    expect(warehouses.status).toBe("needs_attention");
    expect(warehouses.required).toBe(true);
    expect(warehouses.reason).toContain("stock can be synchronized");
    expect(warehouses.reason).not.toContain("before an order can be filed");

    // And orders are not reported as waiting on it, because they are not.
    expect(componentOf(readiness, "orders").status).toBe("ready");
  });

  it("blocks activation while payments have no fallback", () => {
    const readiness = computeReadiness(
      facts({
        payments: {
          enabled: true,
          seenGateways: ["shopify_payments", "cash_on_delivery"],
          mappedGateways: ["shopify_payments"],
          fallback: null,
        },
      }),
    );

    const payments = componentOf(readiness, "payments");
    expect(payments.status).toBe("needs_attention");
    expect(payments.reason).toContain("cannot be recorded");
    expect(readiness.blocking.map((entry) => entry.key)).toContain("payments");
  });

  it("names the methods that fall back once a fallback exists", () => {
    const readiness = computeReadiness(
      facts({
        payments: {
          enabled: true,
          seenGateways: ["shopify_payments", "cash_on_delivery"],
          mappedGateways: ["shopify_payments"],
          fallback: "Kartica",
        },
      }),
    );

    const payments = componentOf(readiness, "payments");
    expect(payments.status).toBe("ready");
    expect(payments.reason).toContain("cash_on_delivery");
    // The fallback is named once, in the summary, because that is the line the
    // order settings card shows on its own.
    expect(payments.summary).toContain("Kartica");
    expect(readiness.overall).toBe("ready");
  });

  it("says every method is covered when only the fallback is set", () => {
    const readiness = computeReadiness(
      facts({
        payments: {
          enabled: true,
          seenGateways: ["shopify_payments"],
          mappedGateways: [],
          fallback: "Kartica",
        },
      }),
    );

    const payments = componentOf(readiness, "payments");
    expect(payments.status).toBe("ready");
    expect(payments.summary).toBe("Every payment method settles into Kartica");
  });

  it("says nothing about payments when the merchant records them by hand", () => {
    const readiness = computeReadiness(
      facts({
        payments: {
          enabled: false,
          seenGateways: ["manual"],
          mappedGateways: [],
          fallback: null,
        },
      }),
    );

    const payments = componentOf(readiness, "payments");
    expect(payments.status).toBe("disabled");
    expect(payments.required).toBe(false);
    expect(readiness.overall).toBe("ready");
  });

  it("notes unconfigured shipping without stopping orders", () => {
    const readiness = computeReadiness(
      facts({
        orders: {
          shippingProductCode: null,
          discountRepresentation: "none",
          salesOrderSplit: "per_warehouse",
        },
      }),
    );

    const orders = componentOf(readiness, "orders");
    expect(orders.status).toBe("ready");
    expect(orders.reason).toContain("Shipping and discounts");
    expect(readiness.overall).toBe("ready");
  });

  it("never lets products block activation", () => {
    const readiness = computeReadiness(
      facts({ products: { matched: 10, unmatched: 4 } }),
    );

    const products = componentOf(readiness, "products");
    expect(products.status).toBe("optional");
    expect(products.required).toBe(false);
    expect(products.reason).toContain("4 Shopify SKUs");
    expect(readiness.overall).toBe("ready");
  });

  it("keeps activation separate from configuration", () => {
    // A shop whose configuration is complete but who never pressed Finish.
    const readiness = computeReadiness(facts({ setupCompletedAt: null }));

    expect(readiness.overall).toBe("ready");
    expect(readiness.activated).toBe(false);
  });

  it("gives every component an action a merchant can follow", () => {
    for (const component of computeReadiness(facts()).components) {
      expect(component.action?.href).toMatch(/^\/app\//);
      expect(component.action?.label.length).toBeGreaterThan(0);
    }
  });
});

describe("describeDirection", () => {
  it("states the flow rather than only the winning side", () => {
    expect(describeDirection("mk_to_shopify")).toEqual({
      countedIn: "MetaKocka",
      flow: "MetaKocka to Shopify",
    });
    expect(describeDirection("shopify_to_mk")).toEqual({
      countedIn: "Shopify",
      flow: "Shopify to MetaKocka",
    });
    expect(describeDirection("none").flow).toBeNull();
  });
});
