import "@shopify/shopify-app-react-router/adapters/node";

import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";

import { getEnv } from "~/adapters/config/env.server";
import { prisma } from "~/adapters/db/client.server";
import { EncryptedSessionStorage } from "~/adapters/db/encrypted-session-storage.server";
import { markInstalled } from "~/adapters/db/repositories/shop.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { serviceToken } from "~/domain/types";

const env = getEnv();

/**
 * CLAUDE.md section 2.1: latest stable Admin API version, GraphQL only.
 * Bump this and `[webhooks] api_version` in shopify.app.toml together.
 */
export const API_VERSION = ApiVersion.July26;

const shopify = shopifyApp({
  apiKey: env.SHOPIFY_API_KEY,
  apiSecretKey: env.SHOPIFY_API_SECRET,
  apiVersion: API_VERSION,
  scopes: env.SCOPES.split(",").map((scope) => scope.trim()),
  appUrl: env.SHOPIFY_APP_URL,
  authPathPrefix: "/auth",
  sessionStorage: new EncryptedSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  // CLAUDE.md section 9 gates the MetaKocka credentials screen to the shop
  // owner, and `associated_user.account_owner` is the only place Shopify
  // reports that. It arrives on an online session, so embedded requests ask for
  // one in addition to the offline token that background jobs use.
  useOnlineTokens: true,
  future: {
    // Token exchange with App Bridge ID tokens (CLAUDE.md section 2.2). There is
    // deliberately no legacy OAuth redirect flow in this app.
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    afterAuth: async ({ session }) => {
      const principal = serviceToken(session.shop, "afterAuth");

      await markInstalled(principal);
      await appendEvent(principal, {
        entityType: "shop",
        entityId: session.shop,
        event: "app.installed",
        detail: { scope: session.scope ?? null },
      });

      getLogger().info({ shop: session.shop }, "App installed");
    },
  },
  ...(env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const sessionStorage = shopify.sessionStorage;
