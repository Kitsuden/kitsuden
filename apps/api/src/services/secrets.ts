/**
 * Kitsuden — Prefect-Style Secrets Manager (KITSUDEN architecture §7)
 *
 * Management of environment variables and API keys with:
 *   - AES-256-GCM encryption at rest (PostgreSQL, kitsuden_secrets table)
 *   - Hot injection into process.env without restarting Bun
 *   - Automatic load at boot (autoInject=true)
 *   - Rotation with an audit timestamp
 *
 * MASTER KEY:
 *   KITSUDEN_SECRETS_KEY (env) — 32+ chars recommended. If it does not exist, it is derived
 *   from BETTER_AUTH_SECRET with a warning in development; production and public mode
 *   refuse to start without it (lib/secrets-key.ts, which also says how to migrate).
 *
 * The admin UI consumes the routes in routes/secrets.ts (/api/admin/secrets).
 */

import { eq, sql } from "drizzle-orm";

import { db } from "../db";
import { kitsudenSecrets } from "../db/schema-core";
import { logger } from "../lib/logger";
import {
  decryptWith,
  deriveSecretsKey,
  encryptWith,
  masterSecretValue,
  secretsKeyStatus,
  type EncryptedValue,
} from "../lib/secrets-key";

export type { EncryptedValue };

// ═══════════════════════════════════════════════════════════════
// MASTER KEY
// ═══════════════════════════════════════════════════════════════

let cachedKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const status = secretsKeyStatus();
  // Startup already refused (lib/config.ts); this covers a script or a test
  // that changed the environment afterwards.
  if (!status.ok) throw new Error(status.error);
  if (status.mode !== "dedicated") logger.warn(status.warning);
  const raw = masterSecretValue();
  if (!raw) {
    throw new Error(
      "Secrets Manager requires KITSUDEN_SECRETS_KEY (or BETTER_AUTH_SECRET outside production) to be set"
    );
  }

  cachedKey = deriveSecretsKey(raw);
  return cachedKey;
}

// ═══════════════════════════════════════════════════════════════
// CRYPTO (AES-256-GCM)
// ═══════════════════════════════════════════════════════════════

export function encryptSecret(plaintext: string): EncryptedValue {
  return encryptWith(getMasterKey(), plaintext);
}

export function decryptSecret(payload: EncryptedValue): string {
  return decryptWith(getMasterKey(), payload);
}

// ═══════════════════════════════════════════════════════════════
// BOOTSTRAP — resilience in environments without applied migrations
// ═══════════════════════════════════════════════════════════════

const SECRET_KEY_RE = /^[A-Z][A-Z0-9_]{1,199}$/;

/**
 * Keys that CANNOT be set from the manager (security audit): secrets
 * are injected into `process.env`, and these change how the process starts or
 * is protected — `PATH`/`NODE_OPTIONS`/`LD_PRELOAD` reach
 * `pg_dump` and any child process (code execution), and the
 * configuration ones would silently turn security off (`NODE_ENV`, auth
 * secrets, the database, CORS, Kitsuden's switches). They are configured in the
 * deployment's `.env`, not from the panel.
 */
const RESERVED_KEYS = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "DATABASE_URL",
  "DATABASE_ADMIN_URL",
  "DATABASE_DDL_URL",
  "REDIS_URL",
  "ALLOWED_ORIGINS",
  "PORT",
  "HOST",
]);
const RESERVED_PREFIXES = [
  "LD_",
  "DYLD_",
  "BUN_",
  "NODE_",
  "PG",
  "POSTGRES_",
  "APP_DB_",
  "KITSUDEN_",
  "ENABLE_",
  "VALKEY_",
];

export function reservedSecretKey(key: string): boolean {
  return RESERVED_KEYS.has(key) || RESERVED_PREFIXES.some((p) => key.startsWith(p));
}

export function isValidSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key) && !reservedSecretKey(key);
}

let tableEnsured = false;

