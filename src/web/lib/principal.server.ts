import type { Session } from "@shopify/shopify-api";

import type { ShopSession } from "~/domain/types";

/**
 * Turns a Shopify session into the Principal the service layer expects
 * (CLAUDE.md section 9).
 *
 * `account_owner` only exists on an online session, which is why
 * `useOnlineTokens` is enabled in shopify.server.ts. When it is missing we treat
 * the user as not the owner: a screen that guards the ERP key defaults to
 * closed, never to open.
 */
export function principalFromSession(session: Session): ShopSession {
  return {
    kind: "shop",
    shopDomain: session.shop,
    isShopOwner:
      session.onlineAccessInfo?.associated_user?.account_owner === true,
  };
}

/**
 * Whether Shopify actually told us who the user is.
 *
 * This separates "we know you are not the owner" from "we could not tell", so
 * the settings screen can explain itself instead of silently showing an empty
 * page. The two cases look identical in `isShopOwner` and should not look
 * identical to the merchant.
 */
export function isOwnershipKnown(session: Session): boolean {
  return session.onlineAccessInfo?.associated_user !== undefined;
}
