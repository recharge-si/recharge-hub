import { describe, expect, it } from "vitest";

import {
  hasBlockingError,
  lintTemplate,
  parseTemplate,
  type VariantFacts,
} from "~/domain/products/template";

const shirt: VariantFacts = {
  productTitle: "T-Shirt",
  variantTitle: "L / Blue",
  optionValues: ["L", "Blue"],
  optionNames: ["Size", "Colour"],
  sku: "TS-L",
  barcode: null,
  vendor: "Acme",
  productType: "Shirts",
  handle: "t-shirt",
  price: "19.90",
  variantCount: 4,
};

const shirtSmall: VariantFacts = {
  ...shirt,
  sku: "TS-S",
  optionValues: ["S", "Blue"],
};

function lint(template: string, variants: VariantFacts[], known?: Set<string>) {
  return lintTemplate({
    nodes: parseTemplate(template).nodes,
    variants,
    knownMetafields: known,
  });
}

const codes = (
  template: string,
  variants: VariantFacts[],
  known?: Set<string>,
) => lint(template, variants, known).map((diagnostic) => diagnostic.code);

describe("errors block saving", () => {
  it("catches two variants that would share a name", () => {
    const found = lint("{title}", [shirt, shirtSmall]);
    const duplicate = found.find((d) => d.code === "duplicate_name");

    expect(duplicate?.severity).toBe("error");
    expect(duplicate?.count).toBe(2);
    expect(duplicate?.sampleIds).toEqual(["TS-L", "TS-S"]);
    expect(hasBlockingError(found)).toBe(true);
  });

  it("does not fire when the variants differ", () => {
    expect(codes("{title}[ {option1}]", [shirt, shirtSmall])).not.toContain(
      "duplicate_name",
    );
  });

  it("catches a template that names nothing", () => {
    const bare: VariantFacts = {
      ...shirt,
      productTitle: "Mast",
      optionValues: [],
      optionNames: [],
      sku: "M-1",
      variantCount: 1,
    };
    const found = lint("{options}", [bare]);
    const empty = found.find((d) => d.code === "empty_name");

    expect(empty?.severity).toBe("error");
    expect(empty?.sampleIds).toEqual(["M-1"]);
  });
});

describe("warnings are worth reading but do not block", () => {
  it("spots a token that repeats the title", () => {
    const found = lint("{title}[ {type}]", [
      { ...shirt, productTitle: "Shirts summer tee", productType: "Shirts" },
    ]);
    const redundant = found.find((d) => d.code === "redundant_token");

    expect(redundant?.severity).toBe("warning");
    expect(hasBlockingError(found)).toBe(false);
  });

  it("spots a token that is empty for everything previewed", () => {
    expect(codes("{title}[ {barcode}]", [shirt, shirtSmall])).toContain(
      "always_empty",
    );
  });

  it("spots a multi-variant product with no variant-level field", () => {
    const found = lint("{title}", [shirt]);
    expect(found.map((d) => d.code)).toContain("no_variant_field");
  });

  it("stays quiet when a variant-level field is present", () => {
    expect(codes("{title}[ {sku}]", [shirt])).not.toContain("no_variant_field");
  });

  it("spots a metafield the shop no longer defines", () => {
    const withMeta: VariantFacts = {
      ...shirt,
      metafields: { "specs.area": "5.4" },
    };
    expect(
      codes(
        "{title}[ {metafield.specs.gone}]",
        [withMeta],
        new Set(["specs.area"]),
      ),
    ).toContain("missing_metafield");

    expect(
      codes(
        "{title}[ {metafield.specs.area}]",
        [withMeta],
        new Set(["specs.area"]),
      ),
    ).not.toContain("missing_metafield");
  });
});

describe("every diagnostic is actionable", () => {
  it("carries a count, samples and a message that says what to do", () => {
    const found = lint("{title}", [shirt, shirtSmall]);
    expect(found.length).toBeGreaterThan(0);

    for (const diagnostic of found) {
      expect(diagnostic.count).toBeGreaterThan(0);
      expect(diagnostic.sampleIds.length).toBeGreaterThan(0);
      expect(diagnostic.sampleIds.length).toBeLessThanOrEqual(5);
      expect(diagnostic.message.length).toBeGreaterThan(20);
      // Section 2.8: an error says what is wrong and how to fix it.
      expect(diagnostic.message).toMatch(/\.$/);
    }
  });

  it("says nothing at all when there is nothing to preview", () => {
    expect(lint("{title}", [])).toEqual([]);
  });
});