/**
 * CREATE TABLE IF NOT EXISTS — lets the Secrets Manager be used even if
 * the drizzle-kit migrations have not been regenerated yet.
 * (The table is also declared in schema-core.ts for future
 * generations with `bun run db:generate`.)
 */
/**
 * Checks that the secrets table exists. It NO LONGER creates it.
 *
 * It used to run `CREATE TABLE IF NOT EXISTS` at startup, as a patch for
 * environments without applied migrations. That stopped working —and it is good that
 * it stopped— when the API started connecting with an unprivileged role so
 * that RLS really applies: that role has no CREATE on the
 * schema, so the statement fails with
 *
 *     permission denied for schema public
 *
 * even with the table already created, because Postgres checks the permission before
 * the IF NOT EXISTS.
 *
 * The symptom was misleading: the `catch` in `loadSecretsIntoEnv` logged
 * "[Secrets] Boot injection skipped (DB unavailable?)" and the database was
 * perfectly available. The connection was blamed for a permissions problem
 * on a table that, moreover, already existed.
 *
 * The table is now created by `src/db/migrations/0037_declared_tables_without_migration.sql`,
 * which is where it has to be: creating schema is a migration's job, not
 * a service starting up.
 */
export async function ensureSecretsTable(): Promise<void> {
  if (tableEnsured) return;

  const rows = await db.execute(
    sql`SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'kitsuden_secrets'`
  );
  const found = Array.isArray(rows)
    ? rows.length > 0
    : ((rows as { rows?: unknown[] }).rows?.length ?? 0) > 0;

  if (!found) {
    throw new Error(
      "The kitsuden_secrets table is missing. The migrations need to be applied: " +
        "run `bun run scripts/migrate.ts` with the admin connection."
    );
  }

  tableEnsured = true;
}

// ═══════════════════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════════════════

export interface SecretMeta {
  id: string;
  key: string;
  description: string | null;
  category: string;
  autoInject: boolean;
  lastRotatedAt: Date | null;
  lastInjectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Masked preview of the value: "sk-a•••••z9" */
  hint: string;
}

function maskValue(plaintext: string): string {
  if (plaintext.length <= 6) return "•".repeat(plaintext.length);
  return `${plaintext.slice(0, 3)}${"•".repeat(5)}${plaintext.slice(-2)}`;
}

export async function listSecrets(): Promise<SecretMeta[]> {
  await ensureSecretsTable();
  const rows = await db.select().from(kitsudenSecrets).orderBy(kitsudenSecrets.key);

  return rows.map((row) => {
    let hint = "••••••";
    try {
      hint = maskValue(
        decryptSecret({ valueEncrypted: row.valueEncrypted, iv: row.iv, authTag: row.authTag })
      );
    } catch {
      hint = "⚠ undecryptable (master key changed?)";
    }
    return {
      id: row.id,
      key: row.key,
      description: row.description,
      category: row.category,
      autoInject: row.autoInject,
      lastRotatedAt: row.lastRotatedAt,
      lastInjectedAt: row.lastInjectedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      hint,
    };
  });
}

