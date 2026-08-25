import { describe, expect, it } from "vitest";

import { taxFactorFromPercent } from "~/adapters/metakocka/products";

import {
  buildTemplate,
  parseTemplate,
  DEFAULT_NAME_TEMPLATE,
  EXAMPLE_VARIANT,
  renderName,
  type VariantFacts,
} from "~/domain/products/name-template";

/**
 * The name template decides what a merchant's ERP products are called, and a
 * bad name is only noticed after it has been written. These are the cases that
 * matter: a product with options, one without, and templates that would leave
 * dangling separators.
 */

const withOptions: VariantFacts = EXAMPLE_VARIANT;

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

describe("renderName", () => {
  it("puts the option values after the title by default", () => {
    expect(renderName(DEFAULT_NAME_TEMPLATE, withOptions)).toBe(
      "T-Shirt L Blue",
    );
  });

  it("leaves a single-variant product as its title alone", () => {
    expect(renderName(DEFAULT_NAME_TEMPLATE, single)).toBe("Gift card");
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

describe("buildTemplate and parseTemplate", () => {
  it("builds a template that drops the separator with the empty piece", () => {
    const template = buildTemplate({
      pieces: ["{title}", "{options}"],
      separator: " - ",
    });

    expect(template).toBe("{title}[ - {options}]");
    expect(renderName(template, withOptions)).toBe("T-Shirt - L Blue");
    expect(renderName(template, single)).toBe("Gift card");
  });

  it("reads its own output back", () => {
    const pieces = {
      pieces: ["{vendor}", "{title}", "{sku}"],
      separator: " / ",
    };
    expect(parseTemplate(buildTemplate(pieces))).toEqual(pieces);
  });

  it("reads the shipped default", () => {
    expect(parseTemplate(DEFAULT_NAME_TEMPLATE)).toEqual({
      pieces: ["{title}", "{options}"],
      separator: " ",
    });
  });

  it("keeps a merchant's own words as a piece", () => {
    const template = buildTemplate({
      pieces: ["{title}", "sale"],
      separator: " ",
    });
    expect(renderName(template, single)).toBe("Gift card sale");
  });

  it("refuses a template it cannot represent, rather than rewriting it", () => {
    expect(parseTemplate("{title} - {options}")).toBeNull();
    expect(parseTemplate("{title}[ {a}][-{b}]")).toBeNull();
  });
});
