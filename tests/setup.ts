import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Tests never reach a live Shopify store or a live MetaKocka company
 * (docs/BUILD_SPEC.md section 12). These values exist only so `getEnv()` validates.
 */
process.env.NODE_ENV = "test";
process.env.SHOPIFY_API_KEY ??= "test-api-key";
process.env.SHOPIFY_API_SECRET ??= "test-api-secret";
process.env.SHOPIFY_APP_URL ??= "https://example.test";
process.env.SCOPES ??= "read_orders";
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
process.env.LOG_LEVEL ??= "silent";

/**
 * A real database connection, when there is one to have.
 *
 * The rule above is about *external services* — Shopify and MetaKocka — and it
 * stands. PostgreSQL is different in kind: it is this application's own storage,
 * it runs locally in Compose, and the guarantees that matter most in this
 * codebase are ones only a real database can demonstrate. A conditional update
 * with a lease either serialises two workers or it does not, and no amount of
 * unit testing the surrounding code can tell you which.
 *
 * So `DATABASE_URL` is taken from `.env` when it is there, and the tests under
 * `tests/db/` skip themselves cleanly when it is not — which is what happens in
 * a checkout with no Compose stack running. Every other test is pure and never
 * opens a connection, because Prisma connects lazily.
 *
 * `TEST_DATABASE_URL` overrides, for pointing the suite at a throwaway database.
 */
function databaseUrl(): string | null {
  // The explicit opt-out, so a CI job with no database — and anyone checking
  // that the skip actually works — can force it rather than hoping.
  if (process.env.SKIP_DB_TESTS === "1") return null;

  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;

  const envFile = resolve(process.cwd(), ".env");
  if (!existsSync(envFile)) return null;

  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = /^\s*DATABASE_URL\s*=\s*(.+?)\s*$/.exec(line);
    if (match) return match[1]!.replace(/^["']|["']$/g, "");
  }
  return null;
}

const url = databaseUrl();
if (url) {
  process.env.DATABASE_URL = url;
  process.env.TEST_DATABASE_AVAILABLE = "1";
} else {
  // Kept so `getEnv()` still validates for the pure tests, and deliberately
  // unreachable so a test that connects by accident fails loudly.
  process.env.DATABASE_URL ??=
    "postgresql://test:test@localhost:5432/test?schema=public";
}
