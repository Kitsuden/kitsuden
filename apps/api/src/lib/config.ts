/**
 * Kitsuden - Centralized Configuration
 *
 * Type-safe configuration management with validation
 * and environment-based defaults.
 */

import { z } from "zod";

import { rawNodeEnv } from "./environment";
import { placeholderSecrets, publicOrProduction } from "./placeholder-secrets";
import { secretsKeyStatus } from "./secrets-key";

// Environment schema validation
//
// `prefault`, not `default`: since zod 4 a `default` is returned as is, without
// going through `.transform()`, so `RATE_LIMIT_ENABLED` arrived as the string
// "true" and `ALLOWED_ORIGINS` was never split. `prefault` parses the fallback
// like any input, the way zod 3 handled `default`.
const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(["development", "production", "test"]).prefault("development"),
  PORT: z.string().transform(Number).prefault("3001"),

  // Database
  DATABASE_URL: z.string().min(1),

  // Redis/Valkey
  REDIS_URL: z.string().prefault("redis://localhost:6379"),

  // Storage (S3/MinIO)
  S3_ENDPOINT: z.string().prefault("http://localhost:9000"),
  S3_BUCKET: z.string().prefault("kitsuden-media"),
  // Only needed with DEFAULT_STORAGE_PROVIDER=s3|minio (`storage.ts` requires them there); with
  // local storage, the API must not refuse to start for lacking them.
  S3_ACCESS_KEY: ["s3", "minio"].includes(
    (process.env.DEFAULT_STORAGE_PROVIDER || "local").toLowerCase()
  )
    ? z.string().min(1)
    : z.string().prefault(""),
  S3_SECRET_KEY: ["s3", "minio"].includes(
    (process.env.DEFAULT_STORAGE_PROVIDER || "local").toLowerCase()
  )
    ? z.string().min(1)
    : z.string().prefault(""),
  S3_PUBLIC_URL: z.string().prefault("http://localhost:9000"),
  S3_REGION: z.string().prefault("us-east-1"),

  // Auth — No default in any environment; must be explicitly set.
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().prefault("http://localhost:3001"),

  // URLs
  ADMIN_URL: z.string().prefault("http://localhost:5173"),
  WEB_URL: z.string().prefault("http://localhost:4321"),

  // Security
  ALLOWED_ORIGINS: z
    .string()
    .transform((s) => s.split(","))
    .prefault("http://localhost:3001,http://localhost:5173"),

  // Rate Limiting
  RATE_LIMIT_ENABLED: z
    .string()
    .transform((s) => s === "true")
    .prefault("true"),
  RATE_LIMIT_WINDOW_MS: z.string().transform(Number).prefault("900000"), // 15 minutes
  RATE_LIMIT_MAX_REQUESTS: z.string().transform(Number).prefault("100"),
  RATE_LIMIT_AUTH_MAX: z.string().transform(Number).prefault("20"),

  // Logging
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).prefault("info"),

  // ═══════════════════════════════════════════════════════════════════
  // LLM Providers (Agents Engine)
  // ═══════════════════════════════════════════════════════════════════
  // At least one must be configured for the Agent Engine to work.
  // Default priority: OpenAI > Anthropic > DeepSeek > Ollama.
  KITSUDEN_LLM_PROVIDER: z.enum(["openai", "anthropic", "deepseek", "ollama"]).optional(),
  KITSUDEN_LLM_MODEL: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),

  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_MODEL: z.string().optional(),

  OLLAMA_BASE_URL: z.string().prefault("http://localhost:11434"),
  OLLAMA_MODEL: z.string().prefault("llama3.2"),

  // Features
  ENABLE_SWAGGER: z
    .string()
    .transform((s) => s === "true")
    .prefault("true"),
  ENABLE_MCP: z
    .string()
    .transform((s) => s === "true")
    .prefault("true"),
  HEADLESS: z
    .string()
    .transform((s) => s === "true")
    .prefault("false"),
});

// Parse and validate environment
function loadConfig() {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
      console.error(
        `\nConfiguration validation failed (NODE_ENV=${rawNodeEnv() || "undefined"}):\n${issues}\n`
      );
      console.error(
        "HINT: BETTER_AUTH_SECRET must be explicitly set in your .env (min 32 chars).\n" +
          "Generate one with: openssl rand -base64 48\n"
      );
      process.exit(1);
    }
    throw error;
  }
}

/**
 * A secret copied as is from an example file is public: with the published
 * `BETTER_AUTH_SECRET`, anyone can sign an admin session cookie. Length does not
 * catch it (`<GENERATE_A_SECURE_SECRET_MIN_32_CHARS>` has 39 characters).
 * Refused in production and public mode; local setups must keep booting.
 */
function checkPlaceholderSecrets(): void {
  const names = placeholderSecrets(process.env);
  if (names.length === 0) return;
  const message = `${names.join(", ")} still ${names.length === 1 ? "holds" : "hold"} a placeholder from an example file. Generate a real value with: openssl rand -base64 48`;
  if (publicOrProduction(process.env)) {
    console.error(`\nConfiguration validation failed: ${message}\n`);
    process.exit(1);
  }
  console.warn(
    `\n⚠️  INSECURE CONFIGURATION: ${message}\n⚠️  This API would refuse to start in production or with KITSUDEN_PUBLIC=true.\n`
  );
}

checkPlaceholderSecrets();

/**
 * The vault's key is not the session secret (security review 2026-11-03):
 * production and public mode refuse to start without KITSUDEN_SECRETS_KEY.
 * See lib/secrets-key.ts for the migration of an existing install.
 */
function checkSecretsKey(): void {
  const status = secretsKeyStatus(process.env);
  if (!status.ok) {
    console.error(`\nConfiguration validation failed: ${status.error}\n`);
    process.exit(1);
  }
  if (status.mode === "same-as-session") console.warn(`\n⚠️  ${status.warning}\n`);
}

checkSecretsKey();

export const config = loadConfig();

// Feature flags based on config
export const features = {
  isDevelopment: config.NODE_ENV === "development",
  isProduction: config.NODE_ENV === "production",
  isTest: config.NODE_ENV === "test",

  swaggerEnabled: config.ENABLE_SWAGGER,
  mcpEnabled: config.ENABLE_MCP,
  rateLimitEnabled: config.RATE_LIMIT_ENABLED,
  headless: config.HEADLESS,

  // Database has pgvector (detected at runtime)
  pgvector: false as boolean, // Set at startup
};

// Rate limiting configuration
export const rateLimitConfig = {
  enabled: config.RATE_LIMIT_ENABLED,
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  maxRequests: config.RATE_LIMIT_MAX_REQUESTS,
  authMax: config.RATE_LIMIT_AUTH_MAX,

  // Skip rate limiting for health checks
  skipPaths: ["/api/health", "/api/health/pgvector", "/api/system/init-check"],
};

// CORS configuration
export const corsConfig = {
  origins: config.ALLOWED_ORIGINS,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  headers: ["Content-Type", "Authorization"],
  credentials: true,
};

export default config;
