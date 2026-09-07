import { describe, expect, it } from "vitest";

import {
  suggestPaymentMapping,
  suggestPaymentType,
} from "~/domain/payments/gateway-match";

/**
 * Guided setup proposes a payment type per Shopify method; the merchant saves
 * it. docs/BUILD_SPEC.md section 8.7 says a payment type is never guessed, so
 * what matters most here is what this refuses to answer: an ambiguous register
 * has to come back null rather than pick one, because the wrong answer is a
 * wrong entry in somebody's books.
 */

const REGISTER = ["Kartica", "Po povzetju", "TRR", "PayPal", "Darilni bon"];

describe("suggestPaymentType", () => {
  it("matches a card gateway to the card entry", () => {
    expect(suggestPaymentType("shopify_payments", REGISTER)).toBe("Kartica");
    expect(suggestPaymentType("bogus", REGISTER)).toBe("Kartica");
    expect(suggestPaymentType("stripe", REGISTER)).toBe("Kartica");
  });

  it("matches cash on delivery", () => {
    expect(suggestPaymentType("cash_on_delivery", REGISTER)).toBe(
      "Po povzetju",
    );
  });

  it("matches manual and bank methods to the transfer entry", () => {
    expect(suggestPaymentType("manual", REGISTER)).toBe("TRR");
    expect(suggestPaymentType("bank_deposit", REGISTER)).toBe("TRR");
  });

  it("matches a register entry named after the gateway itself", () => {
    expect(suggestPaymentType("paypal", REGISTER)).toBe("PayPal");
    expect(suggestPaymentType("Predracun", ["Predracun", "TRR"])).toBe(
      "Predracun",
    );
  });

  it("matches an entry that only contains the word", () => {
    expect(suggestPaymentType("shopify_payments", ["Placilo s kartico"])).toBe(
      "Placilo s kartico",
    );
  });

  it("does not read a gift card as a card", () => {
    expect(suggestPaymentType("gift_card", REGISTER)).toBe("Darilni bon");
  });

  it("refuses to choose between two equally good entries", () => {
    expect(
      suggestPaymentType("shopify_payments", ["Kartica", "Kreditna"]),
    ).toBeNull();
    expect(
      suggestPaymentType("manual", ["Bank transfer", "Nakazilo"]),
    ).toBeNull();
  });

  it("answers null for a gateway it knows nothing about", () => {
    expect(suggestPaymentType("some_local_wallet", REGISTER)).toBeNull();
  });

  it("answers null when the register is empty", () => {
    expect(suggestPaymentType("shopify_payments", [])).toBeNull();
  });
});

describe("suggestPaymentMapping", () => {
  it("never overwrites a mapping the merchant already chose", () => {
    const suggestions = suggestPaymentMapping(
      ["shopify_payments", "cash_on_delivery"],
      REGISTER,
      { shopify_payments: "TRR" },
    );

    expect(suggestions).toEqual({ cash_on_delivery: "Po povzetju" });
  });

  it("leaves out anything it cannot answer for", () => {
    const suggestions = suggestPaymentMapping(
      ["some_local_wallet", "paypal"],
      REGISTER,
      {},
    );

    expect(suggestions).toEqual({ paypal: "PayPal" });
  });
});
