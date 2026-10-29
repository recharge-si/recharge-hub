import { z } from "zod";

/**
 * The fake services' memory: one entry per shop, replaced by every reset.
 *
 * The Shopify half is a deliberately small model of a store — enough for the
 * pages under test to render real data and for writes to be visible to the
 * next read. Grow it when a spec needs more; do not invent fields Shopify does
 * not have (AGENTS.md § Project constraints).
 */

const metafieldsSchema = z
  .record(z.string(), z.object({ type: z.string(), value: z.string() }))
  .default({});

/** A metafield definition in the fake store (docs/attributes.md, Metafield definitions). */
export const definitionSchema = z.object({
  ownerType: z.enum(["PRODUCT", "PRODUCTVARIANT"]),
  namespace: z.string(),
  key: z.string(),
  name: z.string().default(""),
  type: z.string(),
});

const variantSchema = z.object({
  id: z.string(),
  metafields: metafieldsSchema,
  title: z.string(),
  sku: z.string().nullable(),
  price: z.string(),
  compareAtPrice: z.string().nullable(),
  /** On-hand quantity by location id; absent means not stocked there. */
  inventory: z.record(z.string(), z.number().int()).default({}),
});

const productSchema = z.object({
  id: z.string(),
  title: z.string(),
  handle: z.string(),
  status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).default("ACTIVE"),
  vendor: z.string().default(""),
  productType: z.string().default(""),
  tags: z.array(z.string()).default([]),
  descriptionHtml: z.string().default(""),
  /** `namespace.key` to its type and value. */
  metafields: metafieldsSchema,
  variants: z.array(variantSchema),
});

const locationSchema = z.object({
  id: z.string(),
  name: z.string(),
  isActive: z.boolean().default(true),
});

const localeSchema = z.object({
  locale: z.string(),
  name: z.string(),
  primary: z.boolean().default(false),
  published: z.boolean().default(true),
});

export const shopifyStoreSchema = z.object({
  name: z.string().default("E2E Store"),
  currencyCode: z.string().default("EUR"),
  taxesIncluded: z.boolean().default(true),
  ianaTimezone: z.string().default("Europe/Ljubljana"),
  locales: z
    .array(localeSchema)
    .default([
      { locale: "sl", name: "Slovenian", primary: true, published: true },
    ]),
  locations: z.array(locationSchema).default([]),
  products: z.array(productSchema).default([]),
  /** Definitions the store already has; creating one adds to this list. */
  metafieldDefinitions: z.array(definitionSchema).default([]),
});

const warehouseSchema = z.object({
  mkId: z.string(),
  mark: z.string(),
  name: z.string(),
  main: z.boolean().default(false),
});

const articleSchema = z.object({
  mkId: z.string(),
  /** The article code, which matches a Shopify SKU. */
  code: z.string(),
  name: z.string(),
  /** Physical stock by warehouse mk_id; absent means no stock row there. */
  stock: z.record(z.string(), z.number()).default({}),
});

/** The MetaKocka company, in the terms its API reports. */
export const metakockaCompanySchema = z.object({
  warehouses: z.array(warehouseSchema).default([
    {
      mkId: "678900000004",
      mark: "glavno",
      name: "Glavno skladišče",
      main: true,
    },
    { mkId: "678900000069", mark: "Shopify", name: "Shopify", main: false },
  ]),
  /** The payment register, which MetaKocka only reveals by rejecting a value. */
  paymentTypes: z
    .array(z.string())
    .default(["Gotovina", "Kartica", "PayPal", "Predračun"]),
  products: z.array(articleSchema).default([]),
});

export const resetRequestSchema = z.object({
  shopify: shopifyStoreSchema.default(() => shopifyStoreSchema.parse({})),
  metakocka: metakockaCompanySchema.default(() =>
    metakockaCompanySchema.parse({}),
  ),
  /** The company id the shop's seeded MetaKocka credentials carry. */
  metakockaCompanyId: z.string().optional(),
});

export type ResetRequest = z.input<typeof resetRequestSchema>;
export type ShopifyStore = z.infer<typeof shopifyStoreSchema>;
export type MetakockaCompany = z.infer<typeof metakockaCompanySchema>;
export type FakeProduct = z.infer<typeof productSchema>;
export type FakeVariant = z.infer<typeof variantSchema>;
export type FakeDefinition = z.infer<typeof definitionSchema>;

export interface RecordedCall {
  service: "shopify" | "metakocka";
  /** The GraphQL operation name, or the MetaKocka endpoint path. */
  operation: string;
  variables: unknown;
  handled: boolean;
}

export interface ShopState {
  shopify: ShopifyStore;
  metakocka: MetakockaCompany;
  calls: RecordedCall[];
}

const shops = new Map<string, ShopState>();
const shopByCompany = new Map<string, string>();

export function resetShop(shop: string, body: unknown): void {
  const request = resetRequestSchema.parse(body);
  shops.set(shop, {
    shopify: request.shopify,
    metakocka: request.metakocka,
    calls: [],
  });
  if (request.metakockaCompanyId) {
    shopByCompany.set(request.metakockaCompanyId, shop);
  }
}

export function shopState(shop: string): ShopState | undefined {
  return shops.get(shop);
}

export function shopForCompany(companyId: string): ShopState | undefined {
  const shop = shopByCompany.get(companyId);
  return shop ? shops.get(shop) : undefined;
}
