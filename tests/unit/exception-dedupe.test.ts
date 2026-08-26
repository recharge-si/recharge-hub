import { describe, expect, it } from "vitest";

import { deriveDedupeKey } from "~/adapters/db/repositories/exception.server";

describe("deriveDedupeKey", () => {
  it("derives an order-scoped key from orderId", () => {
    expect(deriveDedupeKey({ orderId: "ord_1" })).toBe("order:ord_1");
  });

  it("prefers an explicit dedupeKey over a derived one", () => {
    // An orderless condition (a location's stock sync) has no orderId to
    // derive from, and a caller that does supply both is trusted to know
    // its own identity better than the order:<id> convention would guess.
    expect(
      deriveDedupeKey({ orderId: "ord_1", dedupeKey: "source:src_1" }),
    ).toBe("source:src_1");
  });

  it("returns null when there is no identity to dedupe against", () => {
    expect(deriveDedupeKey({})).toBeNull();
    expect(deriveDedupeKey({ orderId: null, dedupeKey: null })).toBeNull();
  });
});
