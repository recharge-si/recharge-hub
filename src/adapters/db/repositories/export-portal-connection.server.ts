import { prisma } from "~/adapters/db/client.server";
import {
  decryptSecret,
  encryptSecret,
  maskSecret,
} from "~/adapters/crypto/secrets.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { isErpAdmin, shopDomainOf, type Principal } from "~/domain/types";

/**
 * The store's export portal API key (docs/sources.md § Connection).
 *
 * The same two rules as the MetaKocka credential, for the same reasons:
 * the key is written and removed by an ERP admin (or a job), and its
 * plaintext never leaves this module towards the browser — screens get
 * `ExportPortalConnectionSummary`, which carries a mask.
 *
 * Reading the key to *use* it is open to any signed-in staff member, unlike
 * the ERP key. Configuring an export is day-to-day work, the key is only
 * ever used server-side, and the portal itself decides what the key may do.
 */

export class ExportPortalNotPermittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportPortalNotPermittedError";
  }
}

function assertMayChange(principal: Principal, action: string): void {
  if (principal.kind === "service") return;
  if (isErpAdmin(principal)) return;
  throw new ExportPortalNotPermittedError(
    `Only ERP admins can ${action} the export portal connection.`,
  );
}

/** Safe to send to the browser. */
export interface ExportPortalConnectionSummary {
  connected: boolean;
  apiKeyMask: string | null;
  tenantId: string | null;
  tenantName: string | null;
  lastVerifiedAt: string | null;
  connectedAt: string | null;
}

export async function getExportPortalSummary(
  principal: Principal,
): Promise<ExportPortalConnectionSummary> {
  const row = await prisma.exportPortalConnection.findFirst({
    where: { shop: { domain: shopDomainOf(principal) } },
  });
  if (!row) {
    return {
      connected: false,
      apiKeyMask: null,
      tenantId: null,
      tenantName: null,
      lastVerifiedAt: null,
      connectedAt: null,
    };
  }

  let mask: string | null = null;
  try {
    mask = maskSecret(decryptSecret(row.apiKeyEncrypted));
  } catch (error) {
    getLogger().error(
      { err: error, shop: shopDomainOf(principal) },
      "Stored export portal API key could not be decrypted",
    );
  }

  return {
    connected: true,
    apiKeyMask: mask,
    tenantId: row.tenantId,
    tenantName: row.tenantName,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    connectedAt: row.createdAt.toISOString(),
  };
}

/** Server-side only. Never returned from a loader. */
export async function getExportPortalApiKey(
  principal: Principal,
): Promise<string | null> {
  const row = await prisma.exportPortalConnection.findFirst({
    where: { shop: { domain: shopDomainOf(principal) } },
    select: { apiKeyEncrypted: true },
  });
  return row ? decryptSecret(row.apiKeyEncrypted) : null;
}

export async function saveExportPortalApiKey(
  principal: Principal,
  apiKey: string,
): Promise<void> {
  assertMayChange(principal, "change");
  const domain = shopDomainOf(principal);
  const shop = await prisma.shop.findUnique({
    where: { domain },
    select: { id: true },
  });
  if (!shop) throw new Error(`No shop record for ${domain}`);

  const apiKeyEncrypted = encryptSecret(apiKey);
  await prisma.exportPortalConnection.upsert({
    where: { shopId: shop.id },
    create: { shopId: shop.id, apiKeyEncrypted },
    // A new key proves nothing about the tenant the old one belonged to.
    update: {
      apiKeyEncrypted,
      tenantId: null,
      tenantName: null,
      lastVerifiedAt: null,
    },
  });
}

/** Recorded after any call the portal answered: who the key is, and when. */
export async function markExportPortalVerified(
  principal: Principal,
  tenant: { id: string; name: string },
): Promise<void> {
  await prisma.exportPortalConnection.updateMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    data: {
      tenantId: tenant.id,
      tenantName: tenant.name,
      lastVerifiedAt: new Date(),
    },
  });
}

/**
 * Forget the key. Only the key: the sources live in the portal and are
 * untouched, and nothing else in this app derives from the connection, so
 * — unlike MetaKocka — there is nothing else to erase.
 */
export async function disconnectExportPortal(
  principal: Principal,
): Promise<boolean> {
  assertMayChange(principal, "disconnect");
  const result = await prisma.exportPortalConnection.deleteMany({
    where: { shop: { domain: shopDomainOf(principal) } },
  });
  return result.count > 0;
}
