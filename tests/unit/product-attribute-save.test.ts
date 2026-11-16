import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceProduct } from "~/adapters/shopify/product-workspace";
import { emptySchema, type AttributeSchema } from "~/domain/attributes/types";

/**
 * Saving product setup values end to end (docs/attributes.md § On the
 * product page): what the page loads is what it sends back, and a save of
 * changed values writes those metafields and nothing else. Every adapter is
 * replaced; nothing reaches Shopify or a database.
 */

const writes = { metafields: vi.fn(), event: vi.fn(), product: vi.fn() };
let live: WorkspaceProduct;
let throwOnWrite: unknown = null;
let variantValues = new Map<
  string,
  Record<string, { type: string; value: string }>
>();

vi.mock("~/adapters/shopify/product-workspace", () => ({
  VARIANT_LIMIT: 100,
  readWorkspaceProduct: async () => live,
  readVariantInventory: async () => new Map(),
  readVariantMetafields: async () => variantValues,
  writeProduct: (...args: unknown[]) => {
    writes.product(...args);
    return Promise.resolve({ ok: true, errors: [] });
  },
  writeVariants: async () => ({ ok: true, errors: [] }),
  writeMetafields: (...args: unknown[]) => {
    if (throwOnWrite) return Promise.reject(throwOnWrite);
    writes.metafields(...args);
    return Promise.resolve({ ok: true, errors: [] });
  },
}));
vi.mock("~/adapters/shopify/products", () => ({
  listMetafieldDefinitions: async () => [],
}));
vi.mock("~/adapters/db/repositories/event-log.server", () => ({
  appendEvent: (...args: unknown[]) => {
    writes.event(...args);
    return Promise.resolve();
  },
}));
vi.mock("~/adapters/db/repositories/product-workspace.server", () => ({
  liveHolds: async () => new Map(),
  registryFor: async () => new Map(),
  saleRowsForProduct: async () => [],
  lastCatalogueRead: async () => null,
  trailForProduct: async () => [],
  translationWorkFor: async () => [],
}));
vi.mock("~/adapters/db/repositories/attribute-schema.server", () => ({
  getAttributeSchema: async () => ({
    schema: plan(),
    revision: 1,
    updatedAt: null,
  }),
}));
vi.mock("~/adapters/db/repositories/product-type-assignment.server", () => ({
  assignedTypeFor: async () => "t-boards",
  assignType: async () => undefined,
  clearAssignedType: async () => undefined,
}));
vi.mock("~/adapters/shopify/locales", () => ({
  listShopLocales: async () => ({ kind: "read", locales: [] }),
}));
vi.mock("~/adapters/shopify/translations", () => ({
  readTranslatableResourcesByIds: async () => [],
  isLocaleCode: () => true,
}));
vi.mock("~/adapters/db/repositories/catalogue.server", () => ({
  getCatalogueState: async () => ({
    currencyCode: "EUR",
    ianaTimezone: "Europe/Ljubljana",
  }),
}));
vi.mock("~/adapters/db/repositories/product-sync-setting.server", () => ({
  getProductSyncSetting: async () => ({
    enabled: false,
    namePolicy: "always",
    updatePricing: false,
    scheduleEnabled: false,
  }),
}));
vi.mock("~/adapters/db/repositories/translations.server", () => ({
  listLanguageSettings: async () => [],
  listOwnership: async () => new Map(),
}));
vi.mock("~/web/lib/locations.server", () => ({
  loadLocationRows: async () => ({ locations: [] }),
}));
vi.mock("~/web/lib/sources.server", () => ({ readPortal: async () => null }));
vi.mock("~/adapters/translations/engine.server", () => ({
  hashValue: (v: string) => v,
}));
vi.mock("~/adapters/translations/edits.server", () => ({
  saveTranslationEdits: async () => ({ ok: true, message: "" }),
  translateForPerson: async () => ({ ok: true, message: "" }),
}));

const { handleProductAction } =
  await import("~/web/lib/product-actions.server");
const { loadProductWorkspace } =
  await import("~/web/lib/product-workspace.server");

function plan(): AttributeSchema {
  const schema = emptySchema();
  schema.types = [
    {
      id: "t-boards",
      name: "Boards",
      parentId: null,
      leaf: true,
      sortOrder: 0,
      shopifyCategory: "",
      archetype: "",
    },
  ];
  schema.attributes = [
    {
      id: "a-sail",
      name: "Sail size",
      setId: null,
      dataType: "decimal",
      unit: "m2",
      description: "",
      scope: "variant",
      key: "recharge.sail_size",
      implementation: "custom",
      requiredDefault: true,
      filterable: false,
      searchable: false,
      comparable: false,
      valueListId: null,
    },
    {
      id: "a-length",
      name: "Length",
      setId: null,
      dataType: "measurement",
      unit: "cm",
      description: "",
      scope: "product",
      key: "recharge.length",
      implementation: "custom",
      requiredDefault: false,
      filterable: false,
      searchable: false,
      comparable: false,
      valueListId: null,
    },
  ];
  schema.attributeAssignments = [
    { id: "aa1", typeId: "t-boards", attributeId: "a-sail" },
    { id: "aa2", typeId: "t-boards", attributeId: "a-length" },
  ];
  return schema;
}

