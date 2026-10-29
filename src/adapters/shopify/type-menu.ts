import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import {
  LEGACY_MENU_TYPE_FIELD,
  MENU_TYPE_FIELD,
} from "~/domain/attributes/menu";

/**
 * The Shopify side of the store menu (docs/attributes.md § Store menu): the
 * product metafield definition the collections match on, one automated
 * collection per type published to the online store, and the menu itself.
 * Every function is safe to repeat: it finds what an earlier run made
 * before making anything.
 */

/** A refusal worth showing as it is, such as a permission not yet approved. */
export class TypeMenuError extends Error {}

const ACCESS_MESSAGE =
  "The app has not been granted permission to manage collections and menus yet. Open the app again to approve the new permissions, then make the menu again.";

const errorsSchema = z
  .array(
    z
      .object({
        message: z.string(),
        extensions: z.object({ code: z.string().optional() }).optional(),
      })
      .passthrough(),
  )
  .optional();

export const userErrorsSchema = z.array(z.object({ message: z.string() }));

export function refuse(messages: string[]): never {
  if (
    messages.some((m) =>
      /access denied|requires .* scope|ACCESS_DENIED/i.test(m),
    )
  )
    throw new TypeMenuError(ACCESS_MESSAGE);
  throw new TypeMenuError(messages.join("; "));
}

/** One call: thrown or returned top-level errors become a `TypeMenuError`. */
export async function call<T extends z.ZodTypeAny>(
  admin: AdminApiContext,
  query: string,
  variables: Record<string, unknown>,
  data: T,
): Promise<z.infer<T>> {
  let body: unknown;
  try {
    const response = await admin.graphql(query, { variables });
    body = await response.json();
  } catch (error) {
    refuse([error instanceof Error ? error.message : String(error)]);
  }
  const parsed = z
    .object({ data: data.nullable().optional(), errors: errorsSchema })
    .parse(body);
  const errors = (parsed.errors ?? []).map((e) =>
    e.extensions?.code === "ACCESS_DENIED" ? "ACCESS_DENIED" : e.message,
  );
  if (errors.length > 0 || parsed.data == null)
    refuse(errors.length > 0 ? errors : ["Shopify returned no data."]);
  return parsed.data;
}

export function checked(userErrors: Array<{ message: string }>): void {
  if (userErrors.length > 0) refuse(userErrors.map((e) => e.message));
}

/* -------------------------------------------------------------------------- */
/* The type field                                                             */
/* -------------------------------------------------------------------------- */

const DEFINITION_QUERY = `#graphql
  query OrchestratorTypeMenuDefinition($namespace: String!, $key: String!) {
    metafieldDefinitions(first: 1, ownerType: PRODUCT, namespace: $namespace, key: $key) {
      nodes { id capabilities { smartCollectionCondition { enabled } } }
    }
  }
`;

const DEFINITION_CREATE = `#graphql
  mutation OrchestratorTypeMenuDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { message }
    }
  }
`;

const DEFINITION_UPDATE = `#graphql
  mutation OrchestratorTypeMenuDefinitionUpdate($definition: MetafieldDefinitionUpdateInput!) {
    metafieldDefinitionUpdate(definition: $definition) {
      updatedDefinition { id }
      userErrors { message }
    }
  }
`;

/**
 * The product field holding a product's type, with automated collections
 * allowed to match on it. Created when missing; switched on when it exists
 * without that capability.
 */
export async function ensureTypeField(admin: AdminApiContext): Promise<string> {
  const found = await call(
    admin,
    DEFINITION_QUERY,
    { namespace: MENU_TYPE_FIELD.namespace, key: MENU_TYPE_FIELD.key },
    z.object({
      metafieldDefinitions: z.object({
        nodes: z.array(
          z.object({
            id: z.string(),
            capabilities: z.object({
              smartCollectionCondition: z.object({ enabled: z.boolean() }),
            }),
          }),
        ),
      }),
    }),
  );
  const existing = found.metafieldDefinitions.nodes[0];
  const capabilities = { smartCollectionCondition: { enabled: true } };
  if (existing) {
    if (!existing.capabilities.smartCollectionCondition.enabled) {
      const updated = await call(
        admin,
        DEFINITION_UPDATE,
        {
          definition: {
            ownerType: "PRODUCT",
            namespace: MENU_TYPE_FIELD.namespace,
            key: MENU_TYPE_FIELD.key,
            capabilities,
          },
        },
        z.object({
          metafieldDefinitionUpdate: z.object({ userErrors: userErrorsSchema }),
        }),
      );
      checked(updated.metafieldDefinitionUpdate.userErrors);
    }
    return existing.id;
  }
  const created = await call(
    admin,
    DEFINITION_CREATE,
    {
      definition: {
        name: "Product type path (menu)",
        description:
          "The product type from the app's plan and every type above it. The store menu's collections are built on it; set by the app.",
        ownerType: "PRODUCT",
        namespace: MENU_TYPE_FIELD.namespace,
        key: MENU_TYPE_FIELD.key,
        type: MENU_TYPE_FIELD.type,
        capabilities,
      },
    },
    z.object({
      metafieldDefinitionCreate: z.object({
        createdDefinition: z.object({ id: z.string() }).nullable(),
        userErrors: userErrorsSchema,
      }),
    }),
  );
  checked(created.metafieldDefinitionCreate.userErrors);
  const id = created.metafieldDefinitionCreate.createdDefinition?.id;
  if (!id) refuse(["Shopify did not create the product type field."]);
  return id;
}

