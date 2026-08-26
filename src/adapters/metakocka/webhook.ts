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

/**
 * The single answer to every request that does not authenticate.
 *
 * The two ways in — no client secret stored for this shop, and a signature
 * that does not verify — used to answer 401 with different bodies, which is
 * enough for anyone to walk the URL space and learn which shops exist here and
 * which of them have finished configuring the webhook. That is not a secret
 * this app has any reason to hand out, and the merchant never sees either
 * body: MetaKocka reports "the endpoint refused it" and the reason for the
 * refusal is in our own log, where it is useful.
 *
 * A function rather than a constant because a `Response` body can only be
 * read once.
 */
export function metakockaWebhookUnauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}
