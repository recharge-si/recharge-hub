import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { starterSchema } from "~/domain/attributes/starter";
import type { AttributeField } from "~/domain/products/attribute-values";
import { serviceToken } from "~/domain/types";

/**
 * docs/attributes.md § AI autofill, the service: a product with a type
 * keeps it and only its empty attributes are asked for; one without is
 * categorized first; failures land on the product; applying goes through
 * the same paths a person's edits do, and only for the type the values
 * were suggested for.
 */

const state = vi.hoisted(() => ({
  saved: new Map<string, unknown>(),
  failed: new Map<string, string>(),
  chosen: new Map<string, { typeId: string; chosenBy: string | null }>(),
  categorizeCalls: [] as unknown[],
  extractCalls: [] as unknown[],
  categorizeAnswer: [] as Array<{
    code: string;
    categoryId: string | null;
    confidence: number | null;
    reason: string | null;
  }>,
  extractAnswer: [] as Array<{
    attributeId: string;
    variantId: string | null;
    value: string | string[];
  }>,
  portalOk: true,
  /** When set, the plan is padded to exactly this many assignable types. */
  assignable: null as number | null,
  /** When set, this many attributes are missing on every product. */
  attributeCount: null as number | null,
  categorizeFails: null as Error | null,
  autofill: null as unknown,
  typeChoices: [] as unknown[],
  writes: [] as unknown[],
  decided: [] as string[],
  inputs: {} as Record<string, string>,
}));

vi.mock("~/adapters/db/repositories/attribute-schema.server", () => ({
  getAttributeSchema: async () => {
    const schema = starterSchema();
    if (state.assignable !== null) {
      const have = schema.types.filter((t) => t.leaf).length;
      for (let i = have; i < state.assignable; i++)
        schema.types.push({
          id: `extra-${i}`,
          name: `Extra ${i}`,
          parentId: null,
          leaf: true,
          sortOrder: i,
          shopifyCategory: "",
          archetype: "",
        });
    }
    return { schema, revision: 1 };
  },
}));
vi.mock("~/adapters/db/repositories/event-log.server", () => ({
  appendEvent: async () => undefined,
}));
vi.mock("~/adapters/db/repositories/product-autofill.server", () => ({
  markAutofillRunning: async () => undefined,
  queueAutofills: async (_p: unknown, ids: string[]) => ids,
  saveAutofillSuggestion: async (_p: unknown, id: string, s: unknown) => {
    state.saved.set(id, s);
  },
  failAutofill: async (_p: unknown, id: string, message: string) => {
    state.failed.set(id, message);
  },
  // A suggestion just saved is what an automatic apply reads back.
  getAutofill: async (_p: unknown, id: string) =>
    state.autofill ??
    (state.saved.has(id)
      ? { status: "ready", ...(state.saved.get(id) as object) }
      : null),
  decideAutofill: async (_p: unknown, _id: string, status: string) => {
    state.decided.push(status);
    return true;
  },
}));
vi.mock("~/adapters/db/repositories/product-type-assignment.server", () => ({
  assignmentsFor: async () => state.chosen,
}));
vi.mock("~/adapters/export-portal/service.server", () => ({
  portalFor: async () =>
    state.portalOk
      ? {
          ok: true,
          client: {
            categorize: async (input: unknown) => {
              state.categorizeCalls.push(input);
              if (state.categorizeFails) throw state.categorizeFails;
              return state.categorizeAnswer;
            },
            extractAttributes: async (input: unknown) => {
              state.extractCalls.push(input);
              return state.extractAnswer;
            },
          },
        }
      : { ok: false, reason: "not_connected", message: "Connect the export portal first." },
}));

const FIELDS: AttributeField[] = [
  {
    attributeId: "brand",
    name: "Brand",
    description: "",
    required: true,
    scope: "product",
    dataType: "text",
    group: null,
    namespace: "recharge",
    key: "brand",
    edit: {
      kind: "text",
      shopifyType: "single_line_text_field",
      unit: "",
      measurementUnit: null,
      options: [],
    },
  },
];
vi.mock("~/adapters/products/attribute-values.server", () => ({
  readAttributeValues: async () => ({
    fields:
      state.attributeCount === null
        ? FIELDS
        : Array.from({ length: state.attributeCount }, (_, i) => ({
            ...FIELDS[0]!,
            attributeId: `a${i}`,
            name: `Attribute ${i}`,
            key: `a${i}`,
          })),
    inputs: state.inputs,
    variantMetafields: [],
    variantDetailsRead: true,
  }),
}));
vi.mock("~/adapters/products/type-choice.server", () => ({
  chooseProductType: async (
    _a: unknown,
    _p: unknown,
    input: { productId: string; typeId: string; chosenBy: string | null },
  ) => {
    state.typeChoices.push(input);
    // Chosen is what the product has from then on.
    state.chosen.set(input.productId, {
      typeId: input.typeId,
      chosenBy: input.chosenBy,
    });
  },
}));
vi.mock("~/adapters/queue/boss.server", () => ({ enqueue: async () => "job" }));

