import { describe, expect, it } from "vitest";

import { rigReadiness } from "~/domain/rig/candidates";
import { planCoversRig, planMissingRigKeys } from "~/domain/rig/plan";
import { emptySchema } from "~/domain/attributes/types";
import {
  readinessLines,
  readinessText,
  roleOfType,
  type ReadinessLine,
} from "~/web/lib/rig-readiness";
import { SHOP_A, loadCatalogue, rigPlan } from "../support/rig-fixtures";

/**
 * docs/rig-builder.md, Readiness: one stated line per role, counted on the
 * keys the engine reads (with the derivations), each number stated once, and
 * the filter link counts the same products the line does.
 */

const products = () => loadCatalogue().filter((p) => p.shopId === SHOP_A);
const lines = (list = products()) =>
  readinessLines(emptySchema(), rigReadiness(rigPlan(), list));

describe("readiness lines", () => {
  it("states 7 of 8 sails once, naming the missing key and its count", () => {
    const sail = lines().find((l) => l.type === "sails")!;
    expect(readinessText(sail)).toBe("7 of 8 ready · missing canopy_area (1)");
    expect(sail.incomplete).toBe(1);
    expect(sail.href).toBe("/app/products?incomplete=sails");
  });

  it("lists the top missing keys of a role, most common first, at most three", () => {
    const mast = lines().find((l) => l.type === "masts")!;
    expect(readinessText(mast)).toBe(
      "4 of 5 ready · missing length_cm (1), mast_diameter (1)",
    );
  });

  it("uses the plan name for a key when the plan has one", () => {
    const plan = emptySchema();
    plan.attributes.push({
      id: "a1",
      name: "Canopy area",
      setId: "s",
      dataType: "decimal",
      unit: "m²",
      description: "",
      scope: "variant",
      key: "recharge.canopy_area",
      implementation: "custom",
      requiredDefault: false,
      filterable: false,
      searchable: false,
      comparable: false,
      valueListId: null,
    });
    const sail = readinessLines(plan, rigReadiness(rigPlan(), products())).find(
      (l) => l.type === "sails",
    )!;
    expect(readinessText(sail)).toBe("7 of 8 ready · missing Canopy area (1)");
  });

  it("is plain when complete, and has no line for a role with no products", () => {
    const done: ReadinessLine = {
      type: "fins",
      name: "Fins",
      products: 4,
      ready: 4,
      missing: [],
      incomplete: 0,
      href: null,
      stockNotRead: false,
    };
    expect(readinessText(done)).toBe("All 4 products have the data the rig builder needs");
    const only = lines(products().filter((p) => p.productType === "Masts"));
    expect(only.map((l) => l.type)).toEqual(["masts"]);
  });

  it("says No products for a role line with none", () => {
    const empty: ReadinessLine = {
      type: "booms",
      name: "Booms",
      products: 0,
      ready: 0,
      missing: [],
      incomplete: 0,
      href: null,
      stockNotRead: false,
    };
    expect(readinessText(empty)).toBe("No products");
  });

  it("says stock was not read when no variant has a quantity, and keeps the data counts", () => {
    const unread = products().map((p) => ({
      ...p,
      variants: p.variants.map((v) => ({ ...v, inventoryQuantity: null })),
    }));
    const sail = lines(unread).find((l) => l.type === "sails")!;
    expect(sail.stockNotRead).toBe(true);
    expect(readinessText(sail)).toBe(
      "7 of 8 ready · missing canopy_area (1) · stock not read yet: refresh the catalogue",
    );
  });

  it("links to exactly the products the line counted as incomplete", () => {
    const readiness = rigReadiness(rigPlan(), products());
    const ids = readiness.roles.sail.incomplete;
    expect(ids).toHaveLength(1);
    const mystery = products().find((p) => p.title === "Mystery Sail");
    expect(ids).toEqual([mystery?.productId]);
  });

  it("maps a filter value back to a role", () => {
    expect(roleOfType("sails")).toBe("sail");
    expect(roleOfType("extensions")).toBe("extension");
    expect(roleOfType("harnesses")).toBeNull();
  });
});

describe("plan coverage", () => {
  it("sees that an empty plan holds none of the keys the engine places parts with", () => {
    expect(planCoversRig(emptySchema())).toBe(false);
    expect(planMissingRigKeys(emptySchema())).toContain("canopy_area");
  });

  it("sees that a plan with all of them needs no example attributes", () => {
    const plan = emptySchema();
    for (const key of planMissingRigKeys(plan)) {
      plan.attributes.push({
        id: key,
        name: key,
        setId: "s",
        dataType: "text",
        unit: "",
        description: "",
        scope: "variant",
        key: `recharge.${key}`,
        implementation: "custom",
        requiredDefault: false,
        filterable: false,
        searchable: false,
        comparable: false,
        valueListId: null,
      });
    }
    expect(planCoversRig(plan)).toBe(true);
  });
});
