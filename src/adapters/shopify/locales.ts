import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import type { ShopLocale } from "~/domain/translations/types";

/**
 * Shopify's locales and their Markets relationships
 * (docs/translations.md § Shopify operations).
 *
 * The locale state — which exist, which are published, which is primary,
 * which market web presences carry each — is Shopify's and is read every
 * time it is shown. Nothing here is cached.
 *
 * Every mutation answers with the locale as Shopify now holds it, so a
 * screen reflects the real state after the operation rather than what it
 * asked for. Needs `read_locales`/`write_locales`; the web presence and
 * market fields need `read_markets`.
 */

const graphqlErrorSchema = z
  .array(
    z
      .object({
        message: z.string(),
        extensions: z.object({ code: z.string().optional() }).passthrough().optional(),
      })
      .passthrough(),
  )
  .optional();

const webPresenceSchema = z.object({
  id: z.string(),
  defaultLocale: z.object({ locale: z.string() }),
  alternateLocales: z.array(z.object({ locale: z.string() })),
  domain: z.object({ host: z.string() }).nullable(),
  subfolderSuffix: z.string().nullable(),
  markets: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        handle: z.string(),
        status: z.string(),
      }),
    ),
  }),
});

const shopLocaleSchema = z.object({
  locale: z.string(),
  name: z.string(),
  primary: z.boolean(),
  published: z.boolean(),
  marketWebPresences: z.array(webPresenceSchema),
});

const LOCALES_QUERY = `#graphql
  query OrchestratorShopLocales {
    shopLocales {
      locale
      name
      primary
      published
      marketWebPresences {
        id
        defaultLocale { locale }
        alternateLocales { locale }
        domain { host }
        subfolderSuffix
        markets(first: 20) { nodes { id name handle status } }
      }
    }
  }
`;

const localesSchema = z.object({
  data: z.object({ shopLocales: z.array(shopLocaleSchema) }).nullable().optional(),
  errors: graphqlErrorSchema,
});

export type LocalesResult =
  | { kind: "read"; locales: ShopLocale[] }
  | { kind: "unavailable"; reason: string };

function toShopLocale(node: z.infer<typeof shopLocaleSchema>): ShopLocale {
  return {
    locale: node.locale,
    name: node.name,
    primary: node.primary,
    published: node.published,
    webPresences: node.marketWebPresences.map((presence) => ({
      id: presence.id,
      isDefault: presence.defaultLocale.locale === node.locale,
      markets: presence.markets.nodes,
      host: presence.domain?.host ?? null,
      subfolderSuffix: presence.subfolderSuffix,
    })),
  };
}

function accessDenied(
  errors: z.infer<typeof graphqlErrorSchema>,
): string | null {
  const denied = errors?.find(
    (error) =>
      error.extensions?.code === "ACCESS_DENIED" ||
      /access denied|requires .* scope/i.test(error.message),
  );
  if (!denied) return null;
  return "The app has not been granted permission to manage languages yet. Open the app again to approve it.";
}

export async function listShopLocales(
  admin: AdminApiContext,
): Promise<LocalesResult> {
  const response = await admin.graphql(LOCALES_QUERY, { tries: 2 });
  const parsed = localesSchema.parse(await response.json());
  const denied = accessDenied(parsed.errors);
  if (denied) return { kind: "unavailable", reason: denied };
  if (parsed.errors && parsed.errors.length > 0)
    return { kind: "unavailable", reason: parsed.errors[0]?.message ?? "" };
  const locales = parsed.data?.shopLocales ?? [];
  return {
    kind: "read",
    locales: locales
      .map(toShopLocale)
      // Primary first, then published, then by name.
      .sort((a, b) =>
        a.primary !== b.primary
          ? a.primary
            ? -1
            : 1
          : a.published !== b.published
            ? a.published
              ? -1
              : 1
            : a.name.localeCompare(b.name),
      ),
  };
}

const AVAILABLE_QUERY = `#graphql
  query OrchestratorAvailableLocales {
    availableLocales { isoCode name }
  }
`;

const availableSchema = z.object({
  data: z
    .object({
      availableLocales: z.array(z.object({ isoCode: z.string(), name: z.string() })),
    })
    .nullable()
    .optional(),
  errors: graphqlErrorSchema,
});

