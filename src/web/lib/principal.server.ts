import type { Session } from "@shopify/shopify-api";

import { getEnv } from "~/adapters/config/env.server";
import { isErpAdminUser } from "~/domain/erp-admin";
import type { ShopSession } from "~/domain/types";

/**
 * Turns a Shopify session into the Principal the service layer expects
 * (CLAUDE.md section 9).
 *
 * `associated_user` only exists on an online session, which is why
 * `useOnlineTokens` is enabled in shopify.server.ts. A staff user is an ERP
 * admin when Shopify says they are the store owner or when their email is on
 * `ERP_ADMIN_EMAILS` (`domain/erp-admin`). When the user is missing, or the
 * allowlist is unset and they are not the owner, they are not an admin: a
 * screen that guards the ERP key defaults to closed, never to open.
 *
 * `allowlist` is a parameter for tests; routes use the environment's.
 */
export function principalFromSession(
  session: Session,
  allowlist: readonly string[] = getEnv().ERP_ADMIN_EMAILS,
): ShopSession {
  return {
    kind: "shop",
    shopDomain: session.shop,
    isErpAdmin: isErpAdminUser(
      session.onlineAccessInfo?.associated_user,
      allowlist,
    ),
  };
}

/**
 * Whether Shopify actually told us who the user is.
 *
 * This separates "we know you are not an ERP admin" from "we could not tell",
 * so the settings screen can explain itself instead of silently showing an
 * empty page. The two cases look identical in `isErpAdmin` and should not look
 * identical to the merchant.
 */
export function isUserKnown(session: Session): boolean {
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
