import { prisma } from "~/adapters/db/client.server";
import {
  decryptSecret,
  encryptSecret,
  maskSecret,
} from "~/adapters/crypto/secrets.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { isShopOwner, shopDomainOf, type Principal } from "~/domain/types";

/**
 * The MetaKocka secret key grants full write access to the merchant's ERP
 * (CLAUDE.md section 3). Two rules are enforced here rather than in route code:
 *
 *  - Only the shop owner, or a background job, may read or write it
 *    (section 9). A staff account gets a thrown error, not an empty form.
 *  - The plaintext key never leaves this module towards the browser
 *    (section 10). Screens get `CredentialSummary`, which carries a mask.
 */

export class NotPermittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotPermittedError";
  }
}

function assertMayHandleSecrets(principal: Principal, action: string): void {
  // Background jobs have no session and are trusted by construction.
  if (principal.kind === "service") return;
  if (isShopOwner(principal)) return;

  throw new NotPermittedError(
    `Only the store owner can ${action} the MetaKocka connection.`,
  );
}

/** Safe to send to the browser. */
export interface CredentialSummary {
  connected: boolean;
  companyId: string | null;
  secretKeyMask: string | null;
  webhookSecretSet: boolean;
  lastVerifiedAt: Date | null;
}

/** Server-side only. Never returned from a loader. */
export interface DecryptedCredential {
  companyId: string;
  secretKey: string;
  webhookClientSecret: string | null;
  lastVerifiedAt: Date | null;
}

export async function getCredentialSummary(
  principal: Principal,
): Promise<CredentialSummary> {
  const row = await prisma.metakockaCredential.findFirst({
    where: { shop: { domain: shopDomainOf(principal) } },
  });

  if (!row) {
    return {
      connected: false,
      companyId: null,
      secretKeyMask: null,
      webhookSecretSet: false,
      lastVerifiedAt: null,
    };
  }

  // The mask needs the last four characters, so the value is decrypted and
  // immediately reduced. Nothing else about it is exposed.
  let mask: string | null = null;
  try {
    mask = maskSecret(decryptSecret(row.secretKeyEncrypted));
  } catch (error) {
    getLogger().error(
      { err: error, shop: shopDomainOf(principal) },
      "Stored MetaKocka secret key could not be decrypted",
    );
  }

  return {
    connected: true,
    companyId: row.companyId,
    secretKeyMask: mask,
    webhookSecretSet: row.webhookClientSecretEncrypted !== null,
    lastVerifiedAt: row.lastVerifiedAt,
  };
}

export async function getCredential(
  principal: Principal,
): Promise<DecryptedCredential | null> {
  assertMayHandleSecrets(principal, "use");

  const row = await prisma.metakockaCredential.findFirst({
    where: { shop: { domain: shopDomainOf(principal) } },
  });
  if (!row) return null;

  return {
    companyId: row.companyId,
    secretKey: decryptSecret(row.secretKeyEncrypted),
    webhookClientSecret: row.webhookClientSecretEncrypted
      ? decryptSecret(row.webhookClientSecretEncrypted)
      : null,
    lastVerifiedAt: row.lastVerifiedAt,
  };
}

export interface SaveCredentialInput {
  companyId: string;
  /** Omit to keep the stored key: the form shows a mask, not the real value. */
  secretKey?: string;
  webhookClientSecret?: string;
}

export async function saveCredential(
  principal: Principal,
  input: SaveCredentialInput,
): Promise<void> {
  assertMayHandleSecrets(principal, "change");

  const domain = shopDomainOf(principal);
  const shop = await prisma.shop.findUnique({
    where: { domain },
    select: { id: true },
  });
  if (!shop) throw new Error(`No shop record for ${domain}`);

  const existing = await prisma.metakockaCredential.findUnique({
    where: { shopId: shop.id },
  });

  if (!existing && !input.secretKey) {
    throw new Error("A secret key is required to connect MetaKocka.");
  }

  const secretKeyEncrypted = input.secretKey
    ? encryptSecret(input.secretKey)
    : existing!.secretKeyEncrypted;

  const webhookClientSecretEncrypted = input.webhookClientSecret
    ? encryptSecret(input.webhookClientSecret)
    : (existing?.webhookClientSecretEncrypted ?? null);

  await prisma.metakockaCredential.upsert({
    where: { shopId: shop.id },
    create: {
      shopId: shop.id,
      companyId: input.companyId,
      secretKeyEncrypted,
      webhookClientSecretEncrypted,
    },
    update: {
      companyId: input.companyId,
      secretKeyEncrypted,
      webhookClientSecretEncrypted,
      // Credentials changed, so the previous verification no longer proves
      // anything about the ones now stored.
      ...(input.secretKey || existing?.companyId !== input.companyId
        ? { lastVerifiedAt: null }
        : {}),
    },
  });
}

export async function markVerified(principal: Principal): Promise<void> {
  await prisma.metakockaCredential.updateMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    data: { lastVerifiedAt: new Date() },
  });
}

/**
 * CLAUDE.md section 2.7: the connection can be disconnected from inside Shopify
 * at any time. This deletes the credentials outright rather than flagging them
 * disabled, so a disconnected shop holds no ERP key.
 */
export async function disconnect(principal: Principal): Promise<void> {
  assertMayHandleSecrets(principal, "disconnect");

  await prisma.metakockaCredential.deleteMany({
    where: { shop: { domain: shopDomainOf(principal) } },
  });

  getLogger().info(
    { shop: shopDomainOf(principal) },
    "MetaKocka connection removed",
  );
}
