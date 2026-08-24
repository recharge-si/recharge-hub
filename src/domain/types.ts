/**
 * Shared domain vocabulary. Pure types and pure functions only: nothing in
 * `domain/` may import from `adapters/`, `jobs/` or `web/` (CLAUDE.md section 5).
 */

/** A logged-in merchant acting through the embedded admin. */
export interface ShopSession {
  readonly kind: "shop";
  readonly shopDomain: string;
  /**
   * CLAUDE.md section 9 gates the MetaKocka credentials screen to the shop owner.
   * Staff accounts must not read or set the ERP key.
   */
  readonly isShopOwner: boolean;
}

/** A background job. Has no session and no human behind it. */
export interface ServiceToken {
  readonly kind: "service";
  readonly shopDomain: string;
  readonly jobName: string;
}

/**
 * Every call into the service layer carries one of these. Adding a partner portal
 * later means adding a variant here, not rewriting the repositories.
 */
export type Principal = ShopSession | ServiceToken;

export function shopDomainOf(principal: Principal): string {
  return principal.shopDomain;
}

export function isShopOwner(principal: Principal): boolean {
  return principal.kind === "shop" && principal.isShopOwner;
}

export function serviceToken(
  shopDomain: string,
  jobName: string,
): ServiceToken {
  return { kind: "service", shopDomain, jobName };
}
