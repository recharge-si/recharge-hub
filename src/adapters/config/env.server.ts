import { z } from "zod";

/**
 * Every external boundary is parsed with Zod (CLAUDE.md section 4), and the process
 * environment is a boundary. Reading `process.env` directly anywhere else is a bug:
 * import `env` from here instead.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  SHOPIFY_API_KEY: z.string().min(1, "SHOPIFY_API_KEY is required"),
  SHOPIFY_API_SECRET: z.string().min(1, "SHOPIFY_API_SECRET is required"),
  SHOPIFY_APP_URL: z.string().url("SHOPIFY_APP_URL must be an absolute URL"),
  SCOPES: z.string().min(1, "SCOPES is required"),
  SHOP_CUSTOM_DOMAIN: z.string().optional(),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // 32 raw bytes, base64 encoded. AES-256-GCM (CLAUDE.md section 10).
  ENCRYPTION_KEY: z
    .string()
    .min(1, "ENCRYPTION_KEY is required")
    .refine(
      (value) => Buffer.from(value, "base64").length === 32,
      "ENCRYPTION_KEY must be 32 bytes, base64 encoded. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    ),

  /**
   * The one OpenAI key this deployment translates with (docs/translations.md
   * § OpenAI). Server-side only: never sent to the browser, never stored, never
   * logged. Optional, so a deployment without it still runs — the Translations
   * pages say that AI translation is not configured and every other feature
   * works.
   */
  OPENAI_API_KEY: z.string().optional(),
  // `.env.example` ships the variable blank, and a blank means the default.
  OPENAI_TRANSLATION_MODEL: z
    .string()
    .optional()
    .transform((value) =>
      value && value.trim() !== "" ? value.trim() : "gpt-4.1-mini",
    ),

  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().default("development"),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Outside production, fill in anything the parent process did not supply from
 * `.env`.
 *
 * The Shopify CLI injects SHOPIFY_API_KEY, SHOPIFY_API_SECRET and
 * SHOPIFY_APP_URL into the dev server itself, but nothing injects DATABASE_URL
 * or ENCRYPTION_KEY. `process.loadEnvFile` does not overwrite variables that
 * already exist, so the CLI's values always win over the placeholders in `.env`.
 *
 * In production the environment comes from Compose, and `.env` is not shipped
 * in the image.
 */
function loadDotEnv(): void {
  if (process.env.NODE_ENV === "production") return;

  try {
    process.loadEnvFile();
  } catch {
    // No .env file. Fine: everything may already be in the environment, and if
    // it is not, the schema below reports exactly what is missing.
  }
}

function loadEnv(): Env {
  loadDotEnv();

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration.\n${problems}\n\nSee .env.example.`,
    );
  }

  return parsed.data;
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}
