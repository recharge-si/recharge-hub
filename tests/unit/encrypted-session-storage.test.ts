import { Session } from "@shopify/shopify-api";
import { describe, expect, it } from "vitest";

import { isEncrypted } from "~/adapters/crypto/secrets.server";
import { open, seal } from "~/adapters/db/encrypted-session-storage.server";

function makeSession(
  overrides: Partial<ConstructorParameters<typeof Session>[0]> = {},
) {
  return new Session({
    id: "offline_test-store.myshopify.com",
    shop: "test-store.myshopify.com",
    state: "",
    isOnline: false,
    scope: "read_orders",
    accessToken: "shpat_plaintext_token",
    ...overrides,
  });
}

describe("offline tokens at rest", () => {
  it("encrypts the access token before it reaches the database", () => {
    const sealed = seal(makeSession());

    expect(sealed.accessToken).not.toBe("shpat_plaintext_token");
    expect(isEncrypted(sealed.accessToken!)).toBe(true);
  });

  it("encrypts the refresh token as well", () => {
    const sealed = seal(makeSession({ refreshToken: "refresh_plaintext" }));

    expect(isEncrypted(sealed.refreshToken!)).toBe(true);
  });

  it("returns the original token on the way back out", () => {
    const session = makeSession({ refreshToken: "refresh_plaintext" });
    const restored = open(seal(session));

    expect(restored.accessToken).toBe("shpat_plaintext_token");
    expect(restored.refreshToken).toBe("refresh_plaintext");
  });

  it("preserves every other session field", () => {
    const session = makeSession({ scope: "read_orders,write_products" });
    const restored = open(seal(session));

    expect(restored.id).toBe(session.id);
    expect(restored.shop).toBe(session.shop);
    expect(restored.scope).toBe("read_orders,write_products");
    expect(restored.isOnline).toBe(false);
  });

  it("is idempotent, so a re-store never double-encrypts", () => {
    const once = seal(makeSession());
    const twice = seal(once);

    expect(twice.accessToken).toBe(once.accessToken);
    expect(open(twice).accessToken).toBe("shpat_plaintext_token");
  });

  it("passes through a row written before encryption was switched on", () => {
    // Refusing it would lock the merchant out of their own app.
    const legacy = makeSession();
    expect(open(legacy).accessToken).toBe("shpat_plaintext_token");
  });

  it("discards a token it cannot decrypt instead of throwing", () => {
    // A wedged session would block the shop's own shop/redact. Token exchange
    // mints a fresh token on the next admin request.
    const corrupt = makeSession({ accessToken: "v1.aaa.bbb.ccc" });

    const restored = open(corrupt);

    expect(restored.accessToken).toBeUndefined();
    expect(restored.shop).toBe("test-store.myshopify.com");
  });

  it("discards a token encrypted under a different master key", () => {
    const sealed = seal(makeSession());
    const parts = sealed.accessToken!.split(".");
    const body = Buffer.from(parts[3]!, "base64url");
    body[0] = body[0]! ^ 0xff;
    parts[3] = body.toString("base64url");

    const tampered = makeSession({ accessToken: parts.join(".") });

    expect(open(tampered).accessToken).toBeUndefined();
  });
});
