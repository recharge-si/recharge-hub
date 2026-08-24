import { pino, type Logger } from "pino";

import { getEnv } from "~/adapters/config/env.server";

/**
 * Structured JSON logs with a redaction list (CLAUDE.md sections 4 and 10).
 * Never log tokens, HMACs, shop-scoped secrets, or customer PII.
 *
 * Redaction is a backstop, not a licence to pass secrets to the logger. If a new
 * field carries a secret or PII, add it here in the same commit that introduces it.
 */
const REDACTED_PATHS = [
  // Shopify
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "*.accessToken",
  "*.access_token",
  "req.headers.authorization",
  'req.headers["x-shopify-hmac-sha256"]',
  'req.headers["x-metakocka-signature"]',

  // MetaKocka
  "secret_key",
  "client_secret",
  "*.secret_key",
  "*.client_secret",

  // Customer PII (CLAUDE.md section 2.4)
  "email",
  "phone",
  "first_name",
  "last_name",
  "address1",
  "address2",
  "zip",
  "*.email",
  "*.phone",
  "*.first_name",
  "*.last_name",
  "*.address1",
  "*.address2",
  "*.zip",
  "customer",
  "shipping_address",
  "billing_address",
];

function build(): Logger {
  const env = getEnv();

  return pino({
    level: env.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    base: { env: env.NODE_ENV },
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(env.NODE_ENV === "development"
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
          },
        }
      : {}),
  });
}

let cached: Logger | undefined;

export function getLogger(): Logger {
  cached ??= build();
  return cached;
}

/** A logger bound to one shop, so every line carries the tenant. */
export function shopLogger(shopDomain: string): Logger {
  return getLogger().child({ shop: shopDomain });
}
