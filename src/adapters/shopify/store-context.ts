import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import type {
  SnapshotCollection,
  SnapshotMenu,
  SnapshotMenuItem,
  SnapshotProduct,
  StoreSnapshot,
} from "~/domain/translations/snapshot";

/**
 * What the store is about, read from Shopify for the translation engine
 * (docs/translations.md § Store profile, § Resource context).
 *
 * Two kinds of read. The **snapshot** is a bounded sample of the whole
 * store — its name and description, every menu, up to a hundred
 * collections, a few pages of products with their vendor, type, tags and
 * options, the blogs — from which the profile and the terminology are
 * built. The **context** reads answer "where does this text sit" for the
 * resources of one page: a product's vendor and collections, a
 * collection's sample products, an article's blog, a metafield's
 * definition. Menus are read once and every menu link is placed in them.
 * A product option or option value does not point back at its product in
 * the Admin API, so those carry their own values and the store's
 * terminology, not their product.
 *
 * Nothing about customers, orders, prices or inventory is asked for.
 */

const errorsSchema = z
  .array(z.object({ message: z.string() }).passthrough())
  .optional();

function throwOnErrors(errors: z.infer<typeof errorsSchema>): void {
  if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join("; "));
}

/* -------------------------------------------------------------------------- */
/* Menus                                                                      */
/* -------------------------------------------------------------------------- */

const menuItemBase = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string().nullable().optional(),
  resourceId: z.string().nullable().optional(),
});

const menuItemSchema = menuItemBase.extend({
  items: z
    .array(
      menuItemBase.extend({
        items: z.array(menuItemBase.extend({ items: z.array(menuItemBase).optional() })).optional(),
      }),
    )
    .optional(),
});

const menusSchema = z.object({
  data: z
    .object({
      menus: z.object({
        nodes: z.array(
          z.object({
            id: z.string(),
            handle: z.string(),
            title: z.string(),
            items: z.array(menuItemSchema),
          }),
        ),
      }),
    })
    .nullable()
    .optional(),
  errors: errorsSchema,
});

const MENUS_QUERY = `#graphql
  query OrchestratorTranslationMenus {
    menus(first: 25) {
      nodes {
        id handle title
        items {
          id title type resourceId
          items {
            id title type resourceId
            items {
              id title type resourceId
              items { id title type resourceId }
            }
          }
        }
      }
    }
  }
`;

type RawItem = z.infer<typeof menuItemBase> & { items?: RawItem[] | undefined };

function toMenuItem(item: RawItem): SnapshotMenuItem {
  return {
    id: item.id,
    title: item.title,
    type: item.type ?? null,
    resourceId: item.resourceId ?? null,
    items: (item.items ?? []).map(toMenuItem),
  };
}

/** Every menu with its items four levels deep, or none when navigation is not readable. */
export async function readMenus(admin: AdminApiContext): Promise<SnapshotMenu[]> {
  const response = await admin.graphql(MENUS_QUERY, { tries: 2 });
  const parsed = menusSchema.safeParse(await response.json());
  if (!parsed.success || (parsed.data.errors && parsed.data.errors.length > 0)) return [];
  return (parsed.data.data?.menus.nodes ?? []).map((menu) => ({
    id: menu.id,
    handle: menu.handle,
    title: menu.title,
    items: menu.items.map((item) => toMenuItem(item)),
  }));
}

/* -------------------------------------------------------------------------- */
/* Snapshot                                                                   */
/* -------------------------------------------------------------------------- */

const SHOP_QUERY = `#graphql
  query OrchestratorTranslationShop {
    shop { name description }
    collections(first: 100) {
      nodes { id title description(truncateAt: 240) productsCount { count } }
    }
    blogs(first: 20) { nodes { id title } }
    productsCount { count }
  }
`;

const shopSchema = z.object({
  data: z
    .object({
      shop: z.object({ name: z.string(), description: z.string().nullable() }),
      collections: z.object({
        nodes: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            description: z.string().nullable(),
            productsCount: z.object({ count: z.number() }).nullable(),
          }),
        ),
      }),
      blogs: z.object({ nodes: z.array(z.object({ id: z.string(), title: z.string() })) }),
      productsCount: z.object({ count: z.number() }).nullable(),
    })
    .nullable()
    .optional(),
  errors: errorsSchema,
});

const PRODUCTS_QUERY = `#graphql
  query OrchestratorTranslationProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: TITLE) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title vendor productType tags
        options { name optionValues { name } }
      }
    }
  }
`;