function product(id: string, productType = "") {
  return {
    productId: id,
    title: `Product ${id}`,
    descriptionHtml: "<p>A wave sail.</p>",
    vendor: "Point-7",
    productType,
    tags: [],
    category: null,
    hasOnlyDefaultVariant: true,
    options: [],
    variants: [{ variantId: `${id}-v`, title: "Default", sku: null, options: [] }],
    metafields: {},
  };
}
vi.mock("~/adapters/shopify/product-workspace", () => ({
  readWorkspaceProduct: async (_a: unknown, id: string) =>
    id === "gone" ? null : product(id, id === "typed" ? "Wave sails" : ""),
  writeMetafields: async (_a: unknown, writes: unknown[]) => {
    state.writes.push(...writes);
    return { ok: true, errors: [] };
  },
}));

const { applyAutofill, suggestAutofill } = await import(
  "~/adapters/products/autofill.server"
);
const { ExportPortalError } = await import("~/adapters/export-portal/errors");

const admin = {} as AdminApiContext;
const principal = serviceToken("shop.myshopify.com", "test");

beforeEach(() => {
  state.saved.clear();
  state.failed.clear();
  state.chosen.clear();
  state.categorizeCalls = [];
  state.extractCalls = [];
  state.categorizeAnswer = [];
  state.extractAnswer = [];
  state.portalOk = true;
  state.assignable = null;
  state.attributeCount = null;
  state.categorizeFails = null;
  state.autofill = null;
  state.typeChoices = [];
  state.writes = [];
  state.decided = [];
  state.inputs = {};
});

describe("suggesting", () => {
  it("categorizes against the plan's assignable types, then asks for the empty attributes", async () => {
    state.categorizeAnswer = [
      { code: "p1", categoryId: "wave", confidence: 0.9, reason: "By name." },
    ];
    state.extractAnswer = [
      { attributeId: "brand", variantId: null, value: "Point-7" },
    ];
    await suggestAutofill(admin, principal, ["p1"]);

    const sent = state.categorizeCalls[0] as {
      categories: Array<{ id: string; label: string }>;
    };
    expect(sent.categories).toContainEqual({
      id: "wave",
      label: "All products > Windsurf > Sails > Wave sails",
    });
    expect(sent.categories.some((c) => c.id === "windsurf")).toBe(false);
    expect(state.saved.get("p1")).toMatchObject({
      typeId: "wave",
      typeOrigin: "suggested",
      typeConfidence: 0.9,
      values: [{ key: "brand", input: "Point-7" }],
      engine: "export-portal",
    });
  });

  it("keeps a type the product already has and does not categorize it", async () => {
    await suggestAutofill(admin, principal, ["typed"]);
    expect(state.categorizeCalls).toEqual([]);
    expect(state.saved.get("typed")).toMatchObject({
      typeId: "wave",
      typeOrigin: "kept",
    });
  });

  it("asks nothing when every attribute is filled", async () => {
    state.inputs = { brand: "Point-7" };
    await suggestAutofill(admin, principal, ["typed"]);
    expect(state.extractCalls).toEqual([]);
    expect(state.saved.get("typed")).toMatchObject({ values: [] });
  });

  it("saves 'no type fits' when the categorizer names none", async () => {
    state.categorizeAnswer = [
      { code: "p1", categoryId: "invented", confidence: 0.99, reason: "x" },
    ];
    await suggestAutofill(admin, principal, ["p1"]);
    expect(state.saved.get("p1")).toMatchObject({
      typeId: null,
      typeConfidence: null,
      values: [],
    });
    expect(state.extractCalls).toEqual([]);
  });

  it("records failures on the products they concern", async () => {
    state.categorizeFails = new ExportPortalError({
      kind: "server",
      path: "/ai/categorize",
      httpStatus: 503,
      message: "AI is not configured on the export portal.",
    });
    await suggestAutofill(admin, principal, ["p1", "gone", "typed"]);
    expect(state.failed.get("p1")).toBe(
      "AI is not configured on the export portal.",
    );
    expect(state.failed.get("gone")).toMatch(/could not be read/);
    expect(state.saved.has("typed")).toBe(true);
  });

  it("fails every product when the portal is not connected", async () => {
    state.portalOk = false;
    await suggestAutofill(admin, principal, ["p1", "p2"]);
    expect([...state.failed.values()]).toEqual([
      "Connect the export portal first.",
      "Connect the export portal first.",
    ]);
  });
});

