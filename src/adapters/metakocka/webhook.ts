import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifying a webhook from MetaKocka (CLAUDE.md §3).
 *
 * Different from Shopify's in every detail, so it gets its own module rather
 * than a flag on the Shopify one:
 *
 *  - **HMAC-SHA1**, not SHA-256.
 *  - Signed with the **`client_secret`** from the MetaKocka webhook settings,
 *    which is a different secret from the `secret_key` every API call carries.
 *  - Base64, in the header `X-MetaKocka-Signature`. The event id is in
 *    `X-MetaKocka-Id`.
 *
 * As with Shopify, the signature is checked against the **raw body** before
 * anything is parsed (§2.1.7). A body that has been through `JSON.parse` and
 * back is not the body that was signed — key order and whitespace both move —
 * so the raw text is what reaches this function.
 */

export const METAKOCKA_SIGNATURE_HEADER = "x-metakocka-signature";
export const METAKOCKA_EVENT_HEADER = "x-metakocka-id";

/**
 * The only event MetaKocka pushes.
 *
 * §3: there is no order webhook, no document webhook and no tracking webhook.
 * Everything else this app learns from MetaKocka, it learns by asking.
 */
export const STOCK_EVENT = "warehouse_product_stock_update";

export function signMetakockaBody(rawBody: string, clientSecret: string): string {
  return createHmac("sha1", clientSecret).update(rawBody, "utf8").digest("base64");
}

/**
 * Constant-time comparison, so a wrong signature cannot be narrowed down by
 * timing the rejection.
 */
export function verifyMetakockaSignature(
  rawBody: string,
  signature: string | null,
  clientSecret: string,
): boolean {
  if (!signature) return false;

  const expected = Buffer.from(signMetakockaBody(rawBody, clientSecret));
  const received = Buffer.from(signature);

  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

/**
 * The response body MetaKocka requires.
 *
 * §3: our endpoint **must** return JSON containing
 * `check_respond_status_json_ok: true`. A bare 200 is treated as a failure, and
 * MetaKocka then retries twice, sixty seconds apart, and gives up — which is
 * why the scheduled reconciliation is not optional however well this works.
 */
export const METAKOCKA_ACK = { check_respond_status_json_ok: true } as const;
