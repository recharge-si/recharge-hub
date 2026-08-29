import { describe, expect, it } from "vitest";

import {
  ORDER_REFERENCE_REGISTRY,
  orderReferenceRows,
} from "~/web/lib/order-reference-fields";

/**
 * What the reference pattern's field picker offers.
 *
 * The rows carry real values from a real order, which is the only reason to
 * show them (docs/ui-conventions.md: sample data is the merchant's own). A
 * field the sample cannot answer shows nothing at all rather than an empty
 * string, which would read as "this order has none".
 */

const SAMPLE = {
  name: "#1050",
  number: "1050",
  id: "5551234567890",
  customerEmail: null,
};

describe("orderReferenceRows", () => {
  it("offers every field, resolved against the merchant's own order", () => {
    const [group] = orderReferenceRows("", SAMPLE);

    expect(group?.rows).toHaveLength(ORDER_REFERENCE_REGISTRY.length);
    expect(
      group?.rows.find((row) => row.field.id === "order.number")?.value,
    ).toBe("1050");
    expect(group?.rows.find((row) => row.field.id === "order.name")?.value).toBe(
      "#1050",
    );
  });

  it("shows no value for a field this app keeps nothing for", () => {
    const [group] = orderReferenceRows("", SAMPLE);

    expect(
      group?.rows.find((row) => row.field.id === "customer.email")?.value,
    ).toBeNull();
  });

  it("shows no values at all for a shop that has taken no orders", () => {
    const [group] = orderReferenceRows("", null);

    expect(group?.rows.every((row) => row.value === null)).toBe(true);
  });

  it("narrows to what is being typed, and answers nothing for a word that matches none", () => {
    expect(
      orderReferenceRows("num", SAMPLE)[0]?.rows.map((row) => row.field.id),
    ).toEqual(["order.number"]);

    expect(orderReferenceRows("zzz", SAMPLE)).toEqual([]);
  });
});
