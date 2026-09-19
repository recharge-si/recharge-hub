import { describe, expect, it } from "vitest";

import {
  addAttribute,
  addSet,
  addType,
  attachAttribute,
  attachSet,
  clearRule,
  deleteAttribute,
  deleteSet,
  deleteType,
  detachSet,
  excludeAttribute,
  moveType,
  restoreAttribute,
  setRequirement,
  updateAttribute,
  updateType,
} from "~/domain/attributes/mutations";
import { activeAttributes, childrenOf } from "~/domain/attributes/resolve";
import { schemaProblems } from "~/domain/attributes/schema";
import { starterSchema } from "~/domain/attributes/starter";
import type { AttributeSchema, IdSource } from "~/domain/attributes/types";

/**
 * docs/attributes.md § Changes.
 *
 * Every change is a pure function from one consistent document to the next.
 * Each case checks the new document is still consistent and that the input
 * was left alone, because a change that edits in place would let a refused
 * save leave a half-applied document behind.
 */

function ids(): IdSource {
  let n = 0;
  return (prefix) => `${prefix}_${++n}`;
}

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok)
    throw new Error(`expected success: ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

function untouched(before: AttributeSchema, run: () => unknown) {
  const snapshot = JSON.stringify(before);
  run();
  expect(JSON.stringify(before)).toBe(snapshot);
}

describe("product types", () => {
  it("adds a type after its siblings and refuses a duplicate name under one parent", () => {
    const schema = starterSchema();
    const added = ok(
      addType(
        schema,
        {
          name: "Slalom sails",
          parentId: "sails",
          leaf: true,
          shopifyCategory: "",
        },
        ids(),
      ),
    );
    expect(childrenOf(added.schema, "sails").map((t) => t.name)).toEqual([
      "Wave sails",
      "Freeride sails",
      "Slalom sails",
    ]);
    expect(schemaProblems(added.schema)).toEqual([]);

    expect(
      addType(
        schema,
        {
          name: "wave SAILS",
          parentId: "sails",
          leaf: true,
          shopifyCategory: "",
        },
        ids(),
      ),
    ).toMatchObject({ ok: false });
    expect(
      addType(
        schema,
        { name: "  ", parentId: null, leaf: true, shopifyCategory: "" },
        ids(),
      ),
    ).toMatchObject({ ok: false });
  });

  it("refuses to move a type under itself or a descendant", () => {
    const schema = starterSchema();
    const patch = {
      name: "Sails",
      leaf: false,
      shopifyCategory: "",
      archetype: "",
    };
    expect(
      updateType(schema, "sails", { ...patch, parentId: "wave" }),
    ).toMatchObject({
      ok: false,
    });
    expect(
      updateType(schema, "sails", { ...patch, parentId: "sails" }),
    ).toMatchObject({
      ok: false,
    });
    const moved = ok(
      updateType(schema, "sails", { ...patch, parentId: "clothing" }),
    );
    expect(
      activeAttributes(moved.schema, "wave").some(
        (r) => r.attribute.id === "size",
      ),
    ).toBe(true);
  });

  it("deletes a type, moving its children up and dropping its rules", () => {
    const schema = starterSchema();
    untouched(schema, () => {
      const result = ok(deleteType(schema, "sails"));
      expect(childrenOf(result.schema, "windsurf").map((t) => t.id)).toEqual([
        "boards",
        "wave",
        "freeride",
      ]);
      expect(
        result.schema.setAssignments.some((r) => r.typeId === "sails"),
      ).toBe(false);
      // The sail set was attached on Sails, so its members are gone from Wave.
      expect(
        activeAttributes(result.schema, "wave").some(
          (r) => r.attribute.id === "sailsize",
        ),
      ).toBe(false);
      expect(schemaProblems(result.schema)).toEqual([]);
    });
  });

  it("moves a type among its siblings and refuses past the ends", () => {
    const schema = starterSchema();
    const down = ok(moveType(schema, "wave", "down"));
    expect(childrenOf(down.schema, "sails").map((t) => t.id)).toEqual([
      "freeride",
      "wave",
    ]);
    expect(moveType(schema, "wave", "up")).toMatchObject({ ok: false });
  });
});

describe("attributes", () => {
  it("adds an attribute with a generated key, made unique within its scope", () => {
    const schema = starterSchema();
    const first = ok(
      addAttribute(
        schema,
        {
          name: "Brand",
          dataType: "text",
          unit: "",
          scope: "product",
          key: "",
          setId: null,
          requiredDefault: false,
          attachToTypeId: "wave",
        },
        ids(),
      ),
    );
    const added = first.schema.attributes.find(
      (a) => a.id === first.attributeId,
    );
    expect(added?.key).toBe("recharge.brand_tr_1");
    expect(first.schema.attributeAssignments).toEqual([
      { id: "aa_2", typeId: "wave", attributeId: "attr_1" },
    ]);
    expect(
      activeAttributes(first.schema, "wave").filter(
        (r) => r.attribute.name === "Brand",
      ),
    ).toHaveLength(2);
  });

  it("saves a select attribute's options as its own list, forking a shared one", () => {
    const schema = starterSchema();
    schema.attributes.push({
      ...(schema.attributes.find(
        (a) => a.id === "skill",
      ) as AttributeSchema["attributes"][number]),
      id: "skill2",
      name: "Skill level (boards)",
      key: "recharge.skill_level_boards",
    });
    const patch = {
      name: "Skill level",
      dataType: "single_select" as const,
      unit: "",
      description: "",
      setId: "sail",
      requiredDefault: false,
      filterable: true,
      searchable: false,
      comparable: false,
      key: "recharge.skill_level",
      scope: "product" as const,
      implementation: "custom" as const,
      options: [
        { code: "", en: "Beginner", si: "" },
        { code: "pro", en: "Professional", si: "Profesionalec" },
      ],
    };
    const result = ok(updateAttribute(schema, "skill", patch, ids()));
    const saved = result.schema.attributes.find((a) => a.id === "skill");
    expect(saved?.valueListId).toBe("options_1");
    expect(
      result.schema.valueLists.find((l) => l.id === "options_1")?.items,
    ).toEqual([
      { code: "beginner", en: "Beginner", si: "" },
      { code: "pro", en: "Professional", si: "Profesionalec" },
    ]);
    // The other attribute still has the original list, untouched.
    expect(
      result.schema.valueLists.find((l) => l.id === "skill")?.items,
    ).toHaveLength(2);

    expect(
      updateAttribute(
        schema,
        "skill",
        { ...patch, options: [{ code: "x", en: "", si: "" }] },
        ids(),
      ),
    ).toMatchObject({
      ok: false,
      message: "Every option needs an English label.",
    });
    expect(
      updateAttribute(
        schema,
        "skill",
        { ...patch, key: "recharge.brand" },
        ids(),
      ),
    ).toMatchObject({ ok: false });
  });

  it("deletes an attribute everywhere with its rules and orphaned options", () => {
    const schema = starterSchema();
    const result = ok(deleteAttribute(schema, "skill"));
    expect(result.schema.attributes.some((a) => a.id === "skill")).toBe(false);
    expect(result.schema.overrides).toEqual([]);
    expect(result.schema.valueLists.some((l) => l.id === "skill")).toBe(false);
    expect(schemaProblems(result.schema)).toEqual([]);
  });
});

describe("sets and sources", () => {
  it("deletes a set without any type losing a field", () => {
    const schema = starterSchema();
    const before = activeAttributes(schema, "wave")
      .map((r) => r.attribute.id)
      .sort();
    const result = ok(deleteSet(schema, "sail", ids()));
    const after = activeAttributes(result.schema, "wave")
      .map((r) => r.attribute.id)
      .sort();
    expect(after).toEqual(before);
    expect(
      result.schema.attributes.find((a) => a.id === "sailsize")?.setId,
    ).toBeNull();
    expect(
      result.schema.attributeAssignments.every((r) => r.typeId === "sails"),
    ).toBe(true);
    expect(schemaProblems(result.schema)).toEqual([]);
  });

  it("attaches a set once, lifting removals of its members on that type", () => {
    const schema = starterSchema();
    const set = ok(addSet(schema, { name: "Extras", description: "" }, ids()));
    expect(attachSet(set.schema, "all", "core", ids())).toMatchObject({
      ok: false,
    });
    const withRemoval = ok(
      excludeAttribute(schema, "waveboard", "brand", ids()),
    );
    const attached = ok(
      attachSet(withRemoval.schema, "waveboard", "core", ids()),
    );
    expect(attached.schema.exclusions).toEqual([]);
  });

  it("attaches an attribute directly, or restores it when it was removed there", () => {
    const schema = starterSchema();
    expect(attachAttribute(schema, "wave", "brand", ids())).toMatchObject({
      ok: false,
      message: "“Brand” is already on this type.",
    });
    const removed = ok(excludeAttribute(schema, "wave", "brand", ids()));
    const back = ok(attachAttribute(removed.schema, "wave", "brand", ids()));
    expect(back.schema.exclusions).toEqual([]);
    expect(back.schema.attributeAssignments).toEqual([]);
    const direct = ok(attachAttribute(schema, "wave", "volume", ids()));
    expect(
      activeAttributes(direct.schema, "wave").find(
        (r) => r.attribute.id === "volume",
      )?.individual,
    ).toBe(true);
  });

  it("restores a field whose source was detached by attaching it directly", () => {
    const schema = starterSchema();
    const removed = ok(excludeAttribute(schema, "wave", "sailsize", ids()));
    const detached = ok(detachSet(removed.schema, "sa2"));
    const restored = ok(
      restoreAttribute(detached.schema, "wave", "sailsize", ids()),
    );
    expect(restored.schema.attributeAssignments).toEqual([
      { id: "aa_1", typeId: "wave", attributeId: "sailsize" },
    ]);
    expect(
      activeAttributes(restored.schema, "wave").some(
        (r) => r.attribute.id === "sailsize",
      ),
    ).toBe(true);
    expect(
      activeAttributes(restored.schema, "freeride").some(
        (r) => r.attribute.id === "sailsize",
      ),
    ).toBe(false);
  });
});

describe("exact-type rules", () => {
  it("records a requirement only when it differs from the default, and resets", () => {
    const schema = starterSchema();
    const same = ok(setRequirement(schema, "wave", "brand", "required", ids()));
    expect(same.schema.overrides).toHaveLength(1); // only the starter's own
    const changed = ok(
      setRequirement(schema, "wave", "brand", "optional", ids()),
    );
    expect(changed.schema.overrides).toHaveLength(2);
    expect(
      activeAttributes(changed.schema, "wave").find(
        (r) => r.attribute.id === "brand",
      )?.required,
    ).toBe(false);
    expect(
      activeAttributes(changed.schema, "freeride").find(
        (r) => r.attribute.id === "brand",
      )?.required,
    ).toBe(true);
    const reset = ok(
      setRequirement(changed.schema, "wave", "brand", "reset", ids()),
    );
    expect(reset.schema.overrides).toHaveLength(1);
  });

  it("clears a rule by kind and id", () => {
    const schema = starterSchema();
    const cleared = ok(clearRule(schema, "override", "ov1"));
    expect(cleared.schema.overrides).toEqual([]);
    expect(clearRule(schema, "exclusion", "ov1")).toMatchObject({ ok: false });
  });
});