export async function setSecret(input: {
  key: string;
  value: string;
  description?: string;
  category?: string;
  autoInject?: boolean;
  createdById?: string;
  /** Inject immediately into process.env (default: true) */
  injectNow?: boolean;
}): Promise<SecretMeta> {
  await ensureSecretsTable();

  if (!isValidSecretKey(input.key)) {
    throw new Error(
      "Invalid secret key. Use UPPER_SNAKE_CASE (e.g. OPENAI_API_KEY), max 200 chars."
    );
  }
  if (!input.value || input.value.length === 0) {
    throw new Error("Secret value cannot be empty");
  }

  const encrypted = encryptSecret(input.value);
  const now = new Date();

  const [existing] = await db
    .select({ id: kitsudenSecrets.id })
    .from(kitsudenSecrets)
    .where(eq(kitsudenSecrets.key, input.key))
    .limit(1);

  if (existing) {
    await db
      .update(kitsudenSecrets)
      .set({
        valueEncrypted: encrypted.valueEncrypted,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        description: input.description,
        category: input.category ?? "general",
        autoInject: input.autoInject ?? true,
        lastRotatedAt: now,
        updatedAt: now,
      })
      .where(eq(kitsudenSecrets.id, existing.id));
  } else {
    await db.insert(kitsudenSecrets).values({
      key: input.key,
      valueEncrypted: encrypted.valueEncrypted,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      description: input.description,
      category: input.category ?? "general",
      autoInject: input.autoInject ?? true,
      createdById: input.createdById,
    });
  }

  // Hot injection: the Prefect-style magic — without restarting Bun
  if (input.injectNow !== false) {
    await injectSecret(input.key);
  }

  const all = await listSecrets();
  return all.find((s) => s.key === input.key)!;
}

export async function deleteSecret(key: string): Promise<boolean> {
  await ensureSecretsTable();
  const result = await db.delete(kitsudenSecrets).where(eq(kitsudenSecrets.key, key)).returning();
  if (result.length > 0) {
    // We also remove it from the live environment
    delete process.env[key];
    logger.info({ key }, "[Secrets] Secret deleted and removed from process.env");
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// HOT INJECTION
// ═══════════════════════════════════════════════════════════════

/**
 * Decrypts a secret and injects it into process.env HOT.
 * Any code that reads process.env[KEY] from this moment on
 * will see the new value, without restarting the process.
 */
export async function injectSecret(key: string): Promise<boolean> {
  await ensureSecretsTable();
  const [row] = await db
    .select()
    .from(kitsudenSecrets)
    .where(eq(kitsudenSecrets.key, key))
    .limit(1);
  if (!row) return false;

  const value = decryptSecret({
    valueEncrypted: row.valueEncrypted,
    iv: row.iv,
    authTag: row.authTag,
  });

  // One saved before the list of reserved keys existed is not injected
  if (reservedSecretKey(key)) {
    logger.warn({ key }, "[Secrets] Reserved key not injected into process.env");
    return false;
  }
  process.env[key] = value;
  await db
    .update(kitsudenSecrets)
    .set({ lastInjectedAt: new Date() })
    .where(eq(kitsudenSecrets.id, row.id));

  logger.info({ key }, "[Secrets] Secret hot-injected into process.env");
  return true;
}

/**
 * Loads all secrets with autoInject=true into process.env.
 * Called at server boot (index.ts). Fails non-fatally if the
 * DB is not available yet.
 */
export async function loadSecretsIntoEnv(): Promise<number> {
  try {
    await ensureSecretsTable();
    const rows = await db
      .select()
      .from(kitsudenSecrets)
      .where(eq(kitsudenSecrets.autoInject, true));

    let injected = 0;
    for (const row of rows) {
      if (reservedSecretKey(row.key)) {
        logger.warn({ key: row.key }, "[Secrets] Reserved key not injected into process.env");
        continue;
      }
      try {
        process.env[row.key] = decryptSecret({
          valueEncrypted: row.valueEncrypted,
          iv: row.iv,
          authTag: row.authTag,
        });
        injected++;
      } catch (err) {
        logger.warn(
          { key: row.key, error: (err as Error).message },
          "[Secrets] Failed to decrypt secret during boot injection (master key changed?)"
        );
      }
    }

    if (injected > 0) {
      await db.execute(
        sql`UPDATE kitsuden_secrets SET last_injected_at = now() WHERE auto_inject = true`
      );
    }
    return injected;
  } catch (err) {
    // The message no longer guesses the cause. It said "(DB unavailable?)" for
    // any failure, and the only time it really fired was because of a missing
    // table with the database perfectly available: it sent people looking in the wrong place.
    logger.warn({ error: (err as Error).message }, "[Secrets] No secrets were injected at startup");
    return 0;
  }
}
