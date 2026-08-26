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

/**
 * A deterministic string order, for anything a decision depends on.
 *
 * `localeCompare` is not this. It answers by the runtime's collation rules,
 * which differ between Node builds, ICU data versions and the host's locale —
 * so two servers running the same code can disagree about which supply source
 * comes first. In `domain/` that is not a cosmetic difference: it decides
 * which source fills a line and which MetaKocka document carries the shipping
 * charge, and a retry that lands on the other machine moves the money.
 *
 * Codepoint order is arbitrary but it is the same everywhere and forever,
 * which is the only property the tie-breaks need. Display sorting, where a
 * person is reading the list, is a different question and still belongs to
 * `localeCompare`.
 */
export function compareCodepoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
