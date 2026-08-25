import { describe, expect, it } from "vitest";

import {
  planDefaultWriteThrough,
  type SourceSnapshot,
} from "~/domain/supply/defaults";

/**
 * The shop default writes through to the sources that inherit it, and to no
 * others. CLAUDE.md §7 puts two limits on that, and both are here.
 */

function source(over: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return {
    id: "a",
    name: "Warehouse A",
    shopifyLocationId: "gid://shopify/Location/1",
    stockDirection: "none",
    stockDirectionInherited: true,
    ...over,
  };
}

describe("planDefaultWriteThrough", () => {
  it("applies the default to a source that inherits", () => {
    const { writes, blocked } = planDefaultWriteThrough(
      [source()],
      "mk_to_shopify",
    );

    expect(writes).toEqual([{ id: "a", direction: "mk_to_shopify" }]);
    expect(blocked).toEqual([]);
  });

  it("leaves an explicit override alone", () => {
    const { writes } = planDefaultWriteThrough(
      [
        source({
          stockDirection: "shopify_to_mk",
          stockDirectionInherited: false,
        }),
      ],
      "mk_to_shopify",
    );

    expect(writes).toEqual([]);
  });

  it("gives a source with no location none, whatever the default says", () => {
    const { writes } = planDefaultWriteThrough(
      [source({ shopifyLocationId: null })],
      "mk_to_shopify",
    );

    expect(writes).toEqual([{ id: "a", direction: "none" }]);
  });

  it("never makes two inherited sources write to one location", () => {
    const { writes, blocked } = planDefaultWriteThrough(
      [
        source({ id: "a", name: "Main" }),
        source({ id: "b", name: "Overflow" }),
      ],
      "mk_to_shopify",
    );

    expect(writes).toEqual([{ id: "a", direction: "mk_to_shopify" }]);
    expect(blocked).toEqual(["Overflow"]);
  });

  it("lets an explicit writer keep its location against the default", () => {
    const { writes, blocked } = planDefaultWriteThrough(
      [
        source({
          id: "chosen",
          name: "Chosen",
          stockDirection: "mk_to_shopify",
          stockDirectionInherited: false,
        }),
        source({ id: "inherits", name: "Inherits" }),
      ],
      "mk_to_shopify",
    );

    expect(writes).toEqual([]);
    expect(blocked).toEqual(["Inherits"]);
  });

  it("does not contend for a location when the default is not mk_to_shopify", () => {
    const { writes, blocked } = planDefaultWriteThrough(
      [
        source({ id: "a", name: "Main" }),
        source({ id: "b", name: "Overflow" }),
      ],
      "shopify_to_mk",
    );

    // Writing Shopify's count into two MetaKocka warehouses is not a loop:
    // each warehouse is a separate destination and Shopify is unchanged.
    expect(writes).toEqual([
      { id: "a", direction: "shopify_to_mk" },
      { id: "b", direction: "shopify_to_mk" },
    ]);
    expect(blocked).toEqual([]);
  });

  it("turns everything off when the default is none", () => {
    const { writes } = planDefaultWriteThrough(
      [source({ id: "a" }), source({ id: "b" })],
      "none",
    );

    expect(writes).toEqual([
      { id: "a", direction: "none" },
      { id: "b", direction: "none" },
    ]);
  });
});