describe("the portal's request limits", () => {
  it("does not call the portal with 2001 assignable types, and says so on each product", async () => {
    state.assignable = 2001;
    await suggestAutofill(admin, principal, ["p1", "p2"]);
    expect(state.categorizeCalls).toEqual([]);
    const message =
      "The product type list has 2001 entries; the AI can read at most 2000.";
    expect(state.failed.get("p1")).toBe(message);
    expect(state.failed.get("p2")).toBe(message);
    expect(state.saved.size).toBe(0);
  });

  it("still keeps the type of a product that has one when the list is too long", async () => {
    state.assignable = 2001;
    await suggestAutofill(admin, principal, ["typed"]);
    expect(state.failed.size).toBe(0);
    expect(state.saved.get("typed")).toMatchObject({ typeOrigin: "kept" });
  });

  it("calls the portal with exactly 2000 types", async () => {
    state.assignable = 2000;
    await suggestAutofill(admin, principal, ["p1"]);
    const sent = state.categorizeCalls[0] as { categories: unknown[] };
    expect(sent.categories).toHaveLength(2000);
    expect(state.failed.size).toBe(0);
  });

  it("does not call the portal for 201 attributes, and names the limit", async () => {
    state.attributeCount = 201;
    await suggestAutofill(admin, principal, ["typed"]);
    expect(state.extractCalls).toEqual([]);
    expect(state.failed.get("typed")).toBe(
      "This product has 201 attributes to fill; the AI can read at most 200.",
    );
    expect(state.saved.has("typed")).toBe(false);
  });

  it("calls the portal with exactly 200 attributes", async () => {
    state.attributeCount = 200;
    await suggestAutofill(admin, principal, ["typed"]);
    const sent = state.extractCalls[0] as { attributes: unknown[] };
    expect(sent.attributes).toHaveLength(200);
    expect(state.failed.size).toBe(0);
  });
});

describe("applying on its own, for a source set to", () => {
  const confident = (confidence: number) => {
    state.categorizeAnswer = [
      { code: "p1", categoryId: "wave", confidence, reason: "By name." },
    ];
    state.extractAnswer = [
      { attributeId: "brand", variantId: null, value: "Point-7" },
    ];
  };

  it("applies a confident suggestion at once, as the source", async () => {
    confident(0.9);
    await suggestAutofill(admin, principal, ["p1"], {
      fillAttributes: true,
      autoApply: true,
      requestedBy: "source:sc_1",
    });
    expect(state.typeChoices).toEqual([
      expect.objectContaining({ typeId: "wave", chosenBy: "source:sc_1" }),
    ]);
    expect(state.writes).toHaveLength(1);
    expect(state.decided).toEqual(["applied"]);
  });

  it("leaves a suggestion it is not sure of for review", async () => {
    confident(0.5);
    await suggestAutofill(admin, principal, ["p1"], {
      fillAttributes: true,
      autoApply: true,
      requestedBy: "source:sc_1",
    });
    expect(state.saved.get("p1")).toMatchObject({ typeId: "wave" });
    expect(state.typeChoices).toEqual([]);
    expect(state.decided).toEqual([]);
  });

  it("applies nothing for a source that waits for review", async () => {
    confident(0.99);
    await suggestAutofill(admin, principal, ["p1"], { fillAttributes: true });
    expect(state.typeChoices).toEqual([]);
    expect(state.decided).toEqual([]);
  });
});

describe("applying", () => {
  const ready = {
    status: "ready",
    typeId: "wave",
    typeOrigin: "suggested",
    typeConfidence: 0.9,
    typeReason: null,
    values: [
      {
        key: "brand",
        attributeId: "brand",
        variantId: null,
        name: "Brand",
        input: "Point-7",
        display: "Point-7",
      },
    ],
    engine: "export-portal",
    error: null,
  };

  it("chooses the type, then fills the kept values for it", async () => {
    state.autofill = ready;
    // After the type is chosen, the product has it.
    state.chosen.set("p1", { typeId: "wave", chosenBy: "staff" });
    const outcome = await applyAutofill(admin, principal, {
      productId: "p1",
      actor: "staff",
      keepType: true,
      keepValues: null,
    });
    expect(state.typeChoices).toEqual([
      expect.objectContaining({ productId: "p1", typeId: "wave", chosenBy: "staff" }),
    ]);
    expect(state.writes).toEqual([
      expect.objectContaining({ ownerId: "p1", key: "brand", value: "Point-7" }),
    ]);
    expect(state.decided).toEqual(["applied"]);
    expect(outcome).toEqual({ ok: true, message: "Applied: type set, 1 value filled." });
  });

  it("writes no values for a type the product does not have", async () => {
    state.autofill = ready;
    const outcome = await applyAutofill(admin, principal, {
      productId: "p1",
      actor: "staff",
      keepType: false,
      keepValues: null,
    });
    expect(state.typeChoices).toEqual([]);
    expect(state.writes).toEqual([]);
    expect(outcome.message).toMatch(/another product type/);
  });

  it("refuses a suggestion that is not waiting", async () => {
    state.autofill = { ...ready, status: "applied" };
    const outcome = await applyAutofill(admin, principal, {
      productId: "p1",
      actor: null,
      keepType: true,
      keepValues: null,
    });
    expect(outcome.ok).toBe(false);
    expect(state.decided).toEqual([]);
  });
});
