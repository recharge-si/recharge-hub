import { describe, expect, it } from "vitest";

import {
  DEFAULT_CUSTOMER_ORDER_TEMPLATE,
  MAX_ORDER_REFERENCE_LENGTH,
  ORDER_REFERENCE_PLACEHOLDERS,
  orderReferenceFor,
  renderOrderReference,
  unknownPlaceholders,
} from "~/domain/orders/reference";

/**
 * The merchant-configurable *Customer's order* value (brief §10).
 *
 * Two things are being protected here and only one of them is cosmetic.
 *
 * The cosmetic one is that the merchant gets the string they asked for. The
 * other is that the string is never empty and never unbounded: it is sent as
 * `buyer_order`, which is the only reference `get_document` can search by and
 * the only thing linking the sibling documents of a split order (§3). An order
 * carrying none loses both, silently, and only shows up when a write times out
 * and the recovery has nothing to look for.
 */

const CONTEXT = {
  name: "#1050",
  number: "1050",
  id: "5551234567890",
  customerEmail: "buyer@example.test",
};

describe("the customer's order reference", () => {
  it("fills in every documented field", () => {
    expect(renderOrderReference("{{order.name}}", CONTEXT)).toBe("#1050");
    expect(renderOrderReference("{{order.number}}", CONTEXT)).toBe("1050");
    expect(renderOrderReference("{{order.id}}", CONTEXT)).toBe("5551234567890");
    expect(renderOrderReference("{{customer.email}}", CONTEXT)).toBe(
      "buyer@example.test",
    );
  });

  it("has a rendering for every placeholder it advertises", () => {
    // The settings screen lists these; a listed field that renders nothing is
    // a merchant choosing something that silently does not work.
    for (const placeholder of ORDER_REFERENCE_PLACEHOLDERS) {
      expect(
        renderOrderReference(`{{${placeholder.token}}}`, CONTEXT).length,
      ).toBeGreaterThan(0);
    }
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderOrderReference("{{ order.number }}", CONTEXT)).toBe("1050");
  });

  it("combines fields with literal text", () => {
    expect(renderOrderReference("WEB-{{order.number}}/A", CONTEXT)).toBe(
      "WEB-1050/A",
    );
  });

  it("produces the historical reference by default", () => {
    // Every order written before this setting existed carries `SH-<number>`.
    // Changing the default would orphan them.
    expect(
      renderOrderReference(DEFAULT_CUSTOMER_ORDER_TEMPLATE, CONTEXT),
    ).toBe("SH-1050");
  });

  it("leaves an unknown field alone rather than blanking it", () => {
    // Visible on the settings preview as a mistake, instead of producing an
    // unexplained reference in the ERP.
    expect(renderOrderReference("{{order.tags}}", CONTEXT)).toBe(
      "{{order.tags}}",
    );
    expect(unknownPlaceholders("{{order.tags}}-{{order.number}}")).toEqual([
      "order.tags",
    ]);
    expect(unknownPlaceholders("{{order.number}}")).toEqual([]);
  });

  it("bounds the length, because a truncated reference stops linking", () => {
    const long = renderOrderReference("X".repeat(200), CONTEXT);
    expect(long.length).toBe(MAX_ORDER_REFERENCE_LENGTH);
  });
});

describe("falling back when a pattern produces nothing", () => {
  it("uses the default for a guest checkout under an email pattern", () => {
    /*
     * The failure this exists for. `{{customer.email}}` is a perfectly
     * reasonable choice and meets its first order without one eventually — a
     * point-of-sale sale, a guest checkout — and an order with no reference at
     * all cannot be recovered after an ambiguous write.
     */
    const result = orderReferenceFor("{{customer.email}}", {
      ...CONTEXT,
      customerEmail: null,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.reference).toBe("SH-1050");
  });

  it("does not fall back when the pattern produces something", () => {
    const result = orderReferenceFor("{{customer.email}}", CONTEXT);
    expect(result.usedFallback).toBe(false);
    expect(result.reference).toBe("buyer@example.test");
  });

  it("treats an empty or whitespace pattern as the default", () => {
    expect(orderReferenceFor("   ", CONTEXT).reference).toBe("SH-1050");
    expect(orderReferenceFor(null, CONTEXT).reference).toBe("SH-1050");
  });

  it("is stable: the same order and pattern always give the same reference", () => {
    // The reference is stored once at intake and the ambiguous-write recovery
    // searches MetaKocka by it. An unstable rendering would orphan documents.
    const first = orderReferenceFor("WEB-{{order.number}}", CONTEXT);
    const second = orderReferenceFor("WEB-{{order.number}}", CONTEXT);
    expect(first).toEqual(second);
  });
});
