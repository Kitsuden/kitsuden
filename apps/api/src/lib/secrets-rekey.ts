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
  where: string,
  /** The context the value is bound to (a kon's sealed secret); see `encryptWith`. */
  aad?: string
): EncryptedValue | null {
  try {
    decryptWith(newKey, payload, aad);
    return null;
  } catch {
    // Not on the new key yet
  }
  let plain: string;
  try {
    plain = decryptWith(oldKey, payload, aad);
  } catch {
    throw new RekeyError(
      `${where} decrypts with neither the old nor the new key: nothing was changed. ` +
        "Check KITSUDEN_SECRETS_KEY_OLD (by default BETTER_AUTH_SECRET is the old one)."
    );
  }
  return encryptWith(newKey, plain, aad);
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

interface JsonStore {
  table: string;
  column: string;
  id: string;
}

/**
 * The columns kons declared for their sealed secrets (`defineKon({ secretColumns })`), which the
 * loader writes to `kitsuden_secret_columns`. Read from the database because this runs offline,
 * with no kon loaded.
 */
async function konSecretStores(tx: Executor): Promise<JsonStore[]> {
  if (!(await tableExists(tx, "kitsuden_secret_columns"))) return [];
  const rows = rowsOf(
    await tx.execute(
      sql`SELECT table_name, column_name, id_column FROM kitsuden_secret_columns ORDER BY 1, 2`
    )
  );
  return rows
    .map((r) => ({
      table: String(r.table_name),
      column: String(r.column_name),
      id: String(r.id_column),
    }))
    .filter((s) => [s.table, s.column, s.id].every((name) => IDENTIFIER.test(name)));
}

async function columnExists(tx: Executor, table: string, column: string): Promise<boolean> {
  const r = rowsOf(
    await tx.execute(sql`
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`)
  );
  return r.length > 0;
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
    const jsonStores: JsonStore[] = [
      { table: "data_sources", column: "encrypted_password", id: "id" },
      { table: "agent_notify_settings", column: "secret", id: "agent_id" },
      // The auth header of an external MCP server (0070). It was missing from this list: after a
      // rekey those headers no longer decrypted.
      { table: "external_mcp_servers", column: "auth_header_value", id: "id" },
      ...(await konSecretStores(tx)),
    ];
    for (const s of jsonStores) {
      if (!(await tableExists(tx, s.table))) continue;
      if (!(await columnExists(tx, s.table, s.column))) continue;
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
        // A kon's sealed secret names its kon; the value is bound to that name.
        const kon = (payload as { kon?: unknown }).kon;
        const aad = typeof kon === "string" ? `kon:${kon}` : undefined;
        const next = reencrypt(
          oldKey,
          newKey,
          payload,
          `${s.table}.${s.column} (${String(r.id)})`,
          aad
        );
        if (next && aad !== undefined) Object.assign(next, { v: 1, kon });
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
