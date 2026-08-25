import { describe, expect, it } from "vitest";

import { formatTaxRate } from "~/web/lib/orders";
import { metakockaDocumentUrl } from "~/adapters/metakocka/documents";

/**
 * Two small translations between what this app sends and what a merchant
 * reads. Both are pure, and both are wrong in a way that would be noticed only
 * by someone checking a VAT return.
 */

describe("formatTaxRate", () => {
  it("shows the rate, not the factor", () => {
    // "0.22" is what goes to MetaKocka (§3: tax_factor is a decimal). 22% is
    // what appears on the invoice.
    expect(formatTaxRate("0.22")).toBe("22%");
    expect(formatTaxRate("0.095")).toBe("9.5%");
  });

  it("does not invent precision", () => {
    expect(formatTaxRate("0.22")).not.toBe("22.0%");
    expect(formatTaxRate("0")).toBe("0%");
  });

  it("tells a zero rate apart from an unknown one", () => {
    /*
     * The difference between a line that is genuinely exempt and one Shopify
     * said nothing about — which §11 turns into an exception rather than a
     * guess. Showing both as "0%" would hide the second.
     */
    expect(formatTaxRate("0")).toBe("0%");
    expect(formatTaxRate(null)).toBe("—");
  });

  it("does not print nonsense for a value it cannot read", () => {
    expect(formatTaxRate("[redacted]")).toBe("—");
  });
});

describe("metakockaDocumentUrl", () => {
  it("points at the sales order in MetaKocka", () => {
    expect(metakockaDocumentUrl("1200049924471")).toBe(
      "https://main.metakocka.si/index.jsp#prodaja_salesorder?id=1200049924471",
    );
  });
});
