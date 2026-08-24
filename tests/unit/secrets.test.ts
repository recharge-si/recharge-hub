import { describe, expect, it } from "vitest";

import {
  DecryptionError,
  decryptSecret,
  encryptSecret,
  isEncrypted,
  maskSecret,
  safeEqual,
} from "~/adapters/crypto/secrets.server";

describe("secrets at rest", () => {
  it("round-trips a value", () => {
    const plaintext = "shpat_0123456789abcdef";
    expect(decryptSecret(encryptSecret(plaintext))).toBe(plaintext);
  });

  it("round-trips a MetaKocka secret key containing non-ascii characters", () => {
    const plaintext = "ključ-€-ščž";
    expect(decryptSecret(encryptSecret(plaintext))).toBe(plaintext);
  });

  it("produces a different ciphertext each time", () => {
    const plaintext = "same-input";
    expect(encryptSecret(plaintext)).not.toBe(encryptSecret(plaintext));
  });

  it("never leaks the plaintext into the ciphertext", () => {
    expect(encryptSecret("hunter2")).not.toContain("hunter2");
  });

  it("rejects a tampered ciphertext rather than returning garbage", () => {
    const sealed = encryptSecret("original");
    const parts = sealed.split(".");
    const body = Buffer.from(parts[3]!, "base64url");
    body[0] = body[0]! ^ 0xff;
    parts[3] = body.toString("base64url");

    expect(() => decryptSecret(parts.join("."))).toThrow(DecryptionError);
  });

  it("rejects a malformed payload", () => {
    expect(() => decryptSecret("not-a-ciphertext")).toThrow(DecryptionError);
  });

  it("rejects an unknown ciphertext version", () => {
    const sealed = encryptSecret("original");
    const parts = sealed.split(".");
    parts[0] = "v2";

    expect(() => decryptSecret(parts.join("."))).toThrow(/version/);
  });

  it("recognises its own output", () => {
    expect(isEncrypted(encryptSecret("value"))).toBe(true);
    expect(isEncrypted("plaintext-token")).toBe(false);
  });

  it("masks a saved secret down to its last four characters", () => {
    // CLAUDE.md section 10: once saved, a key never goes back to the browser.
    expect(maskSecret("abcdefgh1234")).toBe("••••1234");
  });

  it("compares equal-length values without leaking length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
