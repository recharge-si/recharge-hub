import { Session } from "@shopify/shopify-api";
import {
  ApiVersion,
  type AdminApiContext,
} from "@shopify/shopify-app-react-router/server";

import type * as Real from "~/adapters/shopify/shopify.server";

import { fakeServicesUrl, installNetworkGuard } from "./network-guard";

/**
 * The e2e stand-in for `~/adapters/shopify/shopify.server`.
 *
 * `npm run build:e2e` aliases that module to this file (vite.config.ts for
 * the web build, tests/e2e/support/build.ts for the worker), so `build-e2e/`
 * has no Shopify OAuth, no App Bridge session tokens and no Admin API: the
 * signed-in shop is whatever the `e2e_shop` cookie names, and Admin GraphQL is
 * answered by the fake services. The production build never contains this
 * file, which is why there is no runtime switch to leave on by mistake.
 *
 * Refuses to load without E2E_FAKE_SERVICES_URL, and installs the network
 * guard before anything else can run.
 */

installNetworkGuard();

const FAKE = fakeServicesUrl();
const SHOP_COOKIE = "e2e_shop";
const SHOP_PATTERN = /^[a-z0-9-]+\.myshopify\.com$/;

export const API_VERSION = ApiVersion.July26;

function shopFromRequest(request: Request): string {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === SHOP_COOKIE && value && SHOP_PATTERN.test(value)) return value;
  }
  throw new Response(`e2e: no valid ${SHOP_COOKIE} cookie on the request`, {
    status: 401,
  });
}

function onlineSession(shop: string): Session {
  return new Session({
    id: `e2e-online-${shop}`,
    shop,
    state: "e2e",
    isOnline: true,
    accessToken: "e2e-access-token",
    scope: "read_products,write_products",
    onlineAccessInfo: {
      expires_in: 86_400,
      associated_user_scope: "read_products,write_products",
      associated_user: {
        id: 1,
        first_name: "E2E",
        last_name: "Owner",
        email: "owner@e2e.test",
        email_verified: true,
        account_owner: true,
        locale: "en",
        collaborator: false,
      },
    },
  });
}

function offlineSession(shop: string): Session {
  return new Session({
    id: `offline_${shop}`,
    shop,
    state: "e2e",
    isOnline: false,
    accessToken: "e2e-access-token",
    scope: "read_products,write_products",
  });
}

/**
 * Admin GraphQL, answered by the fake services for this shop. Like the real
 * client, a response with top-level `errors` throws; `userErrors` are data.
 */
function fakeAdmin(shop: string): AdminApiContext {
  async function graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<Response> {
    const response = await fetch(`${FAKE}/shopify/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shop,
        query,
        variables: options?.variables ?? {},
      }),
    });
    const text = await response.text();
    const body: unknown = JSON.parse(text);
    if (
      typeof body === "object" &&
      body !== null &&
      "errors" in body &&
      Array.isArray(body.errors) &&
      body.errors.length > 0
    ) {
      throw new Error(`GraphQL Client: ${JSON.stringify(body.errors)}`);
    }
    return new Response(text, {
      headers: { "content-type": "application/json" },
    });
  }

  // The real client is generic over every Admin operation; this one answers
  // whatever the fake services know, and the callers parse with Zod anyway.
  return { graphql } as unknown as AdminApiContext;
}

/**
 * The App Proxy query every e2e proxy request carries. Shopify signs the real
 * one with the app secret; the stand-in accepts exactly this signature, so a
 * spec can also send a request that does not carry it and see the 401.
 */
export const E2E_PROXY_SIGNATURE = "e2e-proxy-ok";

export const authenticate = {
  /**
   * `authenticate.public.appProxy`, which the storefront's /apps/rig routes
   * use. The real one verifies Shopify's HMAC of the query and throws a 400
   * Response when it is wrong; this one checks the fixed signature above.
   */
  public: {
    async appProxy(request: Request): Promise<Record<string, never>> {
      const url = new URL(request.url);
      const shop = url.searchParams.get("shop") ?? "";
      if (
        url.searchParams.get("signature") !== E2E_PROXY_SIGNATURE ||
        !SHOP_PATTERN.test(shop)
      ) {
        throw new Response("e2e: invalid app proxy signature", { status: 400 });
      }
      return {};
    },
  },
  async admin(request: Request) {
    const shop = shopFromRequest(request);
    return { session: onlineSession(shop), admin: fakeAdmin(shop) };
  },
  async webhook(_request: Request): Promise<never> {
    throw new Response("e2e: webhooks are not delivered in the e2e build", {
      status: 401,
    });
  },
};

export const unauthenticated = {
  async admin(shop: string) {
    return { session: offlineSession(shop), admin: fakeAdmin(shop) };
  },
};

/** The login form never submits anywhere in e2e; no errors to show. */
export async function login(_request: Request): Promise<Record<string, never>> {
  return {};
}

export function addDocumentResponseHeaders(
  _request: Request,
  _headers: Headers,
): void {}

export const sessionStorage = null;

const shopify = { authenticate, unauthenticated, login, sessionStorage };
export default shopify;

/*
 * Every export of the real module exists here too, so a new one fails the
 * typecheck instead of failing the e2e build at runtime.
 */
const _sameExports = {
  API_VERSION,
  authenticate,
  unauthenticated,
  login,
  addDocumentResponseHeaders,
  sessionStorage,
  default: shopify,
} satisfies Record<keyof typeof Real, unknown>;
void _sameExports;
