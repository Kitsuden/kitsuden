/**
 * Re-encrypt every stored secret from one master key to another
 * ============================================================================
 *
 * For an installation that ran without `KITSUDEN_SECRETS_KEY` (its secrets were
 * encrypted with a key derived from `BETTER_AUTH_SECRET`) and now gets a
 * dedicated key, or for rotating the key. CLI: `scripts/rekey-secrets.ts`.
 *
 * What is encrypted with the secrets manager's key (all AES-256-GCM):
 *
 *   · `kitsuden_secrets` (value_encrypted / iv / auth_tag columns);
 *   · `data_sources.encrypted_password` (jsonb `{ valueEncrypted, iv, authTag }`);
 *   · `agent_notify_settings.secret` (the same jsonb).
 *
 * Everything happens in ONE transaction: a row that decrypts with neither key
 * aborts it and nothing changes. A row that already decrypts with the new key
 * is skipped, so running it twice is harmless.
 */

import { sql } from "drizzle-orm";

import { decryptWith, deriveSecretsKey, encryptWith, type EncryptedValue } from "./secrets-key";

interface Executor {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
}
type Transactional = Executor & {
  transaction: <T>(fn: (tx: Executor) => Promise<T>) => Promise<T>;
};

export interface RekeyReport {
  dryRun: boolean;
  /** Per store: re-encrypted, already on the new key. */
  stores: Record<string, { rekeyed: number; alreadyNew: number }>;
}

export class RekeyError extends Error {}

const rowsOf = (r: unknown): Record<string, unknown>[] =>
  Array.isArray(r)
    ? (r as Record<string, unknown>[])
    : ((r as { rows?: Record<string, unknown>[] }).rows ?? []);

async function tableExists(tx: Executor, table: string): Promise<boolean> {
  const r = rowsOf(await tx.execute(sql`SELECT to_regclass(${`public.${table}`}) AS t`));
  return !!r[0]?.t;
}

function isEncrypted(v: unknown): v is EncryptedValue {
  const o = v as Partial<EncryptedValue> | null;
  return (
    !!o &&
    typeof o.valueEncrypted === "string" &&
    typeof o.iv === "string" &&
    typeof o.authTag === "string"
  );
}

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/**
 * The new value for one payload: `null` when it already uses the new key.
 * Throws when it decrypts with neither (wrong old key, or corrupt row).
 */
function reencrypt(
  oldKey: Buffer,
  newKey: Buffer,
  payload: EncryptedValue,
  where: string
): EncryptedValue | null {
  try {
    decryptWith(newKey, payload);
    return null;
  } catch {
    // Not on the new key yet
  }
  let plain: string;
  try {
    plain = decryptWith(oldKey, payload);
  } catch {
    throw new RekeyError(
      `${where} decrypts with neither the old nor the new key: nothing was changed. ` +
        "Check KITSUDEN_SECRETS_KEY_OLD (by default BETTER_AUTH_SECRET is the old one)."
    );
  }
  return encryptWith(newKey, plain);
}

export async function rekeySecrets(
  database: Transactional,
  options: { oldRaw: string; newRaw: string; dryRun?: boolean }
): Promise<RekeyReport> {
  if (!options.oldRaw || !options.newRaw)
    throw new RekeyError("both the old and the new key are needed");
  if (options.oldRaw === options.newRaw) {
    throw new RekeyError(
      "the new KITSUDEN_SECRETS_KEY is the same value as the old key: nothing to do"
    );
  }
  const oldKey = deriveSecretsKey(options.oldRaw);
  const newKey = deriveSecretsKey(options.newRaw);
  const dryRun = options.dryRun === true;
  const report: RekeyReport = { dryRun, stores: {} };

  const run = async (tx: Executor) => {
    // 1. The secrets manager
    if (await tableExists(tx, "kitsuden_secrets")) {
      const stats = { rekeyed: 0, alreadyNew: 0 };
      const rows = rowsOf(
        await tx.execute(
          sql`SELECT id, key, value_encrypted, iv, auth_tag FROM kitsuden_secrets FOR UPDATE`
        )
      );
      for (const r of rows) {
        const next = reencrypt(
          oldKey,
          newKey,
          {
            valueEncrypted: String(r.value_encrypted),
            iv: String(r.iv),
            authTag: String(r.auth_tag),
          },
          `kitsuden_secrets "${String(r.key)}"`
        );
        if (!next) {
          stats.alreadyNew++;
          continue;
        }
        stats.rekeyed++;
        if (!dryRun) {
          await tx.execute(sql`
            UPDATE kitsuden_secrets
               SET value_encrypted = ${next.valueEncrypted}, iv = ${next.iv}, auth_tag = ${next.authTag}
             WHERE id = ${r.id}`);
        }
      }
      report.stores.kitsuden_secrets = stats;
    }

    // 2 and 3. The jsonb payloads
    const jsonStores = [
      { table: "data_sources", column: "encrypted_password", id: "id" },
      { table: "agent_notify_settings", column: "secret", id: "agent_id" },
    ] as const;
    for (const s of jsonStores) {
      if (!(await tableExists(tx, s.table))) continue;
      const stats = { rekeyed: 0, alreadyNew: 0 };
      const rows = rowsOf(
        await tx.execute(
          sql`SELECT ${sql.identifier(s.id)} AS id, ${sql.identifier(s.column)} AS payload
                FROM ${sql.identifier(s.table)}
               WHERE ${sql.identifier(s.column)} IS NOT NULL
                 FOR UPDATE`
        )
      );
      for (const r of rows) {
        const payload = parseJson(r.payload);
        if (!isEncrypted(payload)) continue;
        const next = reencrypt(oldKey, newKey, payload, `${s.table}.${s.column} (${String(r.id)})`);
        if (!next) {
          stats.alreadyNew++;
          continue;
        }
        stats.rekeyed++;
        if (!dryRun) {
          await tx.execute(sql`
            UPDATE ${sql.identifier(s.table)}
               SET ${sql.identifier(s.column)} = ${JSON.stringify(next)}::jsonb
             WHERE ${sql.identifier(s.id)} = ${r.id}`);
        }
      }
      report.stores[`${s.table}.${s.column}`] = stats;
    }
  };

  await database.transaction(async (tx) => run(tx));
  return report;
}
