import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { getEnv } from "~/adapters/config/env.server";

/**
 * AES-256-GCM at rest for everything CLAUDE.md section 10 calls a secret:
 * Shopify offline tokens, the MetaKocka secret_key, the MetaKocka webhook
 * client_secret, and customer PII columns.
 *
 * Ciphertext format: `v1.<iv>.<authTag>.<ciphertext>`, each part base64url.
 * The version prefix exists so a future key rotation can be told apart from a
 * value written by this scheme.
 */
const VERSION = "v1";
const IV_BYTES = 12;
const ALGORITHM = "aes-256-gcm";

function masterKey(): Buffer {
  return Buffer.from(getEnv().ENCRYPTION_KEY, "base64");
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export class DecryptionError extends Error {
  constructor(message: string) {
    // Never include the payload: it would put ciphertext in the logs.
    super(message);
    this.name = "DecryptionError";
  }
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4) {
    throw new DecryptionError("Encrypted value is malformed");
  }

  const [version, iv, authTag, ciphertext] = parts as [
    string,
    string,
    string,
    string,
  ];

  if (version !== VERSION) {
    throw new DecryptionError(`Unsupported ciphertext version "${version}"`);
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      masterKey(),
      Buffer.from(iv, "base64url"),
    );
    // A malformed tag throws here rather than at final(), so both are inside the
    // catch: every failure leaves this function as a DecryptionError.
    decipher.setAuthTag(Buffer.from(authTag, "base64url"));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new DecryptionError(
      "Encrypted value failed authentication. The ENCRYPTION_KEY may have changed.",
    );
  }
}

/** True when the value was produced by `encryptSecret`. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(`${VERSION}.`) && value.split(".").length === 4;
}

/** Constant-time comparison, for anything secret-shaped. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** What a saved secret looks like once it goes back to the browser. */
export function maskSecret(plaintext: string): string {
  const tail = plaintext.slice(-4);
  return `••••${tail}`;
}