const DEFINITION_DELETE = `#graphql
  mutation OrchestratorTypeMenuDefinitionDelete($id: ID!) {
    metafieldDefinitionDelete(id: $id, deleteAllAssociatedMetafields: true) {
      deletedDefinitionId
      userErrors { message }
    }
  }
`;

/**
 * Removes the first version's single-value field, definition and values.
 * This app made it and nothing but the menu read it; the list field
 * replaces it.
 */
export async function removeLegacyTypeField(
  admin: AdminApiContext,
): Promise<void> {
  const found = await call(
    admin,
    DEFINITION_QUERY,
    {
      namespace: LEGACY_MENU_TYPE_FIELD.namespace,
      key: LEGACY_MENU_TYPE_FIELD.key,
    },
    z.object({
      metafieldDefinitions: z.object({
        nodes: z.array(z.object({ id: z.string() })),
      }),
    }),
  );
  const legacy = found.metafieldDefinitions.nodes[0];
  if (!legacy) return;
  const deleted = await call(
    admin,
    DEFINITION_DELETE,
    { id: legacy.id },
    z.object({
      metafieldDefinitionDelete: z.object({ userErrors: userErrorsSchema }),
    }),
  );
  checked(deleted.metafieldDefinitionDelete.userErrors);
}

/* -------------------------------------------------------------------------- */
/* Collections                                                                */
/* -------------------------------------------------------------------------- */

const EXISTING_QUERY = `#graphql
  query OrchestratorTypeMenuExisting($ids: [ID!]!) {
    nodes(ids: $ids) { ... on Collection { id } }
  }
`;

/** Which of these collections still exist; a merchant may have deleted some. */
export async function existingCollections(
  admin: AdminApiContext,
  ids: readonly string[],
): Promise<Set<string>> {
  const alive = new Set<string>();
  for (let start = 0; start < ids.length; start += 100) {
    const page = await call(
      admin,
      EXISTING_QUERY,
      { ids: ids.slice(start, start + 100) },
      z.object({
        nodes: z.array(z.object({ id: z.string().optional() }).nullable()),
      }),
    );
    for (const node of page.nodes) if (node?.id) alive.add(node.id);
  }
  return alive;
}

const COLLECTION_CREATE = `#graphql
  mutation OrchestratorTypeMenuCollectionCreate($collection: CollectionCreateInput!) {
    collectionCreate(collection: $collection) {
      collection { id sources { id } }
      userErrors { message }
    }
  }
`;

const COLLECTION_UPDATE = `#graphql
  mutation OrchestratorTypeMenuCollectionUpdate($collection: CollectionUpdateInput!) {
    collectionUpdate(collection: $collection) {
      collection { id sources { id } }
      userErrors { message }
    }
  }
`;

const collectionPayload = z.object({
  collection: z
    .object({ id: z.string(), sources: z.array(z.object({ id: z.string() })) })
    .nullable(),
  userErrors: userErrorsSchema,
});

/** Products whose type path includes this type: one value, whatever the branch's size. */
function typeSource(definitionId: string, typeId: string) {
  return {
    source: {
      title: "Product type",
      targetType: "PRODUCTS",
      inclusion: {
        matchType: "ALL",
        conditions: [
          {
            metafieldStringList: {
              definitionId,
              relation: "INCLUDES",
              matchType: "ANY",
              values: [typeId],
            },
          },
        ],
      },
    },
  };
}

export interface TypeCollection {
  collectionId: string;
  sourceId: string | null;
}

/**
 * One type's collection: products whose type path includes the type, so
 * those of the type and of every type beneath it. An existing one is
 * renamed and its condition replaced; the rest of it (description, image,
 * handle) is the merchant's.
 */
