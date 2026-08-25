import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildPreview,
  nameFor,
  settingsFromTemplate,
  type VariantFacts,
} from "~/domain/products/template";

/**
 * The preview and the sync job must name a variant identically, for every
 * template and every variant. A preview that drifts from the job is not a
 * cosmetic bug: the merchant approves one set of names and the job writes a
 * different set across the whole ERP catalogue.
 *
 * Two things are checked. First, that the values agree over a wide corpus.
 * Second — and this is the one that catches the real regression — that the sync
 * job still routes through the shared entry point at all, because the way this
 * guarantee actually breaks is somebody adding a second naming path in the job.
 */

const VARIANTS: VariantFacts[] = [
  {
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
    variantCount: 4,
  },
  {
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
    variantCount: 1,
  },
  {
    productTitle: "Sail",
    variantTitle: "5.4",
    optionValues: ["5.4"],
    optionNames: ["Size"],
    sku: "S-54",
    barcode: null,
    vendor: null,
    productType: "Sails",
    handle: "sail",
    price: null,
    metafields: { "specs.area": "5.4" },
    variantCount: 6,
  },
];

const TEMPLATES = [
  "{title}",
  "{title}[ {options}]",
  "{title}[ - {options}]",
  "{title}[ {options}][ {sku}]",
  "{vendor}[ {title}][ {options}]",
  '{title}{option1|prefix:" - "}',
  '{title}{option1|suffix:" cm"}',
  "{title}[ ({option1}/{option2})]",
  "{title|upper}[ {sku|lower}]",
  '{metafield.specs.area|suffix:" m2"}[ {title}]',
  '{options|default:"one size"}[ {title}]',
  "{title} - {options} - {sku}",
];

describe("the preview and the sync job agree", () => {
  it("produces the same name for every template and variant", () => {
    for (const template of TEMPLATES) {
      const settings = settingsFromTemplate(template);
      const preview = buildPreview({ settings, variants: VARIANTS });

      VARIANTS.forEach((facts, index) => {
        // What the job computes.
        const fromJob = nameFor(settings, facts).name;
        // What the merchant was shown.
        const fromPreview = preview.rows[index]?.nextName;
        expect(fromPreview).toBe(fromJob);
      });
    }
  });

  it("agrees when a rule takes over from the default template", () => {
    const settings = {
      defaultTemplate: "{title}",
      rules: [
        {
          id: "masts",
          label: "Masts in cm",
          conditions: [{ field: "type", operator: "is_empty" as const }],
          template: '{title}{option1|suffix:" cm"}',
        },
      ],
    };

    const preview = buildPreview({ settings, variants: VARIANTS });
    VARIANTS.forEach((facts, index) => {
      const fromJob = nameFor(settings, facts);
      expect(preview.rows[index]?.nextName).toBe(fromJob.name);
      expect(preview.rows[index]?.ruleId).toBe(fromJob.ruleId);
    });

    // And the rule really did fire for the one product with no type.
    expect(preview.rows[1]?.ruleId).toBe("masts");
    expect(preview.rows[0]?.ruleId).toBeNull();
  });

  it("the sync job has no naming logic of its own", () => {
    const source = readFileSync("src/jobs/handlers/sync-products.ts", "utf8");

    // It must go through the shared entry point...
    expect(source).toMatch(/nameFor\(/);
    // ...and must not reach past it into the renderer, or reimplement the
    // template syntax itself.
    expect(source).not.toMatch(/renderTemplate\(|renderName\(|parseTemplate\(/);
    expect(source).not.toMatch(/\{title\}|\{options\}/);
  });
});

describe("the preview never writes", () => {
  it("imports nothing that could", () => {
    const source = readFileSync(
      "src/domain/products/template/preview.ts",
      "utf8",
    );
    expect(source).not.toMatch(/from "~\/adapters/);
    expect(source).not.toMatch(/prisma|MetakockaClient|admin\.graphql/);
  });

  it("reports what would change without changing it", () => {
    const settings = settingsFromTemplate("{title}[ {options}]");
    const currentNames = new Map<string, string | null>([
      ["TS-001-L", "T-Shirt L Blue"],
      ["M-490", "Old mast name"],
    ]);

    const { rows, totals } = buildPreview({
      settings,
      variants: VARIANTS,
      currentNames,
    });

    expect(rows[0]?.status).toBe("unchanged");
    expect(rows[1]?.status).toBe("changed");
    expect(rows[2]?.status).toBe("new");
    expect(totals).toMatchObject({
      rows: 3,
      changed: 1,
      unchanged: 1,
      created: 1,
    });
  });
});
