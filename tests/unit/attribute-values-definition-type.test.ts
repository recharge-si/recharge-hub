import { describe, expect, it } from "vitest";

import { mergeRigPack } from "~/domain/attributes/rig-pack";
import { emptySchema } from "~/domain/attributes/types";
import {
  attributeChanges,
  attributeFields,
  definitionKey,
  inputsFrom,
  namedWriteErrors,
} from "~/domain/products/attribute-values";

/**
 * docs/attributes.md § Metafield definitions: a value is written with the
 * type of its definition, a choice outside the options is refused before the
 * call, and Shopify's objections name the attribute.
 */

const plan = mergeRigPack(emptySchema()).schema;
const sails = plan.types.find((t) => t.name === "Sails")!;
const owners = { productId: "gid://shopify/Product/1", variantIds: ["v1"] };

function fieldsWith(definitions: Map<string, string>) {
  return attributeFields(plan, sails.id, {
    definitions,
    product: {},
    variants: [],
  });
}

describe("a value takes its definition's type", () => {
  it("saves 4,2 as 4.2 with the definition's number_decimal", () => {
    const fields = fieldsWith(
      new Map([
        [definitionKey("variant", "recharge.sail_area_m2"), "number_decimal"],
      ]),
    );
    const before = inputsFrom(fields, {}, [
      { variantId: "v1", metafields: {} },
    ]);
    const changes = attributeChanges(fields, owners, before, {
      ...before,
      "rig_sail_area_m2@v1": "4,2",
    });
    expect(changes.errors).toEqual({});
    expect(changes.writes).toEqual([
      {
        ownerId: "v1",
        namespace: "recharge",
        key: "sail_area_m2",
        type: "number_decimal",
        value: "4.2",
      },
    ]);
  });

  it("uses the definition's type even when the plan's format would say another", () => {
    const fields = fieldsWith(
      new Map([
        [definitionKey("variant", "recharge.sail_luff_cm"), "number_decimal"],
      ]),
    );
    const before = inputsFrom(fields, {}, [
      { variantId: "v1", metafields: {} },
    ]);
    const changes = attributeChanges(fields, owners, before, {
      ...before,
      "rig_sail_luff_cm@v1": "395,5",
    });
    expect(changes.writes[0]).toMatchObject({
      type: "number_decimal",
      value: "395.5",
    });
  });
});

describe("a choice outside the options", () => {
  it("is refused before any call, naming the value", () => {
    const fields = fieldsWith(new Map());
    const before = inputsFrom(fields, {}, [
      { variantId: "v1", metafields: {} },
    ]);
    const changes = attributeChanges(fields, owners, before, {
      ...before,
      rig_sail_category: "surf",
    });
    expect(changes.writes).toEqual([]);
    expect(changes.errors).toEqual({
      rig_sail_category: '"surf" is not one of the options.',
    });
  });
});

describe("namedWriteErrors", () => {
  const fields = fieldsWith(new Map());
  const writes = [
    { namespace: "recharge", key: "sail_category" },
    { namespace: "recharge", key: "sail_area_m2" },
  ];

  it("names the attribute the error concerns", () => {
    expect(
      namedWriteErrors(
        [{ message: "Value must be a decimal.", index: 1 }],
        writes,
        fields,
      ),
    ).toEqual(["Sail area: Value must be a decimal."]);
  });

  it("keeps Shopify's wording when it did not say which write", () => {
    expect(
      namedWriteErrors(
        [{ message: "Something else.", index: null }],
        writes,
        fields,
      ),
    ).toEqual(["Something else."]);
  });
});
