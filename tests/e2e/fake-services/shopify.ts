import { z } from "zod";

import { shopState, type ShopifyStore } from "./state";

/**
 * Fake Admin GraphQL, dispatched on the operation name.
 *
 * Every query in src/adapters/shopify is named, and the name is the contract
 * here: a handler gets the shop's store and the variables and returns `data`.
 * An operation with no handler is recorded and answered with an error, which
 * the e2e Shopify module throws like the real client does.
 */

type Variables = Record<string, unknown>;
type Handler = (store: ShopifyStore, variables: Variables) => unknown;

const EMPTY_PAGE = { hasNextPage: false, endCursor: null };

/** Every variant with its product, the way most catalogue queries see them. */
function variantsOf(store: ShopifyStore) {
  return store.products.flatMap((product) =>
    product.variants.map((variant) => ({ product, variant })),
  );
}

/** `gid://shopify/ProductVariant/7` -> `gid://shopify/InventoryItem/7`. */
function inventoryItemId(variantId: string): string {
  return variantId.replace("/ProductVariant/", "/InventoryItem/");
}

const setQuantitiesSchema = z.object({
  input: z.object({
    name: z.literal("on_hand"),
    quantities: z.array(
      z.object({
        inventoryItemId: z.string(),
        locationId: z.string(),
        quantity: z.number().int(),
        changeFromQuantity: z.number().int().nullable().optional(),
      }),
    ),
  }),
});

const writeVariantPricesSchema = z.object({
  productId: z.string(),
  variants: z.array(
    z.object({
      id: z.string(),
      price: z.string(),
      compareAtPrice: z.string().nullable(),
    }),
  ),
});

const MARKET = {
  id: "gid://shopify/Market/1",
  name: "Slovenia",
  handle: "si",
  status: "ACTIVE",
};

/** One web presence, the store's own domain, carrying every locale. */
function webPresence(store: ShopifyStore) {
  const primary =
    store.locales.find((locale) => locale.primary) ?? store.locales[0];
  return {
    id: "gid://shopify/MarketWebPresence/1",
    defaultLocale: { locale: primary?.locale ?? "en" },
    alternateLocales: store.locales
      .filter((locale) => locale !== primary)
      .map((locale) => ({ locale: locale.locale })),
    domain: { host: "e2e-store.example" },
    subfolderSuffix: null,
  };
}

/** What Shopify offers in the Add language picker; enough for a picker. */
const AVAILABLE_LOCALES = [
  { isoCode: "de", name: "German" },
  { isoCode: "en", name: "English" },
  { isoCode: "hr", name: "Croatian" },
  { isoCode: "it", name: "Italian" },
  { isoCode: "sl", name: "Slovenian" },
];

const planDefinitionsSchema = z.object({
  ownerType: z.enum(["PRODUCT", "PRODUCTVARIANT"]),
  first: z.number().int().positive(),
  after: z.string().nullable().optional(),
  namespace: z.string().nullable().optional(),
  key: z.string().nullable().optional(),
});

const createDefinitionSchema = z.object({
  definition: z.object({
    ownerType: z.enum(["PRODUCT", "PRODUCTVARIANT"]),
    namespace: z.string(),
    key: z.string(),
    name: z.string(),
    type: z.string(),
  }),
});

const metafieldWriteSchema = z.object({
  ownerId: z.string(),
  namespace: z.string(),
  key: z.string(),
  type: z.string(),
  value: z.string(),
});

/** A product or variant of the store by its id, with the kind it is. */
function ownerOf(store: ShopifyStore, id: string) {
  const product = store.products.find((p) => p.id === id);
  if (product)
    return { ownerType: "PRODUCT" as const, metafields: product.metafields };
  const variant = variantsOf(store).find((e) => e.variant.id === id)?.variant;
  return variant
    ? { ownerType: "PRODUCTVARIANT" as const, metafields: variant.metafields }
    : null;
}

function metafieldNodesOf(
  map: Record<string, { type: string; value: string }>,
) {
  return Object.entries(map).map(([name, entry]) => {
    const dot = name.indexOf(".");
    return {
      namespace: name.slice(0, dot),
      key: name.slice(dot + 1),
      type: entry.type,
      value: entry.value,
    };
  });
}

