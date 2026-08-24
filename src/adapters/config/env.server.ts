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

  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().default("development"),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
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