const admin = {} as AdminApiContext;
const principal = {
  kind: "shop" as const,
  shopDomain: "demo.myshopify.com",
  isErpAdmin: true,
};
const PRODUCT = "gid://shopify/Product/1";

function product(): WorkspaceProduct {
  const variant = (id: string, title: string) => ({
    variantId: id,
    title,
    sku: null,
    barcode: null,
    priceMinor: 134900,
    compareAtMinor: null,
    inventoryQuantity: 2,
    options: [{ name: "Size", value: title }],
  });
  return {
    productId: PRODUCT,
    legacyId: "1",
    title: "The Flow",
    handle: "the-flow",
    descriptionHtml: "<p>Glide.</p>",
    vendor: "Aeryn",
    productType: "Boards",
    status: "ACTIVE",
    tags: [],
    updatedAt: "2026-10-05T10:00:00Z",
    onlineStoreUrl: null,
    onlineStorePreviewUrl: null,
    hasOnlyDefaultVariant: false,
    seoTitle: "",
    seoDescription: "",
    category: null,
    collections: [],
    media: [],
    mediaCount: 0,
    metafields: {},
    options: ["Size"],
    variantsCount: 3,
    variants: [
      variant("gid://shopify/ProductVariant/1", "7'7 - 100L"),
      variant("gid://shopify/ProductVariant/2", "7'11 - 115L"),
      variant("gid://shopify/ProductVariant/3", "8'2 - 130L"),
    ],
  };
}

async function load() {
  const workspace = await loadProductWorkspace(admin, principal, PRODUCT);
  if (!workspace || workspace.setup.kind !== "matched")
    throw new Error(`setup is ${workspace?.setup.kind}`);
  return { workspace, setup: workspace.setup };
}

/** What the page posts: its whole form, as the route builds it. */
function save(
  workspace: Awaited<ReturnType<typeof load>>["workspace"],
  setup: Awaited<ReturnType<typeof load>>["setup"],
  inputs: Record<string, string | string[]>,
) {
  const data = new FormData();
  data.set("intent", "save");
  data.set(
    "form",
    JSON.stringify({
      pageRead: workspace.fields,
      fields: workspace.fields,
      variants: [],
      attributes: {
        typeId: setup.typeId,
        pageRead: setup.inputs,
        inputs: { ...setup.inputs, ...inputs },
      },
    }),
  );
  return handleProductAction({
    admin,
    principal,
    actor: "Merchant",
    productId: PRODUCT,
    formData: data,
  });
}

beforeEach(() => {
  for (const fn of Object.values(writes)) fn.mockClear();
  live = product();
  variantValues = new Map();
  throwOnWrite = null;
});

describe("saving product setup values", () => {
  it("writes each variant's value and nothing else", async () => {
    const { workspace, setup } = await load();
    const v1 = "gid://shopify/ProductVariant/1";
    const result = await save(workspace, setup, {
      [`a-sail@${v1}`]: "5.5",
      "a-length": "240",
    });
    expect(result).toEqual({ ok: true, message: "Saved 2 details." });
    expect(writes.product).not.toHaveBeenCalled();
    expect(writes.metafields).toHaveBeenCalledWith(
      admin,
      [
        {
          ownerId: v1,
          namespace: "recharge",
          key: "sail_size",
          type: "number_decimal",
          value: "5.5",
        },
        {
          ownerId: PRODUCT,
          namespace: "recharge",
          key: "length",
          type: "dimension",
          value: '{"value":240,"unit":"CENTIMETERS"}',
        },
      ],
      [],
    );
  });

  it("reads back what it wrote as unchanged, so the save bar can close", async () => {
    variantValues = new Map([
      [
        "gid://shopify/ProductVariant/1",
        { "recharge.sail_size": { type: "number_decimal", value: "5.5" } },
      ],
    ]);
    const { setup } = await load();
    expect(setup.inputs["a-sail@gid://shopify/ProductVariant/1"]).toBe("5.5");
  });

  it("answers with Shopify's words when the client throws", async () => {
    throwOnWrite = Object.assign(
      new Error("GraphQL Client: An error occurred"),
      {
        body: {
          errors: {
            graphQLErrors: [{ message: "Access denied for metafieldsSet" }],
          },
        },
      },
    );
    const { workspace, setup } = await load();
    const result = await save(workspace, setup, { "a-length": "240" });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Access denied for metafieldsSet\./);
  });
});