const productsSchema = z.object({
  data: z
    .object({
      products: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        nodes: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            vendor: z.string(),
            productType: z.string(),
            tags: z.array(z.string()),
            options: z.array(
              z.object({ name: z.string(), optionValues: z.array(z.object({ name: z.string() })) }),
            ),
          }),
        ),
      }),
    })
    .nullable()
    .optional(),
  errors: errorsSchema,
});

/** Products read for the snapshot: enough to see the range, never the whole catalogue. */
const SNAPSHOT_PRODUCTS = 250;
const PRODUCT_PAGE = 50;

/**
 * The bounded read the profile is built from. Menus, collections and blogs
 * are what a shopper navigates by; products are sampled by title order
 * across a few pages, which spreads the sample over the alphabet rather
 * than over whatever was edited last.
 */
export async function readStoreSnapshot(
  admin: AdminApiContext,
  primaryLocale: string,
): Promise<StoreSnapshot> {
  const [shopResponse, menus] = await Promise.all([
    admin.graphql(SHOP_QUERY, { tries: 2 }),
    readMenus(admin),
  ]);
  const shop = shopSchema.parse(await shopResponse.json());
  throwOnErrors(shop.errors);

  const products: SnapshotProduct[] = [];
  let after: string | null = null;
  while (products.length < SNAPSHOT_PRODUCTS) {
    const response = await admin.graphql(PRODUCTS_QUERY, {
      variables: { first: Math.min(PRODUCT_PAGE, SNAPSHOT_PRODUCTS - products.length), after },
      tries: 2,
    });
    const page = productsSchema.parse(await response.json());
    throwOnErrors(page.errors);
    const connection = page.data?.products;
    if (!connection) break;
    for (const node of connection.nodes)
      products.push({
        id: node.id,
        title: node.title,
        vendor: node.vendor || null,
        productType: node.productType || null,
        tags: node.tags,
        options: node.options.map((option) => ({
          name: option.name,
          values: option.optionValues.map((value) => value.name),
        })),
      });
    if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) break;
    after = connection.pageInfo.endCursor;
  }

  const collections: SnapshotCollection[] = (shop.data?.collections.nodes ?? []).map((node) => ({
    id: node.id,
    title: node.title,
    description: node.description,
    productsCount: node.productsCount?.count ?? null,
  }));

  return {
    shopName: shop.data?.shop.name ?? null,
    shopDescription: shop.data?.shop.description ?? null,
    primaryLocale,
    menus,
    collections,
    products,
    productsTotal: shop.data?.productsCount?.count ?? null,
    blogs: shop.data?.blogs.nodes ?? [],
  };
}

/* -------------------------------------------------------------------------- */
/* Per-resource context                                                       */
/* -------------------------------------------------------------------------- */

export interface ProductFacts {
  id: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  collections: string[];
  options: Array<{ id: string; name: string; values: Array<{ id: string; name: string }> }>;
}

export interface CollectionFacts {
  id: string;
  title: string;
  productsCount: number | null;
  sampleProducts: string[];
}

export interface ArticleFacts {
  id: string;
  title: string;
  blogTitle: string | null;
}

export interface MetafieldFacts {
  id: string;
  namespace: string;
  key: string;
  ownerTitle: string | null;
  ownerKind: string | null;
  definitionName: string | null;
  definitionDescription: string | null;
}

export interface OptionFacts {
  id: string;
  name: string;
  values: string[];
}

export interface OptionValueFacts {
  id: string;
  name: string;
}

export interface NodeFacts {
  products: Map<string, ProductFacts>;
  collections: Map<string, CollectionFacts>;
  articles: Map<string, ArticleFacts>;
  metafields: Map<string, MetafieldFacts>;
  options: Map<string, OptionFacts>;
  optionValues: Map<string, OptionValueFacts>;
}

const NODES_QUERY = `#graphql
  query OrchestratorTranslationContext($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Product {
        id title vendor productType tags
        options { id name optionValues { id name } }
        collections(first: 6) { nodes { title } }
      }
      ... on Collection {
        id title
        productsCount { count }
        products(first: 8) { nodes { title } }
      }
      ... on Article { id title blog { title } }
      ... on Metafield {
        id namespace key
        owner {
          __typename
          ... on Product { title }
          ... on Collection { title }
          ... on Article { title }
          ... on Page { title }
          ... on Blog { title }
          ... on Shop { name }
        }
        definition { name description }
      }
      ... on ProductOption { id name optionValues { id name } }
      ... on ProductOptionValue { id name }
    }
  }
`;