export interface AvailableLocale {
  isoCode: string;
  name: string;
}

/** Every locale Shopify can enable, for the Add language picker. */
export async function listAvailableLocales(
  admin: AdminApiContext,
): Promise<AvailableLocale[]> {
  const response = await admin.graphql(AVAILABLE_QUERY, { tries: 2 });
  const parsed = availableSchema.parse(await response.json());
  return (parsed.data?.availableLocales ?? []).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

const userErrorsSchema = z.array(
  z.object({
    field: z.array(z.string()).nullable().optional(),
    message: z.string(),
  }),
);

export type LocaleMutationResult =
  | { kind: "ok"; locale: ShopLocale | null }
  | { kind: "rejected"; messages: string[] };

const ENABLE_MUTATION = `#graphql
  mutation OrchestratorEnableLocale($locale: String!, $marketWebPresenceIds: [ID!]) {
    shopLocaleEnable(locale: $locale, marketWebPresenceIds: $marketWebPresenceIds) {
      shopLocale {
        locale name primary published
        marketWebPresences {
          id
          defaultLocale { locale }
          alternateLocales { locale }
          domain { host }
          subfolderSuffix
          markets(first: 20) { nodes { id name handle status } }
        }
      }
      userErrors { field message }
    }
  }
`;

const enableSchema = z.object({
  data: z
    .object({
      shopLocaleEnable: z
        .object({
          shopLocale: shopLocaleSchema.nullable(),
          userErrors: userErrorsSchema,
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: graphqlErrorSchema,
});

/** Adds a locale to the shop. Shopify creates it unpublished. */
export async function enableShopLocale(
  admin: AdminApiContext,
  locale: string,
  marketWebPresenceIds: string[] | null,
): Promise<LocaleMutationResult> {
  const response = await admin.graphql(ENABLE_MUTATION, {
    variables: {
      locale,
      marketWebPresenceIds:
        marketWebPresenceIds && marketWebPresenceIds.length > 0
          ? marketWebPresenceIds
          : null,
    },
    tries: 2,
  });
  const parsed = enableSchema.parse(await response.json());
  return mutationOutcome(
    parsed.errors,
    parsed.data?.shopLocaleEnable ?? null,
  );
}

const UPDATE_MUTATION = `#graphql
  mutation OrchestratorUpdateLocale($locale: String!, $shopLocale: ShopLocaleInput!) {
    shopLocaleUpdate(locale: $locale, shopLocale: $shopLocale) {
      shopLocale {
        locale name primary published
        marketWebPresences {
          id
          defaultLocale { locale }
          alternateLocales { locale }
          domain { host }
          subfolderSuffix
          markets(first: 20) { nodes { id name handle status } }
        }
      }
      userErrors { field message }
    }
  }
`;

const updateSchema = z.object({
  data: z
    .object({
      shopLocaleUpdate: z
        .object({
          shopLocale: shopLocaleSchema.nullable(),
          userErrors: userErrorsSchema,
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: graphqlErrorSchema,
});

/**
 * Publishes or unpublishes a locale, and/or sets the market web presences it
 * is enabled on. `marketWebPresenceIds: []` removes it from every presence.
 */
export async function updateShopLocale(
  admin: AdminApiContext,
  locale: string,
  input: { published?: boolean; marketWebPresenceIds?: string[] },
): Promise<LocaleMutationResult> {
  const response = await admin.graphql(UPDATE_MUTATION, {
    variables: { locale, shopLocale: input },
    tries: 2,
  });
  const parsed = updateSchema.parse(await response.json());
  return mutationOutcome(
    parsed.errors,
    parsed.data?.shopLocaleUpdate ?? null,
  );
}

const DISABLE_MUTATION = `#graphql
  mutation OrchestratorDisableLocale($locale: String!) {
    shopLocaleDisable(locale: $locale) {
      locale
      userErrors { field message }
    }
  }
`;

const disableSchema = z.object({
  data: z
    .object({
      shopLocaleDisable: z
        .object({
          locale: z.string().nullable(),
          userErrors: userErrorsSchema,
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: graphqlErrorSchema,
});

/**
 * Removes a locale from the shop. Shopify refuses for the primary locale and
 * says so in `userErrors`, which is the authority on whether it is allowed;
 * this app checks nothing of its own first.
 */
export async function disableShopLocale(
  admin: AdminApiContext,
  locale: string,
): Promise<LocaleMutationResult> {
  const response = await admin.graphql(DISABLE_MUTATION, {
    variables: { locale },
    tries: 2,
  });
  const parsed = disableSchema.parse(await response.json());
  const payload = parsed.data?.shopLocaleDisable ?? null;
  const denied = accessDenied(parsed.errors);
  if (denied) return { kind: "rejected", messages: [denied] };
  if (parsed.errors && parsed.errors.length > 0)
    return {
      kind: "rejected",
      messages: parsed.errors.map((error) => error.message),
    };
  if (!payload) return { kind: "rejected", messages: ["Shopify did not answer."] };
  if (payload.userErrors.length > 0)
    return {
      kind: "rejected",
      messages: payload.userErrors.map((error) => error.message),
    };
  return { kind: "ok", locale: null };
}

function mutationOutcome(
  errors: z.infer<typeof graphqlErrorSchema>,
  payload: {
    shopLocale: z.infer<typeof shopLocaleSchema> | null;
    userErrors: z.infer<typeof userErrorsSchema>;
  } | null,
): LocaleMutationResult {
  const denied = accessDenied(errors);
  if (denied) return { kind: "rejected", messages: [denied] };
  if (errors && errors.length > 0)
    return { kind: "rejected", messages: errors.map((error) => error.message) };
  if (!payload) return { kind: "rejected", messages: ["Shopify did not answer."] };
  if (payload.userErrors.length > 0)
    return {
      kind: "rejected",
      messages: payload.userErrors.map((error) => error.message),
    };
  return {
    kind: "ok",
    locale: payload.shopLocale ? toShopLocale(payload.shopLocale) : null,
  };
}

const MARKETS_QUERY = `#graphql
  query OrchestratorMarkets {
    markets(first: 50) {
      nodes {
        id name handle status
        webPresences(first: 10) {
          nodes {
            id
            defaultLocale { locale }
            alternateLocales { locale }
            domain { host }
            subfolderSuffix
          }
        }
      }
    }
  }
`;

const marketsSchema = z.object({
  data: z
    .object({
      markets: z.object({
        nodes: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            handle: z.string(),
            status: z.string(),
            webPresences: z.object({
              nodes: z.array(
                z.object({
                  id: z.string(),
                  defaultLocale: z.object({ locale: z.string() }),
                  alternateLocales: z.array(z.object({ locale: z.string() })),
                  domain: z.object({ host: z.string() }).nullable(),
                  subfolderSuffix: z.string().nullable(),
                }),
              ),
            }),
          }),
        ),
      }),
    })
    .nullable()
    .optional(),
  errors: graphqlErrorSchema,
});

export interface MarketPresence {
  id: string;
  /** "example.de", "/de-at" or "shop domain". */
  label: string;
  defaultLocale: string;
  alternateLocales: string[];
}

export interface Market {
  id: string;
  name: string;
  handle: string;
  status: string;
  presences: MarketPresence[];
}

export type MarketsResult =
  | { kind: "read"; markets: Market[] }
  | { kind: "unavailable"; reason: string };

/** Every market and the web presences that decide which languages it shows. */
export async function listMarkets(admin: AdminApiContext): Promise<MarketsResult> {
  const response = await admin.graphql(MARKETS_QUERY, { tries: 2 });
  const parsed = marketsSchema.parse(await response.json());
  const denied = accessDenied(parsed.errors);
  if (denied) return { kind: "unavailable", reason: denied };
  if (parsed.errors && parsed.errors.length > 0)
    return { kind: "unavailable", reason: parsed.errors[0]?.message ?? "" };
  return {
    kind: "read",
    markets: (parsed.data?.markets.nodes ?? []).map((market) => ({
      id: market.id,
      name: market.name,
      handle: market.handle,
      status: market.status,
      presences: market.webPresences.nodes.map((presence) => ({
        id: presence.id,
        label:
          presence.domain?.host ??
          (presence.subfolderSuffix
            ? `/${presence.subfolderSuffix}`
            : "shop domain"),
        defaultLocale: presence.defaultLocale.locale,
        alternateLocales: presence.alternateLocales.map((l) => l.locale),
      })),
    })),
  };
}
