import { describe, expect, it } from "vitest";

import { decideOrderTransfer, receivedAtFor } from "~/domain/orders/transfer";

/**
 * An order placed before transfer was switched on, first seen later through an
 * edit or a refund, must not be sent: the merchant filed it by hand.
 */
describe("receivedAtFor", () => {
  const now = new Date("2026-11-27T13:00:00Z");

  it("counts an old order from when Shopify placed it", () => {
    const placed = new Date("2026-11-23T15:56:02Z");
    expect(receivedAtFor(placed, now)).toEqual(placed);
  });

  it("never dates an order in the future", () => {
    expect(receivedAtFor(new Date("2026-11-27T13:00:05Z"), now)).toEqual(now);
    expect(receivedAtFor(null, now)).toEqual(now);
  });

  it("keeps an order placed before the cut-off out of MetaKocka", () => {
    const settings = {
      transferOrders: true,
      transferOrdersSince: new Date("2026-11-27T12:52:10Z"),
    };
    const late = receivedAtFor(new Date("2026-11-23T15:56:02Z"), now);
    expect(
      decideOrderTransfer(settings, { receivedAt: late, hasDocuments: false }),
    ).toEqual({ allowed: false, reason: "received_while_off" });
  });
});
