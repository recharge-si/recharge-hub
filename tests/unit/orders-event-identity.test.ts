import { describe, expect, it } from "vitest";

import { orderIdOfEvent } from "~/jobs/handlers/orders-event";

/**
 * Which order an order event is about (§8.8). The envelopes differ by topic,
 * and `orders/edited` is the trap: its payload is an order *edit* whose
 * top-level `id` is the id of the edit, with the order id nested inside.
 * Reading only the top level made every edit resolve to "unknown order" and
 * silently dropped it.
 */
describe("orderIdOfEvent", () => {
  it("reads the nested order id from an orders/edited envelope", () => {
    // The shape Shopify documents for orders/edited: an order_edit object.
    const payload = {
      order_edit: {
        id: 966, // the edit's own id — matching this against orders finds nothing
        order_id: 5678901234,
        created_at: "2026-08-25T12:00:00-04:00",
        notify_customer: false,
        line_items: { additions: [], removals: [] },
      },
    };

    expect(orderIdOfEvent(payload)).toBe("5678901234");
  });

  it("reads order_id from a refunds/create envelope", () => {
    expect(
      orderIdOfEvent({ id: 111, order_id: 5678901234, note: "damaged" }),
    ).toBe("5678901234");
  });

  it("reads the top-level id from an orders/delete envelope", () => {
    expect(orderIdOfEvent({ id: 5678901234 })).toBe("5678901234");
  });

  it("answers null for a payload that names no order", () => {
    expect(orderIdOfEvent({ something: "else" })).toBeNull();
    expect(orderIdOfEvent(null)).toBeNull();
    expect(orderIdOfEvent("not an object")).toBeNull();
  });
});
