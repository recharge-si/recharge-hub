import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import type {
  ExistingTranslation,
  ResourceType,
  SourceField,
} from "~/domain/translations/types";

/**
 * Shopify's translatable content and translations
 * (docs/translations.md § Shopify operations).
 *
 * Original strings, their digests, existing translations and the outdated
 * flag are read here and nowhere stored: a page of resources is read, acted
 * on and forgotten. Writes go through `translationsRegister`, which is the
 * only way a translation reaches the storefront, and every write carries the
 * digest of the source it was made from so Shopify can mark it outdated when
 * the source moves.
 *
 * Needs `read_translations`/`write_translations`.
 */

/** A locale code as Shopify spells it: "de", "pt-BR", "zh-Hant-TW". */
const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function isLocaleCode(value: string): boolean {
  return LOCALE_PATTERN.test(value);
}

function assertLocales(locales: readonly string[]): void {
  for (const locale of locales) {
    if (!isLocaleCode(locale))
      throw new Error(`Refusing to query an invalid locale code: ${locale}`);
  }
}

/**
 * One `translations` field per target locale, aliased `t0`, `t1`… — the
 * codes were checked against the pattern above, and the aliases are ours,
 * so nothing a merchant typed reaches the document.
 */
function translationSelections(locales: readonly string[]): string {
  assertLocales(locales);
  return locales
    .map(
      (locale, index) =>
        `t${index}: translations(locale: "${locale}") { key value locale outdated updatedAt }`,
    )
    .join("\n");
}

const contentSchema = z.object({
  key: z.string(),
  value: z.string().nullable(),
  digest: z.string().nullable(),
  locale: z.string(),
  type: z.string(),
});

const translationSchema = z.object({
  key: z.string(),
  value: z.string().nullable(),
  locale: z.string(),
  outdated: z.boolean(),
  updatedAt: z.string().nullable().optional(),
});

const nodeSchema = z
  .object({
    resourceId: z.string(),
    translatableContent: z.array(contentSchema),
  })
  .catchall(z.unknown());

const errorsSchema = z
  .array(
    z
      .object({
        message: z.string(),
        extensions: z.object({ code: z.string().optional() }).passthrough().optional(),
      })
      .passthrough(),
  )
  .optional();

export interface TranslatableResource {
  resourceId: string;
  /** Shopify's reported locale of the original content — the primary locale. */
  sourceLocale: string | null;
  fields: SourceField[];
  /** Existing translations per target locale asked for. */
  translations: Map<string, ExistingTranslation[]>;
}

