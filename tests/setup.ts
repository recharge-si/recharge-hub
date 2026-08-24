import { randomBytes } from "node:crypto";

/**
 * Tests never reach a live Shopify store or a live MetaKocka company
 * (CLAUDE.md section 12). These values exist only so `getEnv()` validates.
 */
process.env.NODE_ENV = "test";
process.env.SHOPIFY_API_KEY ??= "test-api-key";
process.env.SHOPIFY_API_SECRET ??= "test-api-secret";
process.env.SHOPIFY_APP_URL ??= "https://example.test";
process.env.SCOPES ??= "read_orders";
process.env.DATABASE_URL ??=
  "postgresql://test:test@localhost:5432/test?schema=public";
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
process.env.LOG_LEVEL ??= "silent";
