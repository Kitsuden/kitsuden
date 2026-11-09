/**
 * The master key of the secrets manager, and the rule that keeps it apart
 * from the session secret
 * ============================================================================
 *
 * Until 2026-11-04 an unset `KITSUDEN_SECRETS_KEY` meant "derive it from
 * `BETTER_AUTH_SECRET`", in production too: one leaked value both signed admin
 * sessions and decrypted every stored secret (the vault, data source passwords,
 * agent notification secrets). Security review 2026-11-03.
 *
 * Now production and public mode refuse to start without `KITSUDEN_SECRETS_KEY`.
 * An installation that already stored secrets has two ways forward, printed in
 * the refusal:
 *
 *   1. Re-encrypt (recommended): set a new `KITSUDEN_SECRETS_KEY` and run
 *      `bun run scripts/rekey-secrets.ts` (lib/secrets-rekey.ts) once, with the
 *      admin connection. The old key is derived from `BETTER_AUTH_SECRET` (or
 *      `KITSUDEN_SECRETS_KEY_OLD`).
 *   2. Keep compatibility: set `KITSUDEN_SECRETS_KEY` to the current value of
 *      `BETTER_AUTH_SECRET`. The derivation is the same, so the stored secrets
 *      still decrypt; the two secrets are still one, and startup warns.
 *
 * No dependencies on the database or the logger: config.ts runs this before
 * anything else loads, and the re-key script uses it without the API.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import { publicOrProduction } from "./placeholder-secrets";

type Env = Record<string, string | undefined>;

const KEY_SALT = "kitsuden-secrets-v1"; // fixed salt: the entropy comes from the master key

export interface EncryptedValue {
  valueEncrypted: string; // hex
  iv: string; // hex (12 bytes)
  authTag: string; // hex (16 bytes)
}

/** The AES-256 key derived from a master value (the same derivation since v1). */
export function deriveSecretsKey(raw: string): Buffer {
  return scryptSync(raw, KEY_SALT, 32);
}

export function encryptWith(key: Buffer, plaintext: string): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    valueEncrypted: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
  };
}

export function decryptWith(key: Buffer, payload: EncryptedValue): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "hex"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.valueEncrypted, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export type SecretsKeyStatus =
  /** A dedicated key: what production needs. */
  | { ok: true; mode: "dedicated" }
  /** `KITSUDEN_SECRETS_KEY` equals `BETTER_AUTH_SECRET`: compatibility, warned. */
  | { ok: true; mode: "same-as-session"; warning: string }
  /** Unset outside production: derived from the session secret, warned. */
  | { ok: true; mode: "derived"; warning: string }
  /** Unset in production or public mode: startup refuses. */
  | { ok: false; error: string };

export const SECRETS_KEY_REFUSAL =
  "KITSUDEN_SECRETS_KEY is not set. In production it must be its own secret: deriving it from " +
  "BETTER_AUTH_SECRET means one leaked value signs admin sessions AND decrypts every stored secret.\n" +
  "  · New install, or no secrets stored yet: set KITSUDEN_SECRETS_KEY=$(openssl rand -hex 32).\n" +
  "  · Secrets already stored (vault, data source passwords, agent notification secrets):\n" +
  "      a) recommended: set a new KITSUDEN_SECRETS_KEY and run once, with the admin connection,\n" +
  "         `DATABASE_URL=$DATABASE_ADMIN_URL bun run scripts/rekey-secrets.ts` (apps/api; add --dry-run to check first);\n" +
  "      b) to keep them as they are: set KITSUDEN_SECRETS_KEY to the current value of BETTER_AUTH_SECRET.\n" +
  "  See docs/install/upgrade-and-backups.md.";

export function secretsKeyStatus(env: Env = process.env): SecretsKeyStatus {
  const key = env["KITSUDEN_SECRETS_KEY"]?.trim();
  const session = env["BETTER_AUTH_SECRET"]?.trim();
  if (key) {
    if (session && key === session) {
      return {
        ok: true,
        mode: "same-as-session",
        warning:
          "KITSUDEN_SECRETS_KEY equals BETTER_AUTH_SECRET (compatibility mode): stored secrets decrypt, but one " +
          "value still protects both. Re-encrypt with scripts/rekey-secrets.ts and a new key when you can.",
      };
    }
    return { ok: true, mode: "dedicated" };
  }
  if (publicOrProduction(env)) return { ok: false, error: SECRETS_KEY_REFUSAL };
  return {
    ok: true,
    mode: "derived",
    warning:
      "[Secrets] KITSUDEN_SECRETS_KEY not set — deriving from BETTER_AUTH_SECRET. " +
      "Production refuses to start without a dedicated KITSUDEN_SECRETS_KEY.",
  };
}

/** The raw master value the manager uses now, or null if there is none. */
export function masterSecretValue(env: Env = process.env): string | null {
  return env["KITSUDEN_SECRETS_KEY"] || env["BETTER_AUTH_SECRET"] || null;
}
