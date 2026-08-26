import { describe, expect, it } from "vitest";

import { locationKey, sameLocation } from "~/adapters/shopify/locations";
import { documentIsEmpty } from "~/jobs/orders/document-reconciler";

/**
 * Two defects that only a real order could find (E2E pass, 2026-08-26).
 *
 * Both were invisible to every existing test for the same reason: a test that
 * invents the data on both sides of a comparison invents it in the same shape,
 * and a test that mocks MetaKocka mocks away the rule it is trying to learn.
 */

describe("a Shopify location means the same thing in both formats", () => {
  /*
   * The settings screen stores what the Shopify picker gives it — a full GID.
   * The fulfilment-order reader emits the numeric tail, because that is the
   * form the rest of the order pipeline uses. Comparing one against the other
   * missed every time, so under Shopify-driven allocation **no** location could
   * resolve to a supply source: every assignment fell through as unresolved and
   * no order could be filed against the warehouse Shopify had chosen.
   *
   * Total, silent, and passing every unit test in the suite.
   */
  it("reduces a GID and a bare id to the same key", () => {
    expect(locationKey("gid://shopify/Location/120913232136")).toBe("120913232136");
    expect(locationKey("120913232136")).toBe("120913232136");
  });

  it("matches the two forms against each other", () => {
    expect(
      sameLocation("gid://shopify/Location/120913232136", "120913232136"),
    ).toBe(true);
    expect(
      sameLocation("gid://shopify/Location/120913232136", "gid://shopify/Location/120913232136"),
    ).toBe(true);
    expect(sameLocation("120913232136", "121295667464")).toBe(false);
  });

  it("does not treat two absent locations as the same place", () => {
    // Null is "we do not know", and two unknowns are not a match — that would
    // file a third-party fulfilment against whatever warehouse sorted first.
    expect(sameLocation(null, null)).toBe(false);
    expect(sameLocation(undefined, "")).toBe(false);
    expect(locationKey("   ")).toBeNull();
  });

  it("survives a query string on the gid", () => {
    expect(locationKey("gid://shopify/Location/1?x=1")).toBe("1");
  });
});

describe("emptying a MetaKocka document is a one-way operation", () => {
  /*
   * **[verified against company 6789 on 2026-08-26]** MetaKocka accepts an
   * empty `product_list` on a document that has lines, and refuses it on one
   * that does not:
   *
   *   opr_code 6, "Naročila ni mogoče shraniti, ker ne vsebuje artiklov"
   *   (the order cannot be saved because it contains no items)
   *
   * So a reconciliation that re-sends the empty every pass turns a document it
   * had already retired successfully into a permanent error — which is exactly
   * what happened on the first real run: MetaKocka was correct and the order
   * reported itself broken.
   */
  it("recognises a body that already holds nothing", () => {
    expect(documentIsEmpty({ product_list: [] })).toBe(true);
  });

  it("does not mistake a document with lines for an empty one", () => {
    expect(documentIsEmpty({ product_list: [{ code: "SKU-A", amount: "1" }] })).toBe(
      false,
    );
  });

  it("treats a body with no product list at all as not-known-empty", () => {
    // Absent is not the same as empty: a body this app cannot read is one it
    // must not act on, and re-sending would be the destructive direction.
    expect(documentIsEmpty({})).toBe(false);
    expect(documentIsEmpty(null)).toBe(false);
    expect(documentIsEmpty("[redacted]")).toBe(false);
  });
});
