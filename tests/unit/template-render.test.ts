import { describe, expect, it } from "vitest";

import {
  parseTemplate,
  renderName,
  tidy,
  type VariantFacts,
} from "~/domain/products/template";

/**
 * Empty-value collapsing is the behaviour this engine exists for, so it is
 * written as a case table rather than as prose. Every row is a name a merchant
 * would actually want; the failure mode each one guards against is a product
 * called "Mast -" or "Mast  cm" sitting in the ERP forever.
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

/** A product with no options at all — the case that produces dangling separators. */
const bare: VariantFacts = {
  productTitle: "Mast",
  variantTitle: "Default Title",
  optionValues: [],
  optionNames: [],
  sku: "M-490",
  barcode: null,
  vendor: "Acme",
  productType: null,
  handle: "mast",
  price: "540.00",
};

describe("empty-value collapsing", () => {
  const cases: {
    name: string;
    template: string;
    facts: VariantFacts;
    expected: string;
  }[] = [
    // A token that resolves takes its separator with it, and one that does not
    // takes the separator away too.
    {
      name: "suffix separator survives a present value",
      template: '{title}{option1|prefix:" - "}',
      facts: withOptions,
      expected: "T-Shirt - L",
    },
    {
      name: "prefix separator leaves with an empty value",
      template: '{title}{option1|prefix:" - "}',
      facts: bare,
      expected: "Mast",
    },
    {
      name: "suffix leaves with an empty value",
      template: '{option1|suffix:" - "}{title}',
      facts: bare,
      expected: "Mast",
    },
    {
      name: "unit suffix attaches to the value, not the name",
      template: '{title}{option1|suffix:" cm"}',
      facts: bare,
      expected: "Mast",
    },

    // Groups drop the separator that two tokens share.
    {
      name: "group keeps its contents when a token resolves",
      template: "{title}[ - {options}]",
      facts: withOptions,
      expected: "T-Shirt - L Blue",
    },
    {
      name: "group vanishes whole when every token is empty",
      template: "{title}[ - {options}]",
      facts: bare,
      expected: "Mast",
    },
    {
      name: "group with brackets and a slash vanishes whole",
      template: "{title}[ ({option1}/{option2})]",
      facts: bare,
      expected: "Mast",
    },
    {
      name: "group with brackets and a slash survives with values",
      template: "{title}[ ({option1}/{option2})]",
      facts: withOptions,
      expected: "T-Shirt (L/Blue)",
    },
    {
      name: "group with no token in it is literal text",
      template: "{title}[ (sale)]",
      facts: bare,
      expected: "Mast (sale)",
    },
    {
      name: "a group survives if any one token resolves",
      template: "{title}[ - {option1}{option2}]",
      facts: { ...bare, optionValues: ["490"] },
      expected: "Mast - 490",
    },

    // The last-resort cleanup, for templates with neither filters nor groups.
    {
      name: "trailing separator is dropped",
      template: "{title} - {options}",
      facts: bare,
      expected: "Mast",
    },
    {
      name: "leading separator is dropped",
      template: "{options} - {title}",
      facts: bare,
      expected: "Mast",
    },
    {
      name: "separators either side collapse to nothing",
      template: "{vendor} | {options} | {type}",
      facts: bare,
      expected: "Acme",
    },
    {
      name: "two separators that become neighbours collapse to one",
      template: "{title} - {options} - {sku}",
      facts: bare,
      expected: "Mast - M-490",
    },
    {
      name: "whitespace runs collapse",
      template: "{title}  {options}   {sku}",
      facts: bare,
      expected: "Mast M-490",
    },
    {
      name: "mixed separator run keeps the first",
      template: "{title} / {options}, {sku}",
      facts: bare,
      expected: "Mast / M-490",
    },

    // Fallbacks.
    {
      name: "a template that renders to nothing falls back to the title",
      template: "{options}",
      facts: bare,
      expected: "Mast",
    },
    {
      name: "with no title either it falls back to the SKU",
      template: "{options}",
      facts: { ...bare, productTitle: "   " },
      expected: "M-490",
    },
    {
      name: "an unknown field stays visible rather than vanishing",
      template: "{title} {colour}",
      facts: bare,
      expected: "Mast {colour}",
    },
  ];

  for (const { name, template, facts, expected } of cases) {
    it(name, () => {
      expect(renderName(template, facts)).toBe(expected);
    });
  }
});

/** The manual check from the brief, pinned so it cannot regress. */
it("title plus an empty-collapsing option gives the bare title", () => {
  const rendered = renderName('{title}{option1|prefix:" - "}', bare);
  expect(rendered).toBe("Mast");
  expect(rendered).not.toMatch(/[\s-]$/);
});

describe("filters", () => {
  it("upper, lower and trim", () => {
    expect(renderName("{title|upper}", bare)).toBe("MAST");
    expect(renderName("{title|lower}", bare)).toBe("mast");
    expect(
      renderName("{title|trim}", { ...bare, productTitle: "  Mast  " }),
    ).toBe("Mast");
  });

  it("truncate keeps the first characters", () => {
    expect(renderName("{title|truncate:2}", bare)).toBe("Ma");
  });

  it("first and last keep words", () => {
    const facts = { ...bare, productTitle: "Carbon racing mast" };
    expect(renderName("{title|first:2}", facts)).toBe("Carbon racing");
    expect(renderName("{title|last:1}", facts)).toBe("mast");
  });

  it("replace swaps text", () => {
    expect(renderName('{title|replace:"Mast":"Boom"}', bare)).toBe("Boom");
  });

  it("default fills an empty value, and then a prefix applies", () => {
    expect(renderName('{options|default:"one size"}', bare)).toBe("one size");
    expect(
      renderName('{title}{options|default:"one size"|prefix:" - "}', bare),
    ).toBe("Mast - one size");
  });

  it("default does not fire when there is a value", () => {
    expect(renderName('{options|default:"one size"}', withOptions)).toBe(
      "L Blue",
    );
  });

  it("filters chain left to right", () => {
    expect(renderName("{title|upper|truncate:3}", bare)).toBe("MAS");
  });

  it("an unknown filter is an error, not a silent pass-through", () => {
    const { errors } = parseTemplate("{title|shout}");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("unknown_filter");
  });
});

describe("tidy", () => {
  it("is idempotent", () => {
    const messy = "  Mast -  - / 490  ";
    expect(tidy(tidy(messy))).toBe(tidy(messy));
  });

  it("leaves a decimal comma alone", () => {
    expect(tidy("19,90")).toBe("19,90");
  });
});
