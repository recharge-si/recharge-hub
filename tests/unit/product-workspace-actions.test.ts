import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceProduct } from "~/adapters/shopify/product-workspace";
import type * as ShopifyTranslations from "~/adapters/shopify/translations";

/**
 * The product workspace's server side (docs/architecture.md § Product
 * workspace): the action writes only what a person asked for and refuses
 * what it must, and the loader writes nothing and survives a section that
 * cannot be read. Every adapter is replaced; nothing reaches Shopify,
 * MetaKocka or a database.
 */

const writes = {
  product: vi.fn(),
  variants: vi.fn(),
  event: vi.fn(),
  saveTranslation: vi.fn(),
  translate: vi.fn(),
};
let live: WorkspaceProduct | null = null;
let holds = new Map<
  string,
  { campaignId: string; campaignName: string; state: string }
>();
let failInventory = false;

vi.mock("~/adapters/shopify/product-workspace", () => ({
  VARIANT_LIMIT: 100,
  readWorkspaceProduct: async () => live,
  readVariantInventory: async () => {
    if (failInventory) throw new Error("Throttled");
    return new Map([
      [
        "v1",
        {
          variantId: "v1",
          tracked: true,
          levels: [
            {
              locationId: "loc1",
              locationName: "Ljubljana",
              available: 3,
              onHand: 4,
            },
          ],
        },
      ],
    ]);
  },
  readVariantMetafields: async () => new Map(),
  writeProduct: (...args: unknown[]) => {
    writes.product(...args);
    return Promise.resolve({ ok: true, errors: [] });
  },
  writeVariants: (...args: unknown[]) => {
    writes.variants(...args);
    return Promise.resolve({ ok: true, errors: [] });
  },
}));

vi.mock("~/adapters/db/repositories/event-log.server", () => ({
  appendEvent: (...args: unknown[]) => {
    writes.event(...args);
    return Promise.resolve();
  },
}));

vi.mock("~/adapters/db/repositories/product-workspace.server", () => ({
  liveHolds: async () => holds,
  registryFor: async () =>
    new Map([
      [
        "25PFW95",
        {
          sku: "25PFW95",
          status: "matched",
          metakockaCode: "25PFW95",
          metakockaName: "F-Wave 95",
          updatedAt: new Date(),
        },
      ],
    ]),
  saleRowsForProduct: async () => [],
  lastCatalogueRead: async () => null,
  trailForProduct: async () => [
    {
      id: "e1",
      at: new Date("2026-09-28T10:00:00Z"),
      entityType: "product",
      entityId: "gid://shopify/Product/1",
      event: "product.review_approved",
      detail: {},
    },
  ],
  translationWorkFor: async () => [],
}));

vi.mock("~/adapters/translations/edits.server", () => ({
  saveTranslationEdits: (...args: unknown[]) => {
    writes.saveTranslation(...args);
    return Promise.resolve({ ok: true, message: "Saved" });
  },
  translateForPerson: (...args: unknown[]) => {
    writes.translate(...args);
    return Promise.resolve({ ok: true, message: "Translated" });
  },
}));

vi.mock("~/adapters/shopify/locales", () => ({
  listShopLocales: async () => ({
    kind: "read",
    locales: [
      {
        locale: "sl",
        name: "Slovenian",
        primary: true,
        published: true,
        webPresences: [],
      },
      {
        locale: "de",
        name: "German",
        primary: false,
        published: true,
        webPresences: [],
      },
    ],
  }),
}));

vi.mock("~/adapters/shopify/translations", async (importOriginal) => ({
  ...(await importOriginal<typeof ShopifyTranslations>()),
  readTranslatableResourcesByIds: async () => [
    {
      resourceId: "gid://shopify/Product/1",
      sourceLocale: "sl",
      fields: [{ key: "title", value: "Deska", digest: "d1", type: "STRING" }],
      translations: new Map([["de", []]]),
    },
  ],
}));

