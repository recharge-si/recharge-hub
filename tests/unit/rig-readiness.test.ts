import { describe, expect, it } from "vitest";

import { coverage, filledKeys } from "~/domain/attributes/coverage";
import { rigPack } from "~/domain/attributes/rig-pack";
import {
  readinessLines,
  readinessText,
  type ReadinessLine,
} from "~/web/lib/rig-readiness";

/**
 * docs/attributes.md, Rig readiness: one stated line per type, a type with
 * no products says so, and the filter link counts the same products the line
 * does.
 */

const plan = rigPack();
const sails = plan.types.find((t) => t.name === "Sails")!;
const all = plan.attributes
  .filter((a) => a.requiredDefault && /^recharge\.sail_/.test(a.key))
  .map((a) => a.key);

describe("readiness lines", () => {
  const catalogue = Array.from({ length: 20 }, (_, i) => ({
    productId: `p${i}`,
    typeId: sails.id,
    filled: i < 12 ? all : all.filter((k) => k !== "recharge.sail_boom_max_cm"),
  }));
  const lines = readinessLines(plan, coverage(plan, catalogue));
  const sail = lines.find((l) => l.type === "sails")!;

  it("states 12 of 20 once, naming what is missing", () => {
    expect(readinessText(sail)).toBe(
      "12 of 20 ready · missing Sail boom length (max) (8)",
    );
  });

  it("links to exactly the 8, not all 20", () => {
    expect(sail.incomplete).toBe(8);
    expect(sail.href).toBe("/app/products?incomplete=sails");
  });

  it("says No products for a type nothing belongs to, with no link", () => {
    const masts = lines.find((l) => l.type === "masts")!;
    expect(readinessText(masts)).toBe("No products");
    expect(masts.href).toBeNull();
  });

  it("is plain when complete", () => {
    const done: ReadinessLine = {
      type: "fins",
      name: "Fins",
      products: 4,
      ready: 4,
      missing: [],
      incomplete: 0,
      href: null,
    };
    expect(readinessText(done)).toBe(
      "All 4 products have the data the rig builder needs",
    );
  });
});

describe("filledKeys", () => {
  it("counts a variant attribute only when every variant has it", () => {
    const keys = filledKeys(plan, {
      metafields: ["recharge.sail_category"],
      variants: [
        { metafields: ["recharge.sail_area_m2"] },
        { metafields: ["recharge.sail_area_m2", "recharge.sail_luff_cm"] },
      ],
    });
    expect(keys).toContain("recharge.sail_category");
    expect(keys).toContain("recharge.sail_area_m2");
    expect(keys).not.toContain("recharge.sail_luff_cm");
  });

  it("does not count a variant attribute for a product with no variants", () => {
    expect(filledKeys(plan, { metafields: [], variants: [] })).not.toContain(
      "recharge.sail_area_m2",
    );
  });
});
