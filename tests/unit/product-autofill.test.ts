import { describe, expect, it } from "vitest";

import type {
  AttributeField,
  FieldEdit,
} from "~/domain/products/attribute-values";
import {
  attributesToFill,
  chosenType,
  confidentEnough,
  inputsWithSuggestions,
  plainText,
  suggestedValues,
} from "~/domain/products/autofill";

/**
 * docs/attributes.md § AI autofill: only empty, writable fields are asked
 * about; an answer becomes a suggestion only if a person's entry would be
 * accepted in its place; applying never overwrites what is there.
 */

function field(
  attributeId: string,
  edit: FieldEdit,
  scope: "product" | "variant" = "product",
): AttributeField {
  return {
    attributeId,
    name: attributeId,
    description: "",
    required: false,
    scope,
    dataType: "text",
    group: null,
    namespace: "recharge",
    key: attributeId,
    edit,
  };
}

const base = { shopifyType: "x", unit: "", measurementUnit: null, options: [] };
const COLOURS = [
  { code: "red", label: "Red" },
  { code: "dark_blue", label: "Dark blue" },
];

const FIELDS: AttributeField[] = [
  field("brand", { ...base, kind: "text" }),
  field("colour", { ...base, kind: "choice", options: COLOURS }),
  field("uses", { ...base, kind: "choices", options: COLOURS }),
  field("weight", { ...base, kind: "decimal", unit: "kg" }),
  field("battens", { ...base, kind: "integer" }),
  field("waterproof", { ...base, kind: "boolean" }),
  field(
    "size",
    {
      ...base,
      kind: "measurement",
      unit: "cm",
      measurementUnit: "CENTIMETERS",
    },
    "variant",
  ),
  field("linked", { kind: "blocked", reason: "A reference." }),
];
const VARIANTS = ["v1", "v2"];

describe("what is asked", () => {
  it("asks about empty writable fields, a variant field while any variant is empty", () => {
    const asked = attributesToFill(
      FIELDS,
      { brand: "Point-7", "size@v1": "430", "size@v2": "" },
      VARIANTS,
    );
    expect(asked.map((a) => a.id)).toEqual([
      "colour",
      "uses",
      "weight",
      "battens",
      "waterproof",
      "size",
    ]);
    expect(asked.find((a) => a.id === "colour")?.options).toEqual(COLOURS);
    expect(asked.find((a) => a.id === "size")).toMatchObject({
      format: "measurement",
      unit: "cm",
      level: "variant",
    });
  });

  it("does not ask about a variant field of a product without variants", () => {
    const asked = attributesToFill([FIELDS[6]!], {}, []);
    expect(asked).toEqual([]);
  });
});

describe("what is accepted", () => {
  const answer = (
    values: Array<{
      attributeId: string;
      variantId?: string | null;
      value: string | number | boolean | Array<string | number> | null;
    }>,
  ) => suggestedValues(FIELDS, { brand: "Point-7" }, VARIANTS, { values });

  it("takes a code or a label for a choice, and drops what is not an option", () => {
    expect(
      answer([
        { attributeId: "colour", value: "Dark blue" },
        { attributeId: "uses", value: ["red", "green", "RED"] },
      ]).map((v) => [v.key, v.input, v.display]),
    ).toEqual([
      ["colour", "dark_blue", "Dark blue"],
      ["uses", ["red"], "Red"],
    ]);
    expect(answer([{ attributeId: "colour", value: "green" }])).toEqual([]);
  });

  it("reads the number out of a number, never a range or words", () => {
    expect(
      answer([
        { attributeId: "weight", value: "4,2 kg" },
        { attributeId: "battens", value: 5 },
      ]).map((v) => [v.key, v.input, v.display]),
    ).toEqual([
      ["weight", "4.2", "4.2 kg"],
      ["battens", "5", "5"],
    ]);
    expect(answer([{ attributeId: "battens", value: "about five" }])).toEqual(
      [],
    );
    expect(answer([{ attributeId: "battens", value: "4.5" }])).toEqual([]);
  });

  it("puts a variant value only on a variant the product has", () => {
    expect(
      answer([
        { attributeId: "size", variantId: "v2", value: "430" },
        { attributeId: "size", variantId: "v9", value: "460" },
        { attributeId: "size", value: "400" },
      ]).map((v) => v.key),
    ).toEqual(["size@v2"]);
  });

  it("never suggests over a value that is there, a blocked field or twice", () => {
    expect(
      answer([
        { attributeId: "brand", value: "Other" },
        { attributeId: "linked", value: "x" },
        { attributeId: "waterproof", value: "yes" },
        { attributeId: "waterproof", value: false },
        { attributeId: "unknown", value: "x" },
      ]).map((v) => [v.key, v.input]),
    ).toEqual([["waterproof", "true"]]);
  });
});

describe("applying", () => {
  const values = suggestedValues(FIELDS, {}, VARIANTS, {
    values: [
      { attributeId: "brand", value: "Point-7" },
      { attributeId: "battens", value: "4" },
    ],
  });

  it("fills only what is kept and still empty", () => {
    expect(
      inputsWithSuggestions(
        { brand: "Entered since", battens: "" },
        values,
        new Set(["brand", "battens"]),
      ),
    ).toEqual({ brand: "Entered since", battens: "4" });
    expect(inputsWithSuggestions({}, values, new Set(["battens"]))).toEqual({
      battens: "4",
    });
  });
});

describe("the rest", () => {
  it("uses a type only if the plan offers it", () => {
    const types = [{ id: "wave", name: "Wave sails", path: ["Wave sails"] }];
    expect(chosenType("wave", types)?.id).toBe("wave");
    expect(chosenType("invented", types)).toBeNull();
    expect(chosenType(null, types)).toBeNull();
  });

  it("reads a description as plain text, clipped", () => {
    expect(
      plainText(
        "<p>Wave&nbsp;sail</p><ul><li>5.3 m²</li></ul><script>x</script>",
      ),
    ).toBe("Wave sail\n5.3 m²");
    expect(plainText("a".repeat(10), 4)).toBe("aaaa");
  });
});

describe("applying without a person", () => {
  const base = { typeId: "wave", values: [] as unknown[] };

  it("needs the categorizer to be sure of a type it chose", () => {
    expect(
      confidentEnough({
        ...base,
        typeOrigin: "suggested",
        typeConfidence: 0.8,
      }),
    ).toBe(true);
    expect(
      confidentEnough({
        ...base,
        typeOrigin: "suggested",
        typeConfidence: 0.79,
      }),
    ).toBe(false);
    expect(
      confidentEnough({
        ...base,
        typeOrigin: "suggested",
        typeConfidence: null,
      }),
    ).toBe(false);
  });

  it("fills values for a type the product already had", () => {
    expect(
      confidentEnough({
        ...base,
        typeOrigin: "kept",
        typeConfidence: null,
        values: [{}],
      }),
    ).toBe(true);
    expect(
      confidentEnough({ ...base, typeOrigin: "kept", typeConfidence: null }),
    ).toBe(false);
  });

  it("never applies 'no type fits'", () => {
    expect(
      confidentEnough({
        typeId: null,
        typeOrigin: "suggested",
        typeConfidence: 0.95,
        values: [],
      }),
    ).toBe(false);
  });
});
