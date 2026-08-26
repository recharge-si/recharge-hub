import { describe, expect, it } from "vitest";

import { taxFactorFromPercent } from "~/adapters/metakocka/products";

import {
  DEFAULT_NAME_PATTERN,
  renderName,
  type VariantFacts,
} from "~/domain/products/template";

/**
 * The name pattern decides what a merchant's ERP products are called, and a bad
 * name is only noticed after it has been written. These are the cases that
 * matter: a product with options, one without, and patterns that would leave
 * dangling separators.
 *
 * These two are test fixtures, not sample data shown to anyone. The screens
 * preview against the merchant's own catalogue and never fall back to an
 * invented product.
 */

const withOptions: VariantFacts = {
  productTitle: "T-Shirt",
  variantTitle: "L / Blue",
  optionValues: ["L", "Blue"],
  optionNames: ["Size", "Colour"],
  sku: "TS-001-L",
  barcode: "3830000000001",
  vendor: "Acme",
  productType: "Shirts",
  handle: "t-shirt",
  price: "19.90",
};

const single: VariantFacts = {
  productTitle: "Gift card",
  variantTitle: "Default Title",
  optionValues: [],
  optionNames: [],
  sku: "GC-01",
  barcode: null,
  vendor: "Acme",
  productType: null,
  handle: "gift-card",
  price: "25.00",
};

describe("rendering a name", () => {
  it("puts the option values after the title by default", () => {
    expect(renderName(DEFAULT_NAME_PATTERN, withOptions)).toBe(
      "T-Shirt L Blue",
    );
  });

  it("leaves a single-variant product as its title alone", () => {
    expect(renderName(DEFAULT_NAME_PATTERN, single)).toBe("Gift card");
  });

  it("drops a bracketed group when every token in it is empty", () => {
    expect(renderName("{title}[ - {options}]", single)).toBe("Gift card");
    expect(renderName("{title}[ - {options}]", withOptions)).toBe(
      "T-Shirt - L Blue",
    );
  });

  it("keeps a bracketed group when at least one token has a value", () => {
    expect(renderName("{title}[ ({option1}/{option2})]", withOptions)).toBe(
      "T-Shirt (L/Blue)",
    );
  });

  it("keeps literal text inside brackets that has no token", () => {
    expect(renderName("{title}[ (sale)]", single)).toBe("Gift card (sale)");
  });

  it("supports every documented token", () => {
    expect(
      renderName(
        "{vendor} {title} {option1name} {option1} {option2} {variant} {sku} {barcode} {type} {handle} {price}",
        withOptions,
      ),
    ).toBe(
      "Acme T-Shirt Size L Blue L / Blue TS-001-L 3830000000001 Shirts t-shirt 19.90",
    );
  });

  it("trims separators left behind by empty tokens", () => {
    expect(renderName("{title} - {options}", single)).toBe("Gift card");
    expect(renderName("{vendor} | {type}", single)).toBe("Acme");
  });

  it("never renders an empty name", () => {
    expect(renderName("{options}", single)).toBe("Gift card");
    expect(renderName("{options}", { ...single, productTitle: "   " })).toBe(
      "GC-01",
    );
  });

  it("shows an unknown token rather than dropping it silently", () => {
    expect(renderName("{title} {colour}", single)).toBe("Gift card {colour}");
  });

  it("truncates to the maximum length", () => {
    const long = { ...single, productTitle: "x".repeat(300) };
    expect(renderName("{title}", long)).toHaveLength(250);
  });
});

describe("taxFactorFromPercent", () => {
  it("turns a percentage into the factor MetaKocka wants", () => {
    expect(taxFactorFromPercent("22")).toBe("0.22");
    expect(taxFactorFromPercent("9,5")).toBe("0.095");
    expect(taxFactorFromPercent(" 20 % ")).toBe("0.2");
    expect(taxFactorFromPercent("0")).toBe("0.0");
  });

  it("refuses anything that is not a percentage, so no wrong rate is sent", () => {
    expect(taxFactorFromPercent(null)).toBeNull();
    expect(taxFactorFromPercent("")).toBeNull();
    expect(taxFactorFromPercent("twenty")).toBeNull();
    expect(taxFactorFromPercent("-5")).toBeNull();
    expect(taxFactorFromPercent("120")).toBeNull();
  });
});