const titled = z.object({ __typename: z.string(), title: z.string().optional(), name: z.string().optional() });

const nodeSchema = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("Product"),
    id: z.string(),
    title: z.string(),
    vendor: z.string(),
    productType: z.string(),
    tags: z.array(z.string()),
    options: z.array(
      z.object({ id: z.string(), name: z.string(), optionValues: z.array(z.object({ id: z.string(), name: z.string() })) }),
    ),
    collections: z.object({ nodes: z.array(z.object({ title: z.string() })) }),
  }),
  z.object({
    __typename: z.literal("Collection"),
    id: z.string(),
    title: z.string(),
    productsCount: z.object({ count: z.number() }).nullable(),
    products: z.object({ nodes: z.array(z.object({ title: z.string() })) }),
  }),
  z.object({
    __typename: z.literal("Article"),
    id: z.string(),
    title: z.string(),
    blog: z.object({ title: z.string() }).nullable(),
  }),
  z.object({
    __typename: z.literal("Metafield"),
    id: z.string(),
    namespace: z.string(),
    key: z.string(),
    owner: titled.nullable(),
    definition: z.object({ name: z.string(), description: z.string().nullable() }).nullable(),
  }),
  z.object({
    __typename: z.literal("ProductOption"),
    id: z.string(),
    name: z.string(),
    optionValues: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
  z.object({ __typename: z.literal("ProductOptionValue"), id: z.string(), name: z.string() }),
]);

const nodesSchema = z.object({
  data: z.object({ nodes: z.array(z.unknown()) }).nullable().optional(),
  errors: errorsSchema,
});

export function emptyFacts(): NodeFacts {
  return {
    products: new Map(),
    collections: new Map(),
    articles: new Map(),
    metafields: new Map(),
    options: new Map(),
    optionValues: new Map(),
  };
}

/**
 * Facts about the named resources, whatever their kinds, in one request.
 * A node Shopify cannot return (deleted, or of a kind not asked about) is
 * simply absent; a page of resources translates with less context rather
 * than not at all.
 */
export async function readNodeFacts(admin: AdminApiContext, ids: readonly string[]): Promise<NodeFacts> {
  const facts = emptyFacts();
  if (ids.length === 0) return facts;
  for (let start = 0; start < ids.length; start += 50) {
    const chunk = ids.slice(start, start + 50);
    const response = await admin.graphql(NODES_QUERY, { variables: { ids: chunk }, tries: 2 });
    const parsed = nodesSchema.safeParse(await response.json());
    if (!parsed.success) continue;
    for (const raw of parsed.data.data?.nodes ?? []) {
      const node = nodeSchema.safeParse(raw);
      if (!node.success) continue;
      const value = node.data;
      switch (value.__typename) {
        case "Product":
          facts.products.set(value.id, {
            id: value.id,
            title: value.title,
            vendor: value.vendor || null,
            productType: value.productType || null,
            tags: value.tags,
            collections: value.collections.nodes.map((c) => c.title),
            options: value.options.map((option) => ({
              id: option.id,
              name: option.name,
              values: option.optionValues,
            })),
          });
          break;
        case "Collection":
          facts.collections.set(value.id, {
            id: value.id,
            title: value.title,
            productsCount: value.productsCount?.count ?? null,
            sampleProducts: value.products.nodes.map((p) => p.title),
          });
          break;
        case "Article":
          facts.articles.set(value.id, { id: value.id, title: value.title, blogTitle: value.blog?.title ?? null });
          break;
        case "Metafield":
          facts.metafields.set(value.id, {
            id: value.id,
            namespace: value.namespace,
            key: value.key,
            ownerTitle: value.owner?.title ?? value.owner?.name ?? null,
            ownerKind: value.owner?.__typename.toLowerCase() ?? null,
            definitionName: value.definition?.name ?? null,
            definitionDescription: value.definition?.description ?? null,
          });
          break;
        case "ProductOption":
          facts.options.set(value.id, {
            id: value.id,
            name: value.name,
            values: value.optionValues.map((v) => v.name),
          });
          break;
        case "ProductOptionValue":
          facts.optionValues.set(value.id, { id: value.id, name: value.name });
          break;
      }
    }
  }
  return facts;
}