export async function upsertTypeCollection(
  admin: AdminApiContext,
  input: {
    existing: TypeCollection | null;
    title: string;
    definitionId: string;
    typeId: string;
  },
): Promise<TypeCollection> {
  const source = typeSource(input.definitionId, input.typeId);
  if (input.existing) {
    const updated = await call(
      admin,
      COLLECTION_UPDATE,
      {
        collection: {
          id: input.existing.collectionId,
          title: input.title,
          ...(input.existing.sourceId
            ? { sourcesToDelete: [input.existing.sourceId] }
            : {}),
          sourcesToCreate: [source],
        },
      },
      z.object({ collectionUpdate: collectionPayload }),
    );
    checked(updated.collectionUpdate.userErrors);
    const collection = updated.collectionUpdate.collection;
    if (!collection) refuse([`Shopify did not update “${input.title}”.`]);
    return {
      collectionId: collection.id,
      sourceId: collection.sources.at(-1)?.id ?? null,
    };
  }
  const created = await call(
    admin,
    COLLECTION_CREATE,
    { collection: { title: input.title, sources: [source] } },
    z.object({ collectionCreate: collectionPayload }),
  );
  checked(created.collectionCreate.userErrors);
  const collection = created.collectionCreate.collection;
  if (!collection) refuse([`Shopify did not create “${input.title}”.`]);
  return {
    collectionId: collection.id,
    sourceId: collection.sources[0]?.id ?? null,
  };
}

const PUBLICATIONS_QUERY = `#graphql
  query OrchestratorTypeMenuPublications {
    publications(first: 50) { nodes { id catalog { title } } }
  }
`;

/** The online store's publication, which a collection must be on to be seen. */
export async function onlineStorePublication(
  admin: AdminApiContext,
): Promise<string | null> {
  const data = await call(
    admin,
    PUBLICATIONS_QUERY,
    {},
    z.object({
      publications: z.object({
        nodes: z.array(
          z.object({
            id: z.string(),
            catalog: z.object({ title: z.string() }).nullable(),
          }),
        ),
      }),
    }),
  );
  return (
    data.publications.nodes.find((p) =>
      /online store/i.test(p.catalog?.title ?? ""),
    )?.id ?? null
  );
}

const PUBLISH = `#graphql
  mutation OrchestratorTypeMenuPublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) { userErrors { message } }
  }
`;

export async function publishCollection(
  admin: AdminApiContext,
  collectionId: string,
  publicationId: string,
): Promise<void> {
  const data = await call(
    admin,
    PUBLISH,
    { id: collectionId, input: [{ publicationId }] },
    z.object({
      publishablePublish: z.object({ userErrors: userErrorsSchema }),
    }),
  );
  checked(data.publishablePublish.userErrors);
}

/* -------------------------------------------------------------------------- */
/* The menu                                                                   */
/* -------------------------------------------------------------------------- */

export interface MenuLink {
  title: string;
  collectionId: string;
  items: MenuLink[];
}

const MENUS_QUERY = `#graphql
  query OrchestratorTypeMenuMenus {
    menus(first: 100) { nodes { id handle } }
  }
`;

const MENU_CREATE = `#graphql
  mutation OrchestratorTypeMenuCreate($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
    menuCreate(title: $title, handle: $handle, items: $items) {
      menu { id }
      userErrors { message }
    }
  }
`;

const MENU_UPDATE = `#graphql
  mutation OrchestratorTypeMenuUpdate($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
    menuUpdate(id: $id, title: $title, items: $items) {
      menu { id }
      userErrors { message }
    }
  }
`;

type MenuItemInput = {
  title: string;
  type: "COLLECTION";
  resourceId: string;
  items: MenuItemInput[];
};

const toItems = (links: readonly MenuLink[]): MenuItemInput[] =>
  links.map((link) => ({
    title: link.title,
    type: "COLLECTION",
    resourceId: link.collectionId,
    items: toItems(link.items),
  }));

/**
 * The menu under its handle, its items replaced whole. The one this app
 * made last time is updated; failing that, a menu with the handle is taken
 * over; otherwise one is created.
 */
export async function upsertMenu(
  admin: AdminApiContext,
  input: {
    menuId: string | null;
    title: string;
    handle: string;
    links: readonly MenuLink[];
  },
): Promise<string> {
  const menus = await call(
    admin,
    MENUS_QUERY,
    {},
    z.object({
      menus: z.object({
        nodes: z.array(z.object({ id: z.string(), handle: z.string() })),
      }),
    }),
  );
  const target =
    menus.menus.nodes.find((m) => m.id === input.menuId) ??
    menus.menus.nodes.find((m) => m.handle === input.handle);
  const items = toItems(input.links);
  const payload = z.object({
    menu: z.object({ id: z.string() }).nullable(),
    userErrors: userErrorsSchema,
  });

  if (target) {
    const updated = await call(
      admin,
      MENU_UPDATE,
      { id: target.id, title: input.title, items },
      z.object({ menuUpdate: payload }),
    );
    checked(updated.menuUpdate.userErrors);
    return updated.menuUpdate.menu?.id ?? target.id;
  }
  const created = await call(
    admin,
    MENU_CREATE,
    { title: input.title, handle: input.handle, items },
    z.object({ menuCreate: payload }),
  );
  checked(created.menuCreate.userErrors);
  const id = created.menuCreate.menu?.id;
  if (!id) refuse(["Shopify did not create the menu."]);
  return id;
}
