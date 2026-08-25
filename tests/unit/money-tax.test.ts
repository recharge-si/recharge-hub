import { describe, expect, it } from "vitest";

import {
  grossToNetMinor,
  netToGrossMinor,
  taxFactorToNumber,
  toPriceBasis,
} from "~/domain/money/tax";

/**
 * The case that produced this module, verified against MetaKocka: pricelist "1"
 * on company 6789 is a net pricelist, and a Shopify price of 209.00 including
 * 22% tax has to reach it as 171.31. Writing 209.00 into a net pricelist is not
 * a format error — it is a price 22% too high, accepted without complaint.
 */
describe("the observed case", () => {
  it("209.00 gross at 22% is 171.31 net", () => {
    expect(grossToNetMinor(20900, 0.22)).toBe(17131);
  });

  it("and converts back within a cent", () => {
    expect(netToGrossMinor(17131, 0.22)).toBe(20900);
  });
});

describe("taxFactorToNumber", () => {
  it("reads the decimal string MetaKocka uses", () => {
    expect(taxFactorToNumber("0.22")).toBe(0.22);
  });

  it("accepts a decimal comma, which MetaKocka also emits", () => {
    expect(taxFactorToNumber("0,22")).toBe(0.22);
  });

  it("treats absent, zero and nonsense as no tax", () => {
    for (const value of [null, undefined, "", "0", "abc", "-1"]) {
      expect(taxFactorToNumber(value)).toBe(0);
    }
  });
});

describe("converting between bases", () => {
  it("leaves the number alone when both sides agree", () => {
    const result = toPriceBasis({
      amountMinor: 20900,
      sourceIncludesTax: true,
      targetIncludesTax: true,
      taxFactor: "0.22",
    });

    expect(result).toEqual({
      amountMinor: 20900,
      converted: false,
      impossible: false,
    });
  });

  it("strips the tax for a net pricelist", () => {
    const result = toPriceBasis({
      amountMinor: 20900,
      sourceIncludesTax: true,
      targetIncludesTax: false,
      taxFactor: "0.22",
    });

    expect(result.amountMinor).toBe(17131);
    expect(result.converted).toBe(true);
  });

  it("adds the tax for a gross pricelist", () => {
    const result = toPriceBasis({
      amountMinor: 17131,
      sourceIncludesTax: false,
      targetIncludesTax: true,
      taxFactor: "0.22",
    });

    expect(result.amountMinor).toBe(20900);
    expect(result.converted).toBe(true);
  });

  it("refuses to convert with no rate rather than sending the wrong price", () => {
    const result = toPriceBasis({
      amountMinor: 20900,
      sourceIncludesTax: true,
      targetIncludesTax: false,
      taxFactor: null,
    });

    // There is no safe fallback: the unconverted figure is simply wrong.
    expect(result.impossible).toBe(true);
    expect(result.converted).toBe(false);
  });

  it("does not call it impossible when no conversion is needed", () => {
    const result = toPriceBasis({
      amountMinor: 20900,
      sourceIncludesTax: false,
      targetIncludesTax: false,
      taxFactor: null,
    });

    expect(result.impossible).toBe(false);
    expect(result.amountMinor).toBe(20900);
  });
});

describe("rounding", () => {
  it("stays in integer minor units", () => {
    const amounts = [1, 99, 100, 999, 1234, 20900, 999999];
    for (const amount of amounts) {
      for (const factor of [0.05, 0.095, 0.22, 0.25]) {
        expect(Number.isInteger(grossToNetMinor(amount, factor))).toBe(true);
        expect(Number.isInteger(netToGrossMinor(amount, factor))).toBe(true);
      }
    }
  });

  it("round-trips within one minor unit", () => {
    for (let gross = 1; gross <= 5000; gross += 7) {
      const back = netToGrossMinor(grossToNetMinor(gross, 0.22), 0.22);
      expect(Math.abs(back - gross)).toBeLessThanOrEqual(1);
    }
  });

  it("passes a zero rate straight through", () => {
    expect(grossToNetMinor(20900, 0)).toBe(20900);
    expect(netToGrossMinor(20900, 0)).toBe(20900);
  });
});