const handlers: Record<string, Handler> = {
  OrchestratorLocations: (store) => ({
    locations: {
      nodes: store.locations.map((location) => ({
        id: location.id,
        name: location.name,
        isActive: location.isActive,
        fulfillmentService: null,
        address: { city: "Ljubljana", country: "Slovenia" },
      })),
    },
  }),

  // No orders in the fake store yet, so no gateway has been used.
  OrchestratorPaymentGateways: () => ({ orders: { nodes: [] } }),
  OrchestratorOrdersSince: () => ({
    orders: { pageInfo: EMPTY_PAGE, nodes: [] },
  }),

  OrchestratorOnHand: (store, variables) => {
    const locationId = String(variables.locationId);
    if (!store.locations.some((location) => location.id === locationId)) {
      return { location: null };
    }
    return {
      location: {
        inventoryLevels: {
          pageInfo: EMPTY_PAGE,
          nodes: variantsOf(store).flatMap(({ variant }) => {
            const quantity = variant.inventory[locationId];
            return quantity === undefined
              ? []
              : [
                  {
                    item: { id: inventoryItemId(variant.id) },
                    quantities: [{ name: "on_hand", quantity }],
                  },
                ];
          }),
        },
      },
    };
  },

  // Compare-and-set like Shopify: a stale `changeFromQuantity` is a user error
  // and nothing in the batch is written.
  OrchestratorSetOnHand: (store, variables) => {
    const { input } = setQuantitiesSchema.parse(variables);
    const byItem = new Map(
      variantsOf(store).map(({ variant }) => [
        inventoryItemId(variant.id),
        variant,
      ]),
    );
    const userErrors = input.quantities.flatMap((write) => {
      const variant = byItem.get(write.inventoryItemId);
      if (!variant)
        return [
          {
            field: ["input"],
            message: `Unknown item ${write.inventoryItemId}`,
          },
        ];
      const current = variant.inventory[write.locationId] ?? 0;
      return write.changeFromQuantity != null &&
        write.changeFromQuantity !== current
        ? [{ field: ["input"], message: "The compare quantity is stale." }]
        : [];
    });
    if (userErrors.length === 0) {
      for (const write of input.quantities) {
        byItem.get(write.inventoryItemId)!.inventory[write.locationId] =
          write.quantity;
      }
    }
    return {
      inventorySetQuantities: {
        userErrors,
        inventoryAdjustmentGroup: userErrors.length
          ? null
          : { createdAt: new Date().toISOString(), reason: "correction" },
      },
    };
  },

  OrchestratorShopLocales: (store) => ({
    shopLocales: store.locales.map((locale) => ({
      ...locale,
      marketWebPresences: [
        { ...webPresence(store), markets: { nodes: [MARKET] } },
      ],
    })),
  }),

  OrchestratorMarkets: (store) => ({
    markets: {
      nodes: [{ ...MARKET, webPresences: { nodes: [webPresence(store)] } }],
    },
  }),

  OrchestratorAvailableLocales: () => ({ availableLocales: AVAILABLE_LOCALES }),

  OrchestratorVariantCount: (store) => ({
    productVariantsCount: {
      count: variantsOf(store).length,
      precision: "EXACT",
    },
  }),

  // Without metafields or the variant count: the fake store has neither.
  OrchestratorVariantDetails: (store) => ({
    productVariants: {
      pageInfo: EMPTY_PAGE,
      nodes: variantsOf(store).map(({ product, variant }) => ({
        id: variant.id,
        sku: variant.sku,
        title: variant.title,
        barcode: null,
        price: variant.price,
        selectedOptions: [{ name: "Title", value: variant.title }],
        product: {
          id: product.id,
          title: product.title,
          vendor: product.vendor,
          productType: product.productType,
          handle: product.handle,
        },
      })),
    },
  }),

  OrchestratorMetafieldDefinitions: (store) => ({
    productDefs: {
      nodes: store.metafieldDefinitions
        .filter((d) => d.ownerType === "PRODUCT")
        .map((d) => ({
          namespace: d.namespace,
          key: d.key,
          name: d.name,
          type: { name: d.type },
        })),
    },
    variantDefs: {
      nodes: store.metafieldDefinitions
        .filter((d) => d.ownerType === "PRODUCTVARIANT")
        .map((d) => ({
          namespace: d.namespace,
          key: d.key,
          name: d.name,
          type: { name: d.type },
        })),
    },
  }),

  // The Definitions tab's read: paged, filtered by owner type and, for the
  // re-read after a TAKEN answer, by namespace and key.
  OrchestratorPlanDefinitions: (store, variables) => {
    const { ownerType, first, after, namespace, key } =
      planDefinitionsSchema.parse(variables);
    const matching = store.metafieldDefinitions.filter(
      (d) =>
        d.ownerType === ownerType &&
        (namespace == null || d.namespace === namespace) &&
        (key == null || d.key === key),
    );
    const start = after ? Number(after) : 0;
    const page = matching.slice(start, start + first);
    const end = start + page.length;
    return {
      metafieldDefinitions: {
        nodes: page.map((d, i) => ({
          id: `gid://shopify/MetafieldDefinition/${start + i + 1}`,
          namespace: d.namespace,
          key: d.key,
          name: d.name,
          type: { name: d.type },
        })),
        pageInfo: {
          hasNextPage: end < matching.length,
          endCursor: end < matching.length ? String(end) : null,
        },
      },
    };
  },

  // Like Shopify: an existing owner/namespace/key is TAKEN, never replaced.
  OrchestratorPlanDefinitionCreate: (store, variables) => {
    const { definition } = createDefinitionSchema.parse(variables);
    const taken = store.metafieldDefinitions.some(
      (d) =>
        d.ownerType === definition.ownerType &&
        d.namespace === definition.namespace &&
        d.key === definition.key,
    );
    if (taken)
      return {
        metafieldDefinitionCreate: {
          createdDefinition: null,
          userErrors: [
            {
              field: ["definition", "key"],
              message: "Key is in use for this owner type.",
              code: "TAKEN",
            },
          ],
        },
      };
    store.metafieldDefinitions.push({
      ownerType: definition.ownerType,
      namespace: definition.namespace,
      key: definition.key,
      name: definition.name,
      type: definition.type,
    });
    return {
      metafieldDefinitionCreate: {
        createdDefinition: {
          id: `gid://shopify/MetafieldDefinition/${store.metafieldDefinitions.length}`,
        },
        userErrors: [],
      },
    };
  },

  OrchestratorProductWorkspace: (store, variables) => {
    const product = store.products.find((p) => p.id === String(variables.id));
    if (!product) return { product: null };
    return {
      product: {
        id: product.id,
        legacyResourceId: product.id.split("/").pop() ?? "0",
        title: product.title,
        handle: product.handle,
        descriptionHtml: product.descriptionHtml,
        vendor: product.vendor,
        productType: product.productType,
        status: product.status,
        tags: product.tags,
        updatedAt: "2026-10-01T00:00:00Z",
        onlineStoreUrl: null,
        onlineStorePreviewUrl: null,
        hasOnlyDefaultVariant: product.variants.length === 1,
        seo: { title: null, description: null },
        category: null,
        collections: { nodes: [] },
        featuredMedia: null,
        media: { nodes: [] },
        mediaCount: { count: 0 },
        metafields: { nodes: metafieldNodesOf(product.metafields) },
        options: [{ name: "Title" }],
        variantsCount: { count: product.variants.length },
        variants: {
          nodes: product.variants.map((variant) => ({
            id: variant.id,
            title: variant.title,
            sku: variant.sku,
            barcode: null,
            price: variant.price,
            compareAtPrice: variant.compareAtPrice,
            inventoryQuantity: 0,
            selectedOptions: [{ name: "Title", value: variant.title }],
          })),
        },
      },
    };
  },

  OrchestratorVariantMetafields: (store, variables) => {
    const ids = z.array(z.string()).parse(variables.ids);
    const keys = new Set(z.array(z.string()).parse(variables.keys));
    const byId = new Map(
      variantsOf(store).map((e) => [e.variant.id, e.variant]),
    );
    return {
      nodes: ids.map((id) => {
        const variant = byId.get(id);
        if (!variant) return null;
        return {
          id,
          metafields: {
            nodes: metafieldNodesOf(variant.metafields).filter((m) =>
              keys.has(`${m.namespace}.${m.key}`),
            ),
          },
        };
      }),
    };
  },

  // A value must have the type of the definition the store holds, as in Shopify.
  OrchestratorWorkspaceMetafieldsSet: (store, variables) => {
    const writes = z.array(metafieldWriteSchema).parse(variables.metafields);
    const userErrors: Array<{ field: string[]; message: string }> = [];
    writes.forEach((write, index) => {
      const owner = ownerOf(store, write.ownerId);
      const definition = store.metafieldDefinitions.find(
        (d) =>
          d.ownerType === owner?.ownerType &&
          d.namespace === write.namespace &&
          d.key === write.key,
      );
      if (!owner)
        userErrors.push({
          field: ["metafields", String(index), "ownerId"],
          message: "Owner does not exist.",
        });
      else if (definition && definition.type !== write.type)
        userErrors.push({
          field: ["metafields", String(index), "type"],
          message: `Type must be ${definition.type}.`,
        });
    });
    if (userErrors.length === 0)
      for (const write of writes) {
        const owner = ownerOf(store, write.ownerId);
        if (owner)
          owner.metafields[`${write.namespace}.${write.key}`] = {
            type: write.type,
            value: write.value,
          };
      }
    return { metafieldsSet: { metafields: [], userErrors } };
  },

  OrchestratorWorkspaceMetafieldsDelete: (store, variables) => {
    const ids = z
      .array(
        z.object({
          ownerId: z.string(),
          namespace: z.string(),
          key: z.string(),
        }),
      )
      .parse(variables.metafields);
    for (const id of ids) {
      const owner = ownerOf(store, id.ownerId);
      if (owner) delete owner.metafields[`${id.namespace}.${id.key}`];
    }
    return { metafieldsDelete: { deletedMetafields: [], userErrors: [] } };
  },

  // The fake does not evaluate Shopify search syntax; nothing is waiting for
  // review in a fake store until a spec needs otherwise.
  OrchestratorReviewCount: () => ({ productsCount: { count: 0 } }),
  OrchestratorReviewProducts: () => ({
    products: {
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      },
      nodes: [],
    },
    productsCount: { count: 0, precision: "EXACT" },
  }),

  OrchestratorVariantPrices: (store, variables) => {
    const ids = z.array(z.string()).parse(variables.ids);
    const byId = new Map(
      variantsOf(store).map((entry) => [entry.variant.id, entry]),
    );
    return {
      nodes: ids.map((id) => {
        const entry = byId.get(id);
        if (!entry) return null;
        const { product, variant } = entry;
        return {
          id: variant.id,
          sku: variant.sku,
          title: variant.title,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice,
          product: { id: product.id, title: product.title },
        };
      }),
    };
  },

  OrchestratorWriteVariantPrices: (store, variables) => {
    const input = writeVariantPricesSchema.parse(variables);
    const product = store.products.find(
      (entry) => entry.id === input.productId,
    );
    if (!product) {
      return {
        productVariantsBulkUpdate: {
          productVariants: null,
          userErrors: [
            {
              field: ["productId"],
              message: "Product does not exist",
              code: "PRODUCT_DOES_NOT_EXIST",
            },
          ],
        },
      };
    }
    const written = input.variants.flatMap((write) => {
      const variant = product.variants.find((entry) => entry.id === write.id);
      if (!variant) return [];
      variant.price = write.price;
      variant.compareAtPrice = write.compareAtPrice;
      return [
        {
          id: variant.id,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice,
        },
      ];
    });
    return {
      productVariantsBulkUpdate: { productVariants: written, userErrors: [] },
    };
  },

  // No automatic discounts and no Markets price lists in the fake store, so
  // the sale preview has nothing to warn about.
  OrchestratorAutomaticDiscounts: () => ({ discountNodes: { nodes: [] } }),
  OrchestratorPriceLists: () => ({
    priceLists: { pageInfo: EMPTY_PAGE, nodes: [] },
  }),

  OrchestratorTaxSettings: (store) => ({
    shop: {
      taxesIncluded: store.taxesIncluded,
      currencyCode: store.currencyCode,
    },
  }),

  OrchestratorVariants: (store) => ({
    productVariants: {
      pageInfo: EMPTY_PAGE,
      nodes: variantsOf(store).map(({ product, variant }) => ({
        id: variant.id,
        sku: variant.sku,
        title: variant.title,
        displayName: `${product.title} - ${variant.title}`,
        price: variant.price,
        inventoryItem: { id: inventoryItemId(variant.id) },
        image: null,
        product: {
          id: product.id,
          title: product.title,
          vendor: product.vendor,
          productType: product.productType,
          featuredImage: null,
        },
      })),
    },
  }),
};

const requestSchema = z.object({
  shop: z.string(),
  query: z.string(),
  variables: z.record(z.string(), z.unknown()).default({}),
});

export function operationName(query: string): string {
  return (
    /\b(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query)?.[1] ?? "anonymous"
  );
}

export function handleShopifyGraphql(body: unknown): unknown {
  const request = requestSchema.parse(body);
  const operation = operationName(request.query);
  const state = shopState(request.shop);

  if (!state) {
    return {
      errors: [
        {
          message: `fake shopify: shop ${request.shop} was never reset by a spec`,
        },
      ],
    };
  }

  const handler = handlers[operation];
  state.calls.push({
    service: "shopify",
    operation,
    variables: request.variables,
    handled: handler !== undefined,
  });

  if (!handler) {
    return {
      errors: [{ message: `fake shopify: no handler for ${operation}` }],
    };
  }
  return { data: handler(state.shopify, request.variables) };
}
