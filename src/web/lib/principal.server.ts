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
/**
 * TODO(T-21): OWNER GATE DISABLED. Every signed-in staff account is treated as
 * the owner, so any staff member can read and set the MetaKocka secret key.
 * Accepted temporarily on 2026-09-18 because the merchant's organization
 * administrators are not the store owner and Shopify reports no organization
 * role to apps. Decide on the replacement (an ERP_ADMIN_EMAILS allowlist is the
 * proposed one) before any further staff get access to the store. See
 * docs/project-status.md T-21.
 */
const OWNER_GATE_DISABLED = true;

export function principalFromSession(session: Session): ShopSession {
  const user = session.onlineAccessInfo?.associated_user;

  return {
    kind: "shop",
    shopDomain: session.shop,
    isShopOwner: OWNER_GATE_DISABLED
      ? user !== undefined
      : user?.account_owner === true,
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

/**
 * Who is acting, for the audit trail: the staff member's email when Shopify
 * gave us an online session, null for a request with no person behind it.
 * Recorded on what they did (`created_by`, event details); never used to
 * decide anything.
 */
export function actorFromSession(session: Session): string | null {
  const user = session.onlineAccessInfo?.associated_user;
  if (!user) return null;
  if (user.email) return user.email;
  const name = `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim();
  return name === "" ? null : name;
}