export interface ResourcePage {
  resources: TranslatableResource[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function toResource(
  node: z.infer<typeof nodeSchema>,
  locales: readonly string[],
): TranslatableResource {
  const translations = new Map<string, ExistingTranslation[]>();
  locales.forEach((locale, index) => {
    const raw = node[`t${index}`];
    const parsed = z.array(translationSchema).safeParse(raw ?? []);
    translations.set(
      locale,
      parsed.success
        ? parsed.data.map((t) => ({
            key: t.key,
            value: t.value ?? "",
            outdated: t.outdated,
            updatedAt: t.updatedAt ?? null,
          }))
        : [],
    );
  });
  return {
    resourceId: node.resourceId,
    sourceLocale: node.translatableContent[0]?.locale ?? null,
    fields: node.translatableContent.map((content) => ({
      key: content.key,
      value: content.value ?? "",
      digest: content.digest,
      type: content.type,
    })),
    translations,
  };
}

function throwOnErrors(errors: z.infer<typeof errorsSchema>): void {
  if (!errors || errors.length === 0) return;
  const denied = errors.find(
    (error) =>
      error.extensions?.code === "ACCESS_DENIED" ||
      /access denied|requires .* scope/i.test(error.message),
  );
  if (denied)
    throw new TranslationsAccessError(
      "The app has not been granted permission to read translations yet. Open the app again to approve it.",
    );
  throw new Error(errors.map((error) => error.message).join("; "));
}

export class TranslationsAccessError extends Error {}

/**
 * A page of resources of one type, with the original fields and the
 * existing translations in each locale asked for. `first` is small on
 * purpose (a resource with a long description and four locales is a lot of
 * text); the caller pages with `endCursor`.
 */
export async function readTranslatableResources(
  admin: AdminApiContext,
  input: {
    type: ResourceType;
    first: number;
    after: string | null;
    locales: readonly string[];
  },
): Promise<ResourcePage> {
  const query = `#graphql
    query OrchestratorTranslatableResources($type: TranslatableResourceType!, $first: Int!, $after: String) {
      translatableResources(resourceType: $type, first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          resourceId
          translatableContent { key value digest locale type }
          ${translationSelections(input.locales)}
        }
      }
    }
  `;
  const schema = z.object({
    data: z
      .object({
        translatableResources: z.object({
          pageInfo: z.object({
            hasNextPage: z.boolean(),
            endCursor: z.string().nullable(),
          }),
          nodes: z.array(nodeSchema),
        }),
      })
      .nullable()
      .optional(),
    errors: errorsSchema,
  });

  const response = await admin.graphql(query, {
    variables: { type: input.type, first: input.first, after: input.after },
    tries: 3,
  });
  const parsed = schema.parse(await response.json());
  throwOnErrors(parsed.errors);
  const connection = parsed.data?.translatableResources;
  if (!connection) return { resources: [], hasNextPage: false, endCursor: null };
  return {
    resources: connection.nodes.map((node) => toResource(node, input.locales)),
    hasNextPage: connection.pageInfo.hasNextPage,
    endCursor: connection.pageInfo.endCursor,
  };
}

/** Named resources, in the order asked for; unknown ids are simply absent. */
export async function readTranslatableResourcesByIds(
  admin: AdminApiContext,
  input: { ids: readonly string[]; locales: readonly string[] },
): Promise<TranslatableResource[]> {
  if (input.ids.length === 0) return [];
  const query = `#graphql
    query OrchestratorTranslatableResourcesByIds($ids: [ID!]!, $first: Int!) {
      translatableResourcesByIds(resourceIds: $ids, first: $first) {
        nodes {
          resourceId
          translatableContent { key value digest locale type }
          ${translationSelections(input.locales)}
        }
      }
    }
  `;
  const schema = z.object({
    data: z
      .object({
        translatableResourcesByIds: z.object({ nodes: z.array(nodeSchema) }),
      })
      .nullable()
      .optional(),
    errors: errorsSchema,
  });
  const response = await admin.graphql(query, {
    variables: { ids: input.ids, first: Math.min(input.ids.length, 250) },
    tries: 3,
  });
  const parsed = schema.parse(await response.json());
  throwOnErrors(parsed.errors);
  const nodes = parsed.data?.translatableResourcesByIds.nodes ?? [];
  const byId = new Map(
    nodes.map((node) => [node.resourceId, toResource(node, input.locales)]),
  );
  return input.ids.flatMap((id) => {
    const found = byId.get(id);
    return found ? [found] : [];
  });
}

export interface TranslationWrite {
  key: string;
  locale: string;
  value: string;
  /** The source field's digest, from `translatableContent`. */
  digest: string;
}

export type RegisterResult =
  | { kind: "ok"; written: number }
  | { kind: "rejected"; messages: string[] };

const REGISTER_MUTATION = `#graphql
  mutation OrchestratorRegisterTranslations($resourceId: ID!, $translations: [TranslationInput!]!) {
    translationsRegister(resourceId: $resourceId, translations: $translations) {
      translations { key locale }
      userErrors { field message code }
    }
  }
`;

const writePayloadSchema = z
  .object({
    translations: z
      .array(z.object({ key: z.string(), locale: z.string() }))
      .nullable(),
    userErrors: z.array(
      z.object({
        field: z.array(z.string()).nullable().optional(),
        message: z.string(),
        code: z.string().nullable().optional(),
      }),
    ),
  })
  .nullable();

/** The envelope of a write mutation, whichever of the two it is. */
function writeSchema<K extends string>(name: K) {
  return z.object({
    data: z.object({ [name]: writePayloadSchema } as Record<K, typeof writePayloadSchema>).nullable().optional(),
    errors: errorsSchema,
  });
}

function writeOutcome(
  errors: z.infer<typeof errorsSchema>,
  payload: z.infer<typeof writePayloadSchema> | undefined,
  asked: number,
): RegisterResult {
  if (errors && errors.length > 0)
    return { kind: "rejected", messages: errors.map((error) => error.message) };
  if (!payload) return { kind: "rejected", messages: ["Shopify did not answer."] };
  if (payload.userErrors.length > 0)
    return {
      kind: "rejected",
      messages: payload.userErrors.map((error) =>
        error.field ? `${error.field.join(".")}: ${error.message}` : error.message,
      ),
    };
  return { kind: "ok", written: payload.translations?.length ?? asked };
}

/**
 * Creates or replaces translations on one resource. Shopify takes up to 100
 * per call; a resource never has that many fields across the locales one
 * pass writes, but the split is here so the limit is not a thing a caller
 * has to know.
 */
export async function registerTranslations(
  admin: AdminApiContext,
  resourceId: string,
  writes: readonly TranslationWrite[],
): Promise<RegisterResult> {
  if (writes.length === 0) return { kind: "ok", written: 0 };
  let written = 0;
  for (let start = 0; start < writes.length; start += 100) {
    const chunk = writes.slice(start, start + 100);
    const response = await admin.graphql(REGISTER_MUTATION, {
      variables: {
        resourceId,
        translations: chunk.map((write) => ({
          key: write.key,
          locale: write.locale,
          value: write.value,
          translatableContentDigest: write.digest,
        })),
      },
      tries: 2,
    });
    const parsed = writeSchema("translationsRegister").parse(await response.json());
    const outcome = writeOutcome(
      parsed.errors,
      parsed.data?.translationsRegister,
      chunk.length,
    );
    if (outcome.kind === "rejected") return outcome;
    written += outcome.written;
  }
  return { kind: "ok", written };
}

const REMOVE_MUTATION = `#graphql
  mutation OrchestratorRemoveTranslations($resourceId: ID!, $locales: [String!]!, $keys: [String!]!) {
    translationsRemove(resourceId: $resourceId, locales: $locales, translationKeys: $keys) {
      translations { key locale }
      userErrors { field message code }
    }
  }
`;

/** Deletes translations, which is what saving an empty field in the editor means. */
export async function removeTranslations(
  admin: AdminApiContext,
  resourceId: string,
  locales: readonly string[],
  keys: readonly string[],
): Promise<RegisterResult> {
  if (locales.length === 0 || keys.length === 0) return { kind: "ok", written: 0 };
  const response = await admin.graphql(REMOVE_MUTATION, {
    variables: { resourceId, locales, keys },
    tries: 2,
  });
  const parsed = writeSchema("translationsRemove").parse(await response.json());
  return writeOutcome(parsed.errors, parsed.data?.translationsRemove, keys.length);
}

/** The resource types the editor can search by title, and the query each uses. */
const SEARCHABLE: Partial<Record<ResourceType, string>> = {
  PRODUCT: "products",
  COLLECTION: "collections",
  PAGE: "pages",
  ARTICLE: "articles",
  BLOG: "blogs",
  MENU: "menus",
};

export function isSearchable(type: ResourceType): boolean {
  return type in SEARCHABLE;
}

/**
 * Titles matching a search, as ids for `readTranslatableResourcesByIds`.
 * `translatableResources` has no search of its own, so the resource's own
 * connection is asked and the translatable content fetched by id.
 */
export async function searchResourceIds(
  admin: AdminApiContext,
  type: ResourceType,
  search: string,
  first = 25,
): Promise<Array<{ id: string; title: string }>> {
  const connection = SEARCHABLE[type];
  if (!connection) return [];
  const query = `#graphql
    query OrchestratorSearchTranslatable($q: String, $first: Int!) {
      ${connection}(first: $first, query: $q) { nodes { id title } }
    }
  `;
  const schema = z.object({
    data: z.record(
      z.string(),
      z.object({ nodes: z.array(z.object({ id: z.string(), title: z.string() })) }),
    ).nullable().optional(),
    errors: errorsSchema,
  });
  const response = await admin.graphql(query, {
    variables: { q: searchQuery(search), first },
    tries: 2,
  });
  const parsed = schema.parse(await response.json());
  throwOnErrors(parsed.errors);
  return parsed.data?.[connection]?.nodes ?? [];
}

/** Shopify search syntax: a phrase, quoted, matched against the title. */
function searchQuery(search: string): string | null {
  const trimmed = search.trim().replace(/["\\]/g, " ");
  return trimmed === "" ? null : `title:*${trimmed}*`;
}

const SHOP_QUERY = `#graphql
  query OrchestratorShopName { shop { name } }
`;

export async function readShopName(admin: AdminApiContext): Promise<string | null> {
  const response = await admin.graphql(SHOP_QUERY, { tries: 2 });
  const parsed = z
    .object({ data: z.object({ shop: z.object({ name: z.string() }) }).nullable().optional() })
    .parse(await response.json());
  return parsed.data?.shop.name ?? null;
}

/** What to call a resource in a list, from its own translatable fields. */
export function resourceTitle(fields: readonly SourceField[], resourceId: string): string {
  for (const key of ["title", "name", "label", "meta_title"]) {
    const found = fields.find((field) => field.key === key && field.value.trim() !== "");
    if (found) return found.value.trim();
  }
  const first = fields.find((field) => field.value.trim() !== "");
  if (first) {
    const text = first.value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text !== "") return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  }
  return resourceId.replace("gid://shopify/", "");
}
