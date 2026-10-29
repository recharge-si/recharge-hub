import { describe, expect, it } from "vitest";

import {
  planDefinitions,
  type ExistingDefinition,
} from "~/domain/attributes/definitions";
import {
  emptySchema,
  type Attribute,
  type AttributeSchema,
} from "~/domain/attributes/types";

function attribute(
  id: string,
  name: string,
  dataType: Attribute["dataType"],
  key: string,
  extra: Partial<Attribute> = {},
): Attribute {
  return {
    id,
    name,
    setId: null,
    dataType,
    unit: "",
    description: "",
    scope: "product",
    key,
    implementation: "custom",
    requiredDefault: false,
    filterable: false,
    searchable: false,
    comparable: false,
    valueListId: null,
    ...extra,
  };
}

/** Six attributes: decimal, select, integer, text, measurement per variant, boolean. */
function fixture(): AttributeSchema {
  return {
    ...emptySchema(),
    attributes: [
      attribute("size", "Sail size", "decimal", "recharge.sail_size", {
        scope: "variant",
      }),
      attribute(
        "skill",
        "Skill level",
        "single_select",
        "recharge.skill_level",
        {
          valueListId: "skill",
        },
      ),
      attribute("year", "Model year", "integer", "recharge.model_year"),
      attribute("brand", "Brand", "text", "recharge.brand"),
      attribute("luff", "Luff length", "measurement", "recharge.luff_cm", {
        unit: "cm",
        scope: "variant",
      }),
      attribute("used", "Used", "boolean", "recharge.used"),
    ],
    valueLists: [
      {
        id: "skill",
        items: [
          { code: "beginner", en: "Beginner", si: "" },
          { code: "advanced", en: "Advanced", si: "" },
        ],
      },
    ],
  };
}

const existing: ExistingDefinition[] = [
  {
    ownerType: "PRODUCTVARIANT",
    namespace: "recharge",
    key: "sail_size",
    type: "number_decimal",
  },
  {
    ownerType: "PRODUCT",
    namespace: "recharge",
    key: "skill_level",
    type: "multi_line_text_field",
  },
  {
    ownerType: "PRODUCT",
    namespace: "custom",
    key: "warranty",
    type: "single_line_text_field",
  },
];

describe("planDefinitions", () => {
  const plan = planDefinitions(fixture(), existing);

  it("counts 4 to create, 1 unchanged, 1 conflict and lists 1 foreign", () => {
    expect(plan.counts).toMatchObject({ create: 4, unchanged: 1, conflict: 1 });
    expect(plan.foreign.map((d) => `${d.namespace}.${d.key}`)).toEqual([
      "custom.warranty",
    ]);
    expect(plan.rows).toHaveLength(6);
  });

  it("shows the existing type of a conflict and never creates it", () => {
    const row = plan.rows.find((r) => r.attributeId === "skill");
    expect(row).toMatchObject({
      status: "conflict",
      type: "single_line_text_field",
      existingType: "multi_line_text_field",
      draft: null,
    });
  });

  it("resolves types the way the product page writes values", () => {
    const types = Object.fromEntries(
      plan.rows.map((r) => [r.attributeId, r.type]),
    );
    expect(types).toEqual({
      size: "number_decimal",
      skill: "single_line_text_field",
      year: "number_integer",
      brand: "single_line_text_field",
      luff: "dimension",
      used: "boolean",
    });
  });

  it("takes the owner type from the attribute's scope", () => {
    expect(plan.rows.find((r) => r.attributeId === "luff")?.ownerType).toBe(
      "PRODUCTVARIANT",
    );
    expect(plan.rows.find((r) => r.attributeId === "year")?.ownerType).toBe(
      "PRODUCT",
    );
  });

  it("gives a select its option codes, in order, as a choices validation", () => {
    const schema = fixture();
    const plan2 = planDefinitions(schema, []);
    const row = plan2.rows.find((r) => r.attributeId === "skill");
    expect(row?.draft?.validations).toEqual([
      { name: "choices", value: JSON.stringify(["beginner", "advanced"]) },
    ]);
    expect(row?.draft).toMatchObject({
      namespace: "recharge",
      key: "skill_level",
      name: "Skill level",
    });
  });

  it("is the same on a re-run once everything exists", () => {
    const all = planDefinitions(fixture(), []).rows.flatMap((r) =>
      r.draft
        ? [
            {
              ownerType: r.draft.ownerType,
              namespace: r.draft.namespace,
              key: r.draft.key,
              type: r.draft.type,
            },
          ]
        : [],
    );
    const again = planDefinitions(fixture(), all);
    expect(again.counts).toMatchObject({
      create: 0,
      unchanged: 6,
      conflict: 0,
    });
  });
});

describe("planDefinitions edge rows", () => {
  it("skips unmapped, malformed, reference and option-less rows with a reason", () => {
    const schema: AttributeSchema = {
      ...emptySchema(),
      attributes: [
        attribute("a", "Unmapped", "text", ""),
        attribute("b", "Malformed", "text", "no-dot"),
        attribute("c", "Link", "reference", "recharge.link"),
        attribute("d", "Choice", "single_select", "recharge.choice"),
        attribute("e", "Twin one", "text", "recharge.twin"),
        attribute("f", "Twin two", "text", "recharge.twin"),
      ],
    };
    const plan = planDefinitions(schema, []);
    expect(plan.rows.map((r) => [r.attributeId, r.status])).toEqual([
      ["a", "skipped"],
      ["b", "skipped"],
      ["c", "skipped"],
      ["d", "skipped"],
      ["e", "create"],
      ["f", "skipped"],
    ]);
    expect(plan.rows.every((r) => r.status === "create" || r.reason)).toBe(
      true,
    );
  });

  it("leaves the store menu's field to the menu run", () => {
    const schema: AttributeSchema = {
      ...emptySchema(),
      attributes: [
        attribute("m", "Path", "multi_select", "recharge.product_type_path"),
      ],
    };
    const plan = planDefinitions(schema, [
      {
        ownerType: "PRODUCT",
        namespace: "recharge",
        key: "product_type_path",
        type: "list.single_line_text_field",
      },
    ]);
    expect(plan.rows[0]).toMatchObject({ status: "managed", draft: null });
    expect(plan.counts).toMatchObject({ create: 0, conflict: 0 });
    expect(plan.foreign).toEqual([]);
  });

  it("flags a key outside the app's namespace and sets storefront access only when asked", () => {
    const schema: AttributeSchema = {
      ...emptySchema(),
      attributes: [
        attribute("x", "Material", "text", "custom.material"),
        attribute("y", "Open", "text", "recharge.open", { storefront: true }),
        attribute("z", "Closed", "text", "recharge.closed"),
      ],
    };
    const plan = planDefinitions(schema, []);
    const by = (id: string) => plan.rows.find((r) => r.attributeId === id);
    expect(by("x")).toMatchObject({ owned: false, status: "create" });
    expect(by("y")?.draft?.storefrontAccess).toBe("PUBLIC_READ");
    expect(by("z")?.draft?.storefrontAccess).toBeNull();
  });

  it("treats the same key on a product and on a variant as two definitions", () => {
    const schema: AttributeSchema = {
      ...emptySchema(),
      attributes: [
        attribute("p", "Weight", "decimal", "recharge.weight_kg"),
        attribute("v", "Weight per size", "decimal", "recharge.weight_kg", {
          scope: "variant",
        }),
      ],
    };
    expect(planDefinitions(schema, []).counts.create).toBe(2);
  });
});
