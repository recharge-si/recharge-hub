/**
 * Who may handle the MetaKocka connection (docs/BUILD_SPEC.md section 9).
 *
 * The ERP key gives full write access to the merchant's ERP, so reading,
 * replacing or disconnecting it is closed to ordinary staff. A staff user is an
 * ERP admin when Shopify says they are the store owner, or when their email is
 * on the deployment's `ERP_ADMIN_EMAILS` allowlist. The allowlist exists
 * because the people who run the store are organization administrators, not
 * the store owner, and Shopify reports no organization role to apps.
 *
 * Pure: the caller supplies the allowlist and the Shopify user.
 */

/** The parts of Shopify's `OnlineAccessUser` the decision reads. */
export interface StaffUser {
  readonly email?: string | null;
  readonly account_owner?: boolean | null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * `ERP_ADMIN_EMAILS` as a list: comma separated, each entry trimmed and
 * lower-cased, blanks dropped. Unset or blank is an empty list, which leaves
 * only the store owner as an ERP admin.
 */
export function parseErpAdminEmails(
  raw: string | null | undefined,
): readonly string[] {
  if (!raw) return [];
  const emails = raw
    .split(",")
    .map(normalizeEmail)
    .filter((email) => email !== "");
  return [...new Set(emails)];
}

/**
 * Whether this staff user may view and change the MetaKocka connection.
 *
 * No user (an offline session, or Shopify did not say) is never an admin, and
 * neither is a user without an email: an empty allowlist or an empty email
 * closes the screen rather than opening it.
 */
export function isErpAdminUser(
  user: StaffUser | null | undefined,
  allowlist: readonly string[],
): boolean {
  if (!user) return false;
  if (user.account_owner === true) return true;

  const email = user.email ? normalizeEmail(user.email) : "";
  if (email === "") return false;
  return allowlist.some((entry) => normalizeEmail(entry) === email);
}
