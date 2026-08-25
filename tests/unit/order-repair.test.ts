import { describe, expect, it } from "vitest";

import { TARGET_FOR_KIND } from "~/adapters/queue/redrive.server";
import {
  overrideIsComplete,
  parsePartnerOverride,
  partnerOverrideSchema,
} from "~/domain/orders/partner";

/**
 * The two things a merchant could not do inside the app, and the reason the
 * retry button appeared to be broken.
 *
 * All three complaints were the same shape: the app knew what was wrong, said
 * so accurately, and offered no way to act on it. "Add the address in Shopify"
 * for an order Shopify cannot hold an address for; "choose a source by hand"
 * with nowhere to choose; "Retry" that re-ran the one step which had never
 * failed.
 */

describe("partner override", () => {
  it("keeps the details MetaKocka needs and normalises the rest", () => {
    const parsed = partnerOverrideSchema.parse({
      customer: "  Patrik Sports d.o.o.  ",
      street: "Cesta 1",
      isBusiness: true,
    });

    expect(parsed.customer).toBe("Patrik Sports d.o.o.");
    expect(parsed.street).toBe("Cesta 1");
    expect(parsed.isBusiness).toBe(true);
    // Absent is null, not undefined: it goes into a jsonb column and comes back
    // through the same schema.
    expect(parsed.place).toBeNull();
    expect(parsed.taxNumber).toBeNull();
  });

  it("refuses a partner with no name", () => {
    // The one field MetaKocka will not do without. Accepting it here would move
    // the rejection to the ERP, a day later, with a worse message.
    expect(partnerOverrideSchema.safeParse({ customer: "   " }).success).toBe(
      false,
    );
  });

  it("reads a stored override back", () => {
    const stored = {
      customer: "Grega Rotar",
      street: "Cesta 1",
      postNumber: "1000",
      place: "Ljubljana",
      country: "Slovenia",
      isBusiness: false,
      taxNumber: null,
      email: null,
      phone: null,
    };

    expect(parsePartnerOverride(stored)?.customer).toBe("Grega Rotar");
  });

  it("never throws on a column it cannot read", () => {
    /*
     * A shape from an older version, or one the retention job has been through.
     * Falling back to the payload is the same behaviour as having no override,
     * which is where this started — taking the order writer down instead would
     * be strictly worse.
     */
    expect(parsePartnerOverride(null)).toBeNull();
    expect(parsePartnerOverride({ nonsense: true })).toBeNull();
    expect(parsePartnerOverride("[redacted]")).toBeNull();
  });

  it("knows a name alone will not identify a new partner", () => {
    // §3: `mk_id` alone is refused with "Partner must have mk_address_id or
    // customer and street for address identification."
    const named = partnerOverrideSchema.parse({ customer: "Someone" });
    expect(overrideIsComplete(named)).toBe(false);

    const addressed = partnerOverrideSchema.parse({
      customer: "Someone",
      street: "Cesta 1",
    });
    expect(overrideIsComplete(addressed)).toBe(true);
  });
});

describe("which job answers which problem", () => {
  it("has an answer for every kind of exception", () => {
    // A Record<ExceptionKind, …> makes this exhaustive at compile time; this
    // asserts the values are real rather than that the keys exist.
    const targets = new Set(Object.values(TARGET_FOR_KIND));
    for (const target of targets) {
      expect([
        "auto",
        "none",
        "allocate",
        "write",
        "payment",
        "refresh",
      ]).toContain(target);
    }
  });

  it("does not answer a rejected sales order by allocating again", () => {
    /*
     * The bug behind "retry not working". Allocation was never the failing
     * step for any of these, so re-running it succeeded instantly, the write
     * failed again the same way, and the button looked dead.
     */
    for (const kind of [
      "metakocka_write_failed",
      "profit_center_rejected",
      "warehouse_invalid",
      "tax_undeterminable",
      "sku_not_in_metakocka",
    ] as const) {
      expect(TARGET_FOR_KIND[kind]).toBe("write");
    }
  });

  it("answers a stock problem by allocating again", () => {
    expect(TARGET_FOR_KIND.insufficient_stock).toBe("allocate");
  });

  it("answers a payment problem by recording the payment", () => {
    expect(TARGET_FOR_KIND.payment_write_failed).toBe("payment");
  });

  it("admits when there is nothing to retry", () => {
    /*
     * A document somebody edited inside MetaKocka. This app cannot undo that,
     * it may already be invoiced, and sending another would make two — so the
     * honest answer is to say so rather than to run a job that changes nothing
     * and report it as a retry.
     */
    expect(TARGET_FOR_KIND.metakocka_document_changed).toBe("none");
  });

  it("offers to write a document that was deleted in MetaKocka", () => {
    expect(TARGET_FOR_KIND.metakocka_document_missing).toBe("write");
  });

  it("answers a question about Shopify by asking Shopify", () => {
    // Nothing is sent for these: what a refunded or cancelled order needs is
    // for someone to find out what it is now, not another document.
    for (const kind of [
      "refund_received",
      "order_cancelled",
      "order_diverged",
      "partially_paid",
      "voided_payment",
    ] as const) {
      expect(TARGET_FOR_KIND[kind]).toBe("refresh");
    }
  });
});
