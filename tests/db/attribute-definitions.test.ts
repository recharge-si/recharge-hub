import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { afterEach, expect, it } from "vitest";

import { prisma } from "~/adapters/db/client.server";
import { saveAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import {
  emptySchema,
  type Attribute,
  type AttributeSchema,
} from "~/domain/attributes/types";
import {
  createPlannedDefinitions,
  previewDefinitions,
} from "~/web/lib/definitions.server";

import {
  createTenant,
  describeDatabase,
  destroyTenant,
  type TestTenant,
} from "./harness";

/**
 * docs/attributes.md, Metafield definitions, against a real database: the
 * create logs one event per press with its counts, a second press creates
 * nothing, and one shop's run never reads or writes another shop's plan.
 */

function attribute(id: string, name: string, key: string): Attribute {
  return {
    id,
    name,
    setId: null,
    dataType: "text",
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
  };
}

const planFor = (...keys: string[]): AttributeSchema => ({
  ...emptySchema(),
  attributes: keys.map((key, i) =>
    attribute(`a${i}`, `Field ${key}`, `recharge.${key}`),
  ),
});

/** A Shopify that remembers the definitions it was asked to create. */
function shopify(): { admin: AdminApiContext; created: string[] } {
  const created: string[] = [];
  const admin = {
    graphql: async (
      query: string,
      options?: { variables?: Record<string, unknown> },
    ) => {
      const variables = options?.variables ?? {};
      if (query.includes("OrchestratorPlanDefinitionCreate")) {
        const def = variables["definition"] as { key: string };
        created.push(def.key);
        return {
          json: async () => ({
            data: {
              metafieldDefinitionCreate: {
                createdDefinition: {
                  id: `gid://shopify/MetafieldDefinition/${created.length}`,
                },
                userErrors: [],
              },
            },
          }),
        };
      }
      const nodes =
        variables["ownerType"] === "PRODUCT"
          ? created.map((key, i) => ({
              id: `gid://shopify/MetafieldDefinition/${i + 1}`,
              namespace: "recharge",
              key,
              name: key,
              type: { name: "single_line_text_field" },
            }))
          : [];
      return {
        json: async () => ({
          data: {
            metafieldDefinitions: {
              nodes,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      };
    },
  } as unknown as AdminApiContext;
  return { admin, created };
}

describeDatabase("metafield definitions", () => {
  const tenants: TestTenant[] = [];
  afterEach(async () => {
    for (const tenant of tenants.splice(0)) await destroyTenant(tenant);
  });

  async function events(tenant: TestTenant) {
    return prisma.eventLog.findMany({
      where: {
        shopId: tenant.shopId,
        event: "attribute_schema.definitions_created",
      },
      orderBy: { createdAt: "asc" },
      select: { detail: true },
    });
  }

  it("logs {created: n} and then {created: 0} when pressed twice", async () => {
    const tenant = await createTenant("defs-twice");
    tenants.push(tenant);
    await saveAttributeSchema(
      tenant.principal,
      planFor("one", "two", "three"),
      0,
    );
    const store = shopify();

    const first = await createPlannedDefinitions(
      store.admin,
      tenant.principal,
      "me",
    );
    const second = await createPlannedDefinitions(
      store.admin,
      tenant.principal,
      "me",
    );

    expect(first.created).toHaveLength(3);
    expect(second.created).toHaveLength(0);
    expect(store.created).toEqual(["one", "two", "three"]);
    const logged = await events(tenant);
    expect(
      logged.map((e) => (e.detail as { created: number }).created),
    ).toEqual([3, 0]);
  });

  it("never reads or writes another shop's plan", async () => {
    const a = await createTenant("defs-a");
    const b = await createTenant("defs-b");
    tenants.push(a, b);
    await saveAttributeSchema(a.principal, planFor("only_a"), 0);
    await saveAttributeSchema(b.principal, planFor("only_b1", "only_b2"), 0);

    const storeA = shopify();
    const run = await createPlannedDefinitions(storeA.admin, a.principal, null);

    expect(storeA.created).toEqual(["only_a"]);
    expect(run.created).toHaveLength(1);
    expect(await events(a)).toHaveLength(1);
    expect(await events(b)).toHaveLength(0);

    const previewB = await previewDefinitions(shopify().admin, b.principal);
    expect(previewB.counts.create).toBe(2);
  });
});
