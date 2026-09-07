import { describe, expect, it } from "vitest";

import { ExceptionKind } from "@prisma/client";

import { describeExceptionKind, exceptionAction } from "~/web/lib/exceptions";

/**
 * docs/BUILD_SPEC.md section 11 asks every exception to be solvable from inside
 * the app, and section 2.8 asks an error to say what is wrong *and* how to fix
 * it.
 *
 * Two things can quietly stop being true as kinds are added: a new kind falls
 * through to the generic "Needs attention" copy, and an action points at a
 * route that has since moved. Both are asserted here rather than noticed by a
 * merchant.
 */
describe("exception copy", () => {
  it("has real copy for every kind the database can store", () => {
    const generic = describeExceptionKind("__no_such_kind__");

    for (const kind of Object.values(ExceptionKind)) {
      const copy = describeExceptionKind(kind);
      expect(copy.label, kind).not.toBe(generic.label);
      expect(copy.guidance.length, kind).toBeGreaterThan(20);
    }
  });
});

describe("exceptionAction", () => {
  it("points every action at a page inside the app", () => {
    for (const kind of Object.values(ExceptionKind)) {
      const action = exceptionAction(kind);
      if (!action) continue;
      expect(action.href, kind).toMatch(/^\/app\//);
      expect(action.href, kind).not.toContain("/app/settings/sales-orders");
      expect(action.href, kind).not.toContain("/app/settings/supply-sources");
      expect(action.href, kind).not.toContain("/app/settings/payments");
    }
  });

  it("sends an unmapped payment method to the payment mapping", () => {
    expect(exceptionAction("unmapped_payment_gateway")?.href).toBe(
      "/app/orders/settings/payments",
    );
  });

  it("sends an unmapped location to Locations", () => {
    expect(exceptionAction("unmapped_location")?.href).toBe("/app/locations");
  });

  it("sends missing shipping or discount representation to the order settings", () => {
    expect(exceptionAction("commercial_representation_missing")?.href).toBe(
      "/app/orders/settings",
    );
  });

  it("has no page of its own for a condition only the order can answer", () => {
    // These are resolved on the order itself, so the caller falls back to it
    // rather than sending the merchant to a settings page that cannot help.
    expect(exceptionAction("order_diverged")).toBeNull();
    expect(exceptionAction("refund_received")).toBeNull();
  });
});
