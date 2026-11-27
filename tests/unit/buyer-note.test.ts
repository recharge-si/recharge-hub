import { describe, expect, it } from "vitest";

import { buyerNote } from "~/domain/orders/partner";

/**
 * When every order is filed against one fixed MetaKocka partner, the Shopify
 * buyer goes into the document's additional text (`notes`).
 */
describe("buyerNote", () => {
  it("writes the buyer on one line and the email under it", () => {
    expect(
      buyerNote({
        customer: "Tim Parey",
        street: "20 Chemin Du Roy D’Espagne, A1",
        postNumber: "13009",
        place: "Marseille",
        country: "France",
        phone: "+33 6 16 99 17 16",
        email: "timparey@orange.fr",
      }),
    ).toBe(
      "Tim Parey, 20 Chemin Du Roy D’Espagne, A1, 13009 Marseille, France, +33 6 16 99 17 16\ntimparey@orange.fr",
    );
  });

  it("leaves out what Shopify does not have", () => {
    expect(
      buyerNote({
        customer: "Tim Parey",
        street: null,
        postNumber: null,
        place: "Marseille",
        country: "France",
        phone: null,
        email: null,
      }),
    ).toBe("Tim Parey, Marseille, France");
  });
});
