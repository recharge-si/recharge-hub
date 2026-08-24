import type { PrismaClient } from "@prisma/client";
import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";

import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
} from "~/adapters/crypto/secrets.server";
import { getLogger } from "~/adapters/observability/logger.server";

/**
 * CLAUDE.md section 2.2 requires offline tokens encrypted at rest, and
 * PrismaSessionStorage stores them in plaintext. This decorator encrypts the two
 * secret-bearing columns on the way in and decrypts them on the way out; nothing
 * else about the session shape changes.
 */
export class EncryptedSessionStorage implements SessionStorage {
  private readonly inner: SessionStorage;

  constructor(prisma: PrismaClient) {
    this.inner = new PrismaSessionStorage(prisma);
  }

  async storeSession(session: Session): Promise<boolean> {
    return this.inner.storeSession(seal(session));
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const session = await this.inner.loadSession(id);
    return session ? open(session) : undefined;
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.inner.deleteSession(id);
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    return this.inner.deleteSessions(ids);
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const sessions = await this.inner.findSessionsByShop(shop);
    return sessions.map(open);
  }
}

/** Encrypt the secret-bearing fields. Idempotent. */
export function seal(session: Session): Session {
  const params = session.toObject();

  return new Session({
    ...params,
    ...(params.accessToken && !isEncrypted(params.accessToken)
      ? { accessToken: encryptSecret(params.accessToken) }
      : {}),
    ...(params.refreshToken && !isEncrypted(params.refreshToken)
      ? { refreshToken: encryptSecret(params.refreshToken) }
      : {}),
  });
}

/**
 * Decrypt the secret-bearing fields.
 *
 * Two failure modes, both deliberate:
 *
 * A value that is not in our ciphertext format is passed through unchanged. That
 * is a row written before encryption was switched on, and refusing it would lock
 * the merchant out of their own app.
 *
 * A value that is ours but fails authentication -- a changed master key, a
 * corrupted column -- is dropped, loudly. A token we cannot decrypt is worth
 * exactly as much as no token: token exchange mints a fresh one on the next
 * admin request, so the app heals itself. Throwing instead would wedge the shop
 * permanently, including its own `shop/redact`, which is the one request that
 * must never be blocked.
 */
export function open(session: Session): Session {
  const params = session.toObject();
  const fields: { accessToken?: string; refreshToken?: string } = {};

  for (const field of ["accessToken", "refreshToken"] as const) {
    const value = params[field];
    if (!value) continue;

    if (!isEncrypted(value)) {
      getLogger().warn(
        { shop: params.shop, field },
        "Session field is not encrypted at rest. It will be encrypted on the next write.",
      );
      continue;
    }

    try {
      fields[field] = decryptSecret(value);
    } catch (error) {
      getLogger().error(
        { err: error, shop: params.shop, field },
        "Session field could not be decrypted and was discarded. The shop must re-authenticate.",
      );
      fields[field] = undefined;
    }
  }

  return new Session({ ...params, ...fields });
}
