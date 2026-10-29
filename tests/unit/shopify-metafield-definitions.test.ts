import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { describe, expect, it } from "vitest";

import {
  DEFINITION_PAGE_SIZE,
  applyDefinitions,
  createInput,
  readDefinitions,
} from "~/adapters/shopify/metafield-definitions";
import { planDefinitions } from "~/domain/attributes/definitions";
import {
  emptySchema,
  type Attribute,
  type AttributeSchema,
} from "~/domain/attributes/types";

/**
 * docs/attributes.md § Metafield definitions, against recorded Shopify
 * replies: reads page through every definition, creating sends exactly the
 * mutation the plan implies, and an "already taken" answer is a re-read.
 */

interface Call {
  query: string;
  variables: Record<string, unknown>;
}

function admin(
  respond: (call: Call) => unknown,
  calls: Call[] = [],
): AdminApiContext {
  return {
    graphql: async (
      query: string,
      options?: { variables?: Record<string, unknown> },
    ) => {
      const call = { query, variables: options?.variables ?? {} };
      calls.push(call);
      return { json: async () => ({ data: respond(call) }) };
    },
  } as unknown as AdminApiContext;
}

function node(i: number) {
  return {
    id: `gid://shopify/MetafieldDefinition/${i}`,
    namespace: "recharge",
    key: `field_${i}`,
    name: `Field ${i}`,
    type: { name: "single_line_text_field" },
  };
}

describe("readDefinitions", () => {
  it("pages through 250 definitions over three pages", async () => {
    const all = Array.from({ length: 250 }, (_, i) => node(i));
    const calls: Call[] = [];
    const found = await readDefinitions(
      admin((call) => {
        if (call.variables["ownerType"] !== "PRODUCT")
          return {
            metafieldDefinitions: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
        const start = Number(call.variables["after"] ?? 0);
        const end = start + DEFINITION_PAGE_SIZE;
        return {
          metafieldDefinitions: {
            nodes: all.slice(start, end),
            pageInfo: {
              hasNextPage: end < all.length,
              endCursor: String(end),
            },
          },
        };
      }, calls),
    );
    expect(found).toHaveLength(250);
    expect(found[0]).toMatchObject({
      ownerType: "PRODUCT",
      namespace: "recharge",
      key: "field_0",
      type: "single_line_text_field",
    });
    expect(
      calls.filter((c) => c.variables["ownerType"] === "PRODUCT"),
    ).toHaveLength(3);
    expect(
      calls.filter((c) => c.variables["ownerType"] === "PRODUCTVARIANT"),
    ).toHaveLength(1);
  });
});

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

const schema: AttributeSchema = {
  ...emptySchema(),
  attributes: [
    attribute("size", "Sail size", "decimal", "recharge.sail_size", {
      scope: "variant",
    }),
    attribute("skill", "Skill level", "single_select", "recharge.skill_level", {
      valueListId: "skill",
    }),
    attribute("year", "Model year", "integer", "recharge.model_year"),
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

describe("applyDefinitions", () => {
  it("sends one mutation per create row, with the recorded input", async () => {
    const plan = planDefinitions(schema, [
      {
        ownerType: "PRODUCTVARIANT",
        namespace: "recharge",
        key: "sail_size",
        type: "number_decimal",
      },
      {
        ownerType: "PRODUCT",
        namespace: "recharge",
        key: "model_year",
        type: "single_line_text_field",
      },
    ]);
    const calls: Call[] = [];
    const outcomes = await applyDefinitions(
      admin(
        () => ({
          metafieldDefinitionCreate: {
            createdDefinition: { id: "gid://shopify/MetafieldDefinition/9" },
            userErrors: [],
          },
        }),
        calls,
      ),
      plan,
    );
    // sail_size is unchanged, model_year is a conflict: only skill_level is created.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.variables).toEqual({
      definition: {
        ownerType: "PRODUCT",
        namespace: "recharge",
        key: "skill_level",
        name: "Skill level",
        type: "single_line_text_field",
        validations: [{ name: "choices", value: '["beginner","advanced"]' }],
      },
    });
    expect(outcomes).toEqual([{ attributeId: "skill", result: "created" }]);
  });

  it("sends storefront access only when the attribute asks for it", () => {
    const withAccess = planDefinitions(
      {
        ...emptySchema(),
        attributes: [
          attribute("a", "Open", "text", "recharge.open", { storefront: true }),
        ],
      },
      [],
    ).rows[0]?.draft;
    expect(withAccess && createInput(withAccess)).toMatchObject({
      access: { storefront: "PUBLIC_READ" },
    });
    const without = planDefinitions(schema, []).rows[0]?.draft;
    expect(without && createInput(without)).not.toHaveProperty("access");
  });

  it("treats TAKEN as an unchanged re-read and INVALID as that row's failure", async () => {
    const plan = planDefinitions(schema, []);
    const calls: Call[] = [];
    const outcomes = await applyDefinitions(
      admin((call) => {
        if (call.query.includes("OrchestratorPlanDefinitions"))
          return {
            metafieldDefinitions: {
              nodes: [
                {
                  ...node(1),
                  key: "sail_size",
                  type: { name: "number_decimal" },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
        const def = call.variables["definition"] as { key: string };
        if (def.key === "sail_size")
          return {
            metafieldDefinitionCreate: {
              createdDefinition: null,
              userErrors: [
                {
                  field: ["definition", "key"],
                  message: "Key is in use",
                  code: "TAKEN",
                },
              ],
            },
          };
        if (def.key === "skill_level")
          return {
            metafieldDefinitionCreate: {
              createdDefinition: null,
              userErrors: [
                {
                  field: ["definition", "validations"],
                  message: "Choices are not valid",
                  code: "INVALID",
                },
              ],
            },
          };
        return {
          metafieldDefinitionCreate: {
            createdDefinition: { id: "gid://shopify/MetafieldDefinition/2" },
            userErrors: [],
          },
        };
      }, calls),
      plan,
    );
    expect(outcomes).toEqual([
      { attributeId: "size", result: "unchanged" },
      {
        attributeId: "skill",
        result: "failed",
        message: "Choices are not valid",
      },
      { attributeId: "year", result: "created" },
    ]);
  });
});