vi.mock("~/adapters/db/repositories/attribute-schema.server", () => ({
  getAttributeSchema: async () => {
    throw new Error("unreadable");
  },
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
  loadLocationRows: async () => ({
    locations: [
      {
        id: "loc1",
        name: "Ljubljana",
        fulfillmentServiceName: null,
        sourceId: "src",
        direction: "mk_to_shopify",
        warehouseName: "Glavno",
        status: "syncing",
        syncMessage: null,
      },
    ],
  }),
}));
vi.mock("~/web/lib/sources.server", () => ({ readPortal: async () => null }));
vi.mock("~/adapters/translations/engine.server", () => ({
  hashValue: (v: string) => v,
}));

const { handleProductAction } =
  await import("~/web/lib/product-actions.server");
const { loadProductWorkspace } =
  await import("~/web/lib/product-workspace.server");

const admin = {} as AdminApiContext;
const principal = {
  kind: "shop" as const,
  shopDomain: "demo.myshopify.com",
  isErpAdmin: true,
};

function product(overrides: Partial<WorkspaceProduct> = {}): WorkspaceProduct {
  return {
    productId: "gid://shopify/Product/1",
    legacyId: "1",
    title: "Patrik F-Wave 95",
    handle: "patrik-f-wave-95",
    descriptionHtml: "<p>Fast.</p>",
    vendor: "Patrik",
    productType: "Wave",
    status: "ACTIVE",
    tags: ["wave", "portal-source:src_1"],
    updatedAt: "2026-09-28T10:00:00Z",
    onlineStoreUrl: null,
    onlineStorePreviewUrl: null,
    hasOnlyDefaultVariant: true,
    seoTitle: "",
    seoDescription: "",
    category: null,
    collections: [],
    media: [],
    mediaCount: 0,
    metafields: {},
    options: [],
    variantsCount: 1,
    variants: [
      {
        variantId: "v1",
        title: "Default Title",
        sku: "25PFW95",
        barcode: null,
        priceMinor: 219900,
        compareAtMinor: null,
        inventoryQuantity: 4,
        options: [],
      },
    ],
    ...overrides,
  };
}

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

const pageRead = {
  title: "Patrik F-Wave 95",
  descriptionHtml: "<p>Fast.</p>",
  vendor: "Patrik",
  productType: "Wave",
  status: "ACTIVE",
  tags: ["wave", "portal-source:src_1"],
  seoTitle: "",
  seoDescription: "",
};
const was = {
  variantId: "v1",
  priceMinor: 219900,
  compareAtMinor: null,
  sku: "25PFW95",
  barcode: null,
};

function save(body: {
  fields?: Partial<typeof pageRead>;
  variants?: unknown[];
}) {
  return handleProductAction({
    admin,
    principal,
    actor: "Merchant",
    productId: "gid://shopify/Product/1",
    formData: form({
      intent: "save",
      form: JSON.stringify({
        pageRead,
        fields: { ...pageRead, ...body.fields },
        variants: body.variants ?? [],
      }),
    }),
  });
}

beforeEach(() => {
  for (const fn of Object.values(writes)) fn.mockClear();
  live = product();
  holds = new Map();
  failInventory = false;
});

