import { describe, expect, it } from "vitest";

import {
  factorToPpm,
  percentToPpm,
  ppmToFactor,
  ppmToRateKey,
  rateKeyFromFactor,
  rateKeyFromPercent,
  rateKeyToFactor,
  sameRate,
  sumRateKeys,
  taxInGrossMinor,
  taxOnNetMinor,
} from "~/domain/tax/rates";

describe("rate keys", () => {
  it("canonicalises percentages however they are typed", () => {
    expect(rateKeyFromPercent("22")).toBe("22");
    expect(rateKeyFromPercent("22.0")).toBe("22");
    expect(rateKeyFromPercent("9,5")).toBe("9.5");
    expect(rateKeyFromPercent("9.50")).toBe("9.5");
    expect(rateKeyFromPercent(" 0 ")).toBe("0");
    expect(rateKeyFromPercent(25.5)).toBe("25.5");
  });

  it("reads Shopify's decimal rates and MetaKocka's factors", () => {
    expect(rateKeyFromFactor("0.22")).toBe("22");
    expect(rateKeyFromFactor(0.095)).toBe("9.5");
    expect(rateKeyFromFactor("0.0925")).toBe("9.25");
    expect(rateKeyFromFactor("0")).toBe("0");
  });

  it("refuses nonsense and out-of-range values", () => {
    expect(rateKeyFromPercent("abc")).toBeNull();
    expect(rateKeyFromPercent("101")).toBeNull();
    expect(rateKeyFromPercent("-1")).toBeNull();
    expect(rateKeyFromFactor("1.5")).toBeNull();
    expect(rateKeyFromFactor("")).toBeNull();
  });

  it("round-trips to the tax_factor MetaKocka takes", () => {
    expect(rateKeyToFactor("22")).toBe("0.22");
    expect(rateKeyToFactor("9.5")).toBe("0.095");
    expect(rateKeyToFactor("0")).toBe("0");
    expect(rateKeyToFactor("25.5")).toBe("0.255");
    expect(ppmToFactor(220_000)).toBe("0.22");
    expect(ppmToRateKey(95_000)).toBe("9.5");
    expect(percentToPpm("22")).toBe(220_000);
    expect(factorToPpm("0.22")).toBe(220_000);
  });

  it("compares rates by value, never by string", () => {
    expect(sameRate("22", "22.0")).toBe(true);
    expect(sameRate("9.5", "9.50")).toBe(true);
    expect(sameRate("22", "20")).toBe(false);
    expect(sameRate(null, "22")).toBe(false);
  });

  it("sums stacked tax lines exactly", () => {
    expect(sumRateKeys(["6", "2.5"])).toBe("8.5");
    expect(sumRateKeys(["0.1", "0.2"])).toBe("0.3");
    expect(sumRateKeys([])).toBe("0");
  });
});

describe("tax arithmetic in minor units", () => {
  it("takes the VAT out of a gross amount the way MetaKocka does", () => {
    // 209.00 at 22% is 171.31 net and 37.69 VAT (docs/metakocka-verification.md).
    expect(taxInGrossMinor(20900, 220_000)).toBe(3769);
  });

  it("puts the VAT onto a net amount", () => {
    expect(taxOnNetMinor(17131, 220_000)).toBe(3769);
    expect(taxOnNetMinor(10000, 200_000)).toBe(2000);
  });

  it("rounds half up and mirrors the sign, so a refund is the exact negation", () => {
    for (const gross of [1, 5, 99, 101, 12345, 99999]) {
      // `+ 0` folds a `-0` so a zero tax compares as the zero it is.
      expect(taxInGrossMinor(-gross, 95_000)).toBe(
        -taxInGrossMinor(gross, 95_000) + 0,
      );
      expect(taxOnNetMinor(-gross, 95_000)).toBe(
        -taxOnNetMinor(gross, 95_000) + 0,
      );
    }
    // 0.5 cent ties go up: 1.00 net at 0.5% is 0.005 → 0.01.
    expect(taxOnNetMinor(100, 5_000)).toBe(1);
  });

  it("is exact for amounts far beyond a double's clean integer range of cents", () => {
    // 9 007 199 254 740 993 cents would already be past 2^53 as a float.
    expect(taxOnNetMinor(1_000_000_000_00, 220_000)).toBe(22_000_000_000);
  });

  it("is zero at 0%", () => {
    expect(taxInGrossMinor(20900, 0)).toBe(0);
    expect(taxOnNetMinor(20900, 0)).toBe(0);
  });
});
