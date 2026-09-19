import { describe, expect, it } from "vitest";

import {
  impactOfDeletingType,
  impactOfMovingType,
  workspaceState,
} from "~/domain/attributes/impact";
import { addAttribute, attachAttributes } from "~/domain/attributes/mutations";
import { activeAttributes } from "~/domain/attributes/resolve";
import { starterSchema } from "~/domain/attributes/starter";
import { emptySchema, type IdSource } from "~/domain/attributes/types";

/**
 * docs/attributes.md § Changes and § Screens.
 *
 * A confirmation states what a delete or a move would do in numbers, and
 * the workspace reports where it stands in four honest states rather than
 * calling an empty plan complete.
 */

function ids(): IdSource {
  let n = 0;
  return (prefix) => `${prefix}_${++n}`;
}

describe("impact of structural changes", () => {
  it("counts what deleting a category takes from the types beneath it", () => {
    const impact = impactOfDeletingType(starterSchema(), "sails");
    // Wave sails and Freeride sails each lose the four sail-set fields.
    expect(impact).toMatchObject({
      children: 2,
      descendants: 2,
      sourcesHere: 1,
      rulesHere: 0,
      fieldsLost: 8,
      fieldsGained: 0,
      typesAffected: 2,
    });
  });

  it("reports a leaf with nothing attached as changing nothing else", () => {
    const impact = impactOfDeletingType(starterSchema(), "freeride");
    expect(impact).toMatchObject({
      children: 0,
      descendants: 0,
      sourcesHere: 0,
      fieldsLost: 0,
      typesAffected: 0,
    });
  });

  it("counts what a move gains and loses for the type and its descendants", () => {
    const impact = impactOfMovingType(starterSchema(), "sails", "clothing");
    // Sails and both sail types keep the core set from the root and the
    // sail set, and each gains the clothing size.
    expect(impact).toMatchObject({
      descendants: 2,
      fieldsGained: 3,
      fieldsLost: 0,
      typesAffected: 3,
    });
    expect(
      impactOfMovingType(starterSchema(), "sails", "boards"),
    ).toMatchObject({
      fieldsGained: 6,
      fieldsLost: 0,
    });
  });

  it("returns null for a type that does not exist", () => {
    expect(impactOfDeletingType(starterSchema(), "nope")).toBeNull();
    expect(impactOfMovingType(starterSchema(), "nope", null)).toBeNull();
  });
});

describe("where the workspace stands", () => {
  it("is empty with nothing configured, never complete", () => {
    expect(workspaceState(emptySchema())).toEqual({
      stage: "empty",
      summary: "Nothing configured yet.",
      problems: [],
    });
  });

  it("is partial with categories but no type products can use", () => {
    const schema = emptySchema();
    schema.types.push(
      {
        id: "a",
        name: "All",
        parentId: null,
        leaf: false,
        sortOrder: 1,
        shopifyCategory: "",
        archetype: "",
      },
      {
        id: "b",
        name: "Sails",
        parentId: "a",
        leaf: false,
        sortOrder: 1,
        shopifyCategory: "",
        archetype: "",
      },
    );
    const state = workspaceState(schema);
    expect(state.stage).toBe("partial");
    expect(state.summary).toContain("2 categories organise the tree");
  });

  it("is partial with types but no attributes", () => {
    const schema = starterSchema();
    schema.attributes = [];
    schema.setAssignments = [];
    schema.overrides = [];
    schema.valueLists = [];
    expect(workspaceState(schema)).toMatchObject({
      stage: "partial",
      summary: "Product types exist, but no attributes are defined yet.",
    });
  });

  it("reports issues with a count, and ok only when every check passes", () => {
    expect(workspaceState(starterSchema()).stage).toBe("ok");
    const schema = starterSchema();
    schema.types.push({
      id: "bare",
      name: "Bare",
      parentId: null,
      leaf: true,
      sortOrder: 9,
      shopifyCategory: "",
      archetype: "",
    });
    const state = workspaceState(schema);
    expect(state.stage).toBe("issues");
    expect(state.summary).toBe("1 check needs attention.");
    expect(state.problems[0]?.id).toBe("empty-types");
  });
});

describe("adding several attributes at once", () => {
  it("attaches the new ones, restores the removed one and skips the present", () => {
    const schema = starterSchema();
    schema.exclusions.push({ id: "ex1", typeId: "wave", attributeId: "brand" });
    const result = attachAttributes(
      schema,
      "wave",
      ["brand", "volume", "sailsize"],
      ids(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toBe("2 attributes added.");
    expect(result.schema.exclusions).toEqual([]);
    const active = activeAttributes(result.schema, "wave").map(
      (row) => row.attribute.id,
    );
    expect(active).toContain("brand");
    expect(active).toContain("volume");
    expect(
      attachAttributes(result.schema, "wave", ["brand"], ids()),
    ).toMatchObject({ ok: false });
  });

  it("creates a choice attribute with its options in one step", () => {
    const result = addAttribute(
      starterSchema(),
      {
        name: "Fin box",
        dataType: "single_select",
        unit: "",
        description: "",
        scope: "variant",
        key: "",
        implementation: "custom",
        setId: null,
        requiredDefault: true,
        options: [
          { code: "", en: "US box", si: "" },
          { code: "tuttle", en: "Tuttle", si: "Tuttle" },
        ],
        attachToTypeId: "boards",
      },
      ids(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const added = result.schema.attributes.find(
      (a) => a.id === result.attributeId,
    );
    expect(added?.key).toBe("recharge.fin_box");
    expect(added?.valueListId).toBe("options_2");
    expect(
      result.schema.valueLists.find((l) => l.id === "options_2")?.items,
    ).toEqual([
      { code: "us_box", en: "US box", si: "" },
      { code: "tuttle", en: "Tuttle", si: "Tuttle" },
    ]);
    expect(
      activeAttributes(result.schema, "waveboard").some(
        (r) => r.attribute.id === "attr_1",
      ),
    ).toBe(true);
  });
});