describe("saving the product", () => {
  it("writes only the changed fields, keeps the portal's tags, and audits the field names", async () => {
    const result = await save({
      fields: { title: "F-Wave 95 2026", tags: ["freestyle"] },
    });
    expect(result.ok).toBe(true);
    expect(writes.product).toHaveBeenCalledWith(
      admin,
      "gid://shopify/Product/1",
      { title: "F-Wave 95 2026" },
      { add: ["freestyle"], remove: ["wave"] },
    );
    expect(writes.variants).not.toHaveBeenCalled();
    expect(writes.event).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({
        event: "product.edited",
        detail: { fields: ["title", "tags"], by: "Merchant" },
      }),
    );
  });

  it("rejects invalid input without writing anything", async () => {
    const result = await save({ fields: { title: " " } });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.fieldErrors?.title).toMatch(/Enter a title/);
    expect(writes.product).not.toHaveBeenCalled();
  });

  it("refuses to overwrite a field that changed in Shopify since the page read it", async () => {
    live = product({ title: "Renamed in the admin" });
    const result = await save({ fields: { title: "Mine" } });
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toMatch(/title changed in Shopify/);
    expect(writes.product).not.toHaveBeenCalled();
  });

  it("never changes a price a live campaign holds, whatever the form sent", async () => {
    holds = new Map([
      [
        "v1",
        { campaignId: "c1", campaignName: "Summer Sale", state: "applied" },
      ],
    ]);
    const result = await save({
      variants: [
        {
          variantId: "v1",
          price: "1999.00",
          compareAt: "",
          sku: "25PFW95",
          barcode: "",
          was,
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.variantErrors?.v1?.price).toMatch(
      /Summer Sale/,
    );
    expect(writes.variants).not.toHaveBeenCalled();
  });

  it("writes a variant price no campaign holds", async () => {
    const result = await save({
      variants: [
        {
          variantId: "v1",
          price: "1999",
          compareAt: "2199",
          sku: "25PFW95",
          barcode: "",
          was,
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(writes.variants).toHaveBeenCalledWith(
      admin,
      "gid://shopify/Product/1",
      [{ variantId: "v1", priceMinor: 199900, compareAtMinor: 219900 }],
    );
  });
});

describe("translations from the product page", () => {
  it("saves a person's edit through the shared path that records it as theirs", async () => {
    const result = await handleProductAction({
      admin,
      principal,
      actor: "Merchant",
      productId: "gid://shopify/Product/1",
      formData: form({
        intent: "save-translation",
        form: JSON.stringify({
          locale: "de",
          fields: [{ key: "title", value: "Brett", digest: "d1" }],
        }),
      }),
    });
    expect(result.ok).toBe(true);
    expect(writes.saveTranslation).toHaveBeenCalledWith(principal, admin, {
      resource: "gid://shopify/Product/1",
      type: "PRODUCT",
      locale: "de",
      fields: [{ key: "title", value: "Brett", digest: "d1" }],
      actor: "Merchant",
    });
  });

  it("will not write a translation into the store's own language", async () => {
    const result = await handleProductAction({
      admin,
      principal,
      actor: null,
      productId: "gid://shopify/Product/1",
      formData: form({
        intent: "save-translation",
        form: JSON.stringify({
          locale: "sl",
          fields: [{ key: "title", value: "x", digest: "d1" }],
        }),
      }),
    });
    expect(result.ok).toBe(false);
    expect(writes.saveTranslation).not.toHaveBeenCalled();
  });

  it("translates through the engine, never a mode that overrides protection", async () => {
    await handleProductAction({
      admin,
      principal,
      actor: null,
      productId: "gid://shopify/Product/1",
      formData: form({ intent: "translate", locales: "de", mode: "force" }),
    });
    expect(writes.translate).not.toHaveBeenCalled();
  });
});

describe("opening the product", () => {
  it("reads everything it shows and writes nothing", async () => {
    const workspace = await loadProductWorkspace(
      admin,
      principal,
      "gid://shopify/Product/1",
    );
    expect(workspace).not.toBeNull();
    expect(
      Object.values(writes).every((fn) => fn.mock.calls.length === 0),
    ).toBe(true);

    expect(workspace?.variants[0]?.match?.status).toBe("matched");
    expect(workspace?.stock).toMatchObject({
      ok: true,
      locations: [
        {
          id: "loc1",
          writer: { kind: "metakocka", warehouse: "Glavno", paused: false },
        },
      ],
    });
    expect(workspace?.translations).toMatchObject({
      ok: true,
      languages: [{ locale: "de", missing: 1 }],
    });
    expect(workspace?.issues.map((i) => i.key)).toEqual(["translation-German"]);
    expect(workspace?.activity[0]?.text).toBe("Approved and published.");
    // A source is named by its tag even when the portal could not be asked.
    expect(workspace?.source).toMatchObject({ id: "src_1", read: false });
  });

  it("stands when a section cannot be read", async () => {
    failInventory = true;
    const workspace = await loadProductWorkspace(
      admin,
      principal,
      "gid://shopify/Product/1",
    );
    expect(workspace?.stock).toMatchObject({ ok: false });
    expect(workspace?.setup).toMatchObject({ kind: "unavailable" });
    expect(workspace?.product.title).toBe("Patrik F-Wave 95");
  });

  it("is not found when Shopify has no such product", async () => {
    live = null;
    expect(
      await loadProductWorkspace(admin, principal, "gid://shopify/Product/9"),
    ).toBeNull();
  });
});
