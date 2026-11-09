/**
 * Kitsuden — KITSUDEN Vault (KITSUDEN architecture §3)
 *
 * Dynamic schema manager with REAL `CREATE TABLE` / `ALTER TABLE`
 * in PostgreSQL, instead of JSONB. It complements (does NOT replace) the existing JSONB
 * Dataset Engine — ADR-001 still holds for classic datasets;
 * Vault is the opt-in path for collections that need indexes and native
 * types with real-table performance.
 *
 * MULTI-TENANT SECURITY GUARANTEES:
 *   1. Only tables with the `vault_` prefix — the engine never touches core tables.
 *   2. Identifiers validated with a strict regex (^[a-z][a-z0-9_]{0,50}$).
 *   3. Column types limited to a whitelist (no arbitrary SQL).
 *   4. RLS enabled + FORCE on every created table, with the same
 *      owner_isolation policy as the Titanium Wall (app.current_user_id).
 *   5. Every DDL operation is recorded as a JSON snapshot in
 *      apps/api/drizzle/vault/ (migration-style history).
 *
 * FEATURE FLAG: KITSUDEN_VAULT_ENABLED=true (default: off — disruptive decision,
 * see docs/agents/sandbox.md).
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";

import { db } from "../db";
import { ddlConnectionConfigured } from "../lib/ddl-connection";
import { logger } from "../lib/logger";

import { invalidateGraphifyCache } from "./graphify";
import { introspectTable, clearIntrospectionCache } from "./schema-introspector";

// ═══════════════════════════════════════════════════════════════
// TYPES & VALIDATION
// ═══════════════════════════════════════════════════════════════

/**
 * Connection for the Vault's DDL (CREATE/ALTER/DROP TABLE, indexes, RLS).
 *
 * Security audit, tested with the app's role: in production the API
 * connects with a role WITHOUT schema privileges (`start-with-check.sh` only
 * gives it DML), so creating a collection failed with 42501. And it is not advisable to give it
 * CREATE: a table's owner can remove its RLS. The DDL goes through the
 * admin account (`DATABASE_ADMIN_URL`, which the production compose already
 * passes to the API); the app role gets DML through the `ALTER DEFAULT
 * PRIVILEGES` that startup sets. Without that variable (lite, development), `db`.
 */
type DdlExecutor = { execute: (query: ReturnType<typeof sql.raw>) => Promise<unknown> };
let ddlConnection: DdlExecutor | null = null;
async function ddl(): Promise<DdlExecutor> {
  // First the limited DDL role, not the superuser (see
  // lib/ddl-connection.ts); the production image no longer leaves the admin URL
  // in the API's environment.
  const url = ddlConnectionConfigured()?.url;
  if (!url) return db as unknown as DdlExecutor;
  if (!ddlConnection) {
    const pg = (await import("pg")).default;
    const { drizzle } = await import("drizzle-orm/node-postgres");
    ddlConnection = drizzle(
      new pg.Pool({ connectionString: url, max: 2 })
    ) as unknown as DdlExecutor;
  }
  return ddlConnection;
}

export class VaultError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export const VAULT_PREFIX = "vault_";

const NAME_RE = /^[a-z][a-z0-9_]{0,50}$/;

/** Type whitelist — the ONLY path by which the user defines SQL types */
const COLUMN_TYPES = {
  text: "text",
  varchar: "varchar(500)",
  integer: "integer",
  bigint: "bigint",
  numeric: "numeric(18,4)",
  boolean: "boolean",
  timestamp: "timestamptz",
  date: "date",
  uuid: "uuid",
  jsonb: "jsonb",
} as const;

export type VaultColumnType = keyof typeof COLUMN_TYPES;

export interface VaultColumnDef {
  name: string;
  type: VaultColumnType;
  required?: boolean;
  unique?: boolean;
  indexed?: boolean;
}

/** Reserved columns the Vault manages automatically */
const RESERVED_COLUMNS = new Set(["id", "owner_id", "created_at", "updated_at"]);

function assertName(name: string, kind: "collection" | "column"): void {
  if (!NAME_RE.test(name)) {
    throw new VaultError(
      400,
      `Invalid ${kind} name '${name}'. Use lowercase snake_case (a-z, 0-9, _), max 51 chars.`
    );
  }
  if (kind === "column" && RESERVED_COLUMNS.has(name)) {
    throw new VaultError(400, `Column '${name}' is reserved and managed by Vault automatically`);
  }
}

function assertColumnType(type: string): asserts type is VaultColumnType {
  if (!(type in COLUMN_TYPES)) {
    throw new VaultError(
      400,
      `Invalid column type '${type}'. Allowed: ${Object.keys(COLUMN_TYPES).join(", ")}`
    );
  }
}

export function vaultTableName(collection: string): string {
  assertName(collection, "collection");
  return `${VAULT_PREFIX}${collection}`;
}

export function isVaultEnabled(): boolean {
  return process.env.KITSUDEN_VAULT_ENABLED === "true";
}

// ═══════════════════════════════════════════════════════════════
// SNAPSHOTS (migration-style DDL history)
// ═══════════════════════════════════════════════════════════════

function snapshotDir(): string {
  // apps/api/drizzle/vault — next to the drizzle-kit migrations
  const candidates = [
    join(process.cwd(), "drizzle", "vault"),
    join(process.cwd(), "apps", "api", "drizzle", "vault"),
  ];
  for (const dir of candidates) {
    const parent = join(dir, "..");
    if (existsSync(parent)) return dir;
  }
  return candidates[0]!;
}

function writeSnapshot(operation: string, detail: Record<string, unknown>): void {
  try {
    const dir = snapshotDir();
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `${stamp}_${operation}.json`);
    writeFileSync(
      file,
      JSON.stringify({ operation, timestamp: new Date().toISOString(), ...detail }, null, 2)
    );
  } catch (err) {
    // The snapshot is for traceability: it does not block
    logger.warn({ error: (err as Error).message }, "[Vault] Snapshot write failed (non-fatal)");
  }
}

// ═══════════════════════════════════════════════════════════════
// DDL: real CREATE / ALTER TABLE
// ═══════════════════════════════════════════════════════════════

function columnDDL(col: VaultColumnDef): string {
  assertName(col.name, "column");
  assertColumnType(col.type);
  const pgType = COLUMN_TYPES[col.type];
  const notNull = col.required ? " NOT NULL" : "";
  const unique = col.unique ? " UNIQUE" : "";
  // Identifiers already validated by regex — safe interpolation
  return `"${col.name}" ${pgType}${notNull}${unique}`;
}

/**
 * Creates a Vault collection: real table with id/owner_id/timestamps + RLS.
 */
export async function createCollection(
  collection: string,
  columns: VaultColumnDef[]
): Promise<{ table: string; columns: number }> {
  const table = vaultTableName(collection);

  if (columns.length === 0) {
    throw new VaultError(400, "At least one column is required");
  }
  if (columns.length > 60) {
    throw new VaultError(400, "Maximum 60 columns per collection");
  }

  const names = new Set<string>();
  for (const col of columns) {
    assertName(col.name, "column");
    assertColumnType(col.type);
    if (names.has(col.name)) throw new VaultError(400, `Duplicate column '${col.name}'`);
    names.add(col.name);
  }

  const existing = await introspectTable(table);
  if (existing) throw new VaultError(409, `Collection '${collection}' already exists`);

  const userColumns = columns.map(columnDDL).join(",\n      ");

  // Real CREATE TABLE — the heart of KITSUDEN Vault
  await (
    await ddl()
  ).execute(
    sql.raw(`
    CREATE TABLE "${table}" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id text,
      ${userColumns},
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  );

  // Requested indexes
  for (const col of columns) {
    if (col.indexed && !col.unique) {
      await (
        await ddl()
      ).execute(sql.raw(`CREATE INDEX "idx_${table}_${col.name}" ON "${table}" ("${col.name}")`));
    }
  }
  await (
    await ddl()
  ).execute(sql.raw(`CREATE INDEX "idx_${table}_owner" ON "${table}" (owner_id)`));

  // RLS — Titanium Wall identical to data_entries'
  await (await ddl()).execute(sql.raw(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`));
  await (await ddl()).execute(sql.raw(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
  await (
    await ddl()
  ).execute(
    sql.raw(`
    CREATE POLICY "${table}_owner_isolation" ON "${table}"
      FOR ALL TO PUBLIC
      USING (
        -- «System» = empty id AND role: the anonymous user also has an empty id
        -- (rls-owned-tables.sql redoes the existing ones)
        (COALESCE(current_setting('app.current_user_id', true), '') = ''
         AND COALESCE(current_setting('app.current_user_role', true), '') = '')
        OR current_setting('app.current_user_role', true) = 'admin'
        OR owner_id = current_setting('app.current_user_id', true)
        OR (owner_id IS NULL AND COALESCE(current_setting('app.current_user_id', true), '') <> '')
      )
      WITH CHECK (
        (COALESCE(current_setting('app.current_user_id', true), '') = ''
         AND COALESCE(current_setting('app.current_user_role', true), '') = '')
        OR current_setting('app.current_user_role', true) = 'admin'
        OR owner_id = current_setting('app.current_user_id', true)
      )
  `)
  );

  clearIntrospectionCache();
  invalidateGraphifyCache();
  writeSnapshot("create_collection", { table, columns });
  logger.info({ table, columns: columns.length }, "[Vault] Collection created (real table + RLS)");

  return { table, columns: columns.length };
}

/**
 * Hot ALTER TABLE ADD COLUMN.
 */
export async function addColumn(collection: string, col: VaultColumnDef): Promise<void> {
  const table = vaultTableName(collection);
  assertName(col.name, "column");
  assertColumnType(col.type);

  const existing = await introspectTable(table);
  if (!existing) throw new VaultError(404, `Collection '${collection}' not found`);
  if (existing.columns.some((c) => c.name === col.name)) {
    throw new VaultError(409, `Column '${col.name}' already exists`);
  }

  // ADD COLUMN with NOT NULL requires a default or an empty table; for multi-tenant
  // safety new columns always come in as nullable.
  const pgType = COLUMN_TYPES[col.type];
  await (await ddl()).execute(sql.raw(`ALTER TABLE "${table}" ADD COLUMN "${col.name}" ${pgType}`));

  if (col.unique) {
    await (
      await ddl()
    ).execute(
      sql.raw(`CREATE UNIQUE INDEX "uq_${table}_${col.name}" ON "${table}" ("${col.name}")`)
    );
  } else if (col.indexed) {
    await (
      await ddl()
    ).execute(sql.raw(`CREATE INDEX "idx_${table}_${col.name}" ON "${table}" ("${col.name}")`));
  }

  clearIntrospectionCache();
  invalidateGraphifyCache();
  writeSnapshot("add_column", { table, column: col });
  logger.info({ table, column: col.name }, "[Vault] Column added (real ALTER TABLE)");
}

/**
 * ALTER TABLE DROP COLUMN (guarded: never reserved columns).
 */
export async function dropColumn(collection: string, columnName: string): Promise<void> {
  const table = vaultTableName(collection);
  assertName(columnName, "column"); // also rejects reserved ones

  const existing = await introspectTable(table);
  if (!existing) throw new VaultError(404, `Collection '${collection}' not found`);
  if (!existing.columns.some((c) => c.name === columnName)) {
    throw new VaultError(404, `Column '${columnName}' not found`);
  }

  await (await ddl()).execute(sql.raw(`ALTER TABLE "${table}" DROP COLUMN "${columnName}"`));

  clearIntrospectionCache();
  invalidateGraphifyCache();
  writeSnapshot("drop_column", { table, column: columnName });
  logger.info({ table, column: columnName }, "[Vault] Column dropped");
}

/**
 * DROP TABLE (destructive — requires explicit confirmation in the route).
 */
export async function dropCollection(collection: string): Promise<void> {
  const table = vaultTableName(collection);

  const existing = await introspectTable(table);
  if (!existing) throw new VaultError(404, `Collection '${collection}' not found`);

  await (await ddl()).execute(sql.raw(`DROP TABLE "${table}"`));

  clearIntrospectionCache();
  invalidateGraphifyCache();
  writeSnapshot("drop_collection", { table });
  logger.info({ table }, "[Vault] Collection dropped");
}

/**
 * Lists the Vault collections (tables with the vault_ prefix) with their schema.
 */
export async function listCollections(): Promise<
  Array<{ collection: string; table: string; columns: unknown[]; estimatedRowCount: number }>
> {
  const result = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_name LIKE ${VAULT_PREFIX + "%"}
    ORDER BY table_name
  `);

  const collections = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of result.rows as any[]) {
    const table = row.table_name as string;
    const introspected = await introspectTable(table);
    collections.push({
      collection: table.slice(VAULT_PREFIX.length),
      table,
      columns: introspected?.columns ?? [],
      estimatedRowCount: introspected?.estimatedRowCount ?? 0,
    });
  }
  return collections;
}

// ═══════════════════════════════════════════════════════════════
// ROW CRUD — 100% parameterized values, validated columns
// ═══════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Executor = { execute: (q: any) => Promise<{ rows: any[] }> };

async function validateRowColumns(table: string, data: Record<string, unknown>): Promise<string[]> {
  const introspected = await introspectTable(table);
  if (!introspected) throw new VaultError(404, `Collection not found`);

  const validColumns = new Set(introspected.columns.map((c) => c.name));
  const keys = Object.keys(data).filter((k) => !RESERVED_COLUMNS.has(k));

  for (const key of keys) {
    if (!validColumns.has(key)) {
      throw new VaultError(400, `Unknown column '${key}' on '${table}'`);
    }
  }
  if (keys.length === 0) throw new VaultError(400, "No writable columns in payload");
  return keys;
}

/**
 * Parameterized INSERT. owner_id is taken from the context (never from the payload).
 */
export async function insertRow(
  executor: Executor,
  collection: string,
  data: Record<string, unknown>,
  ownerId: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const table = vaultTableName(collection);
  const keys = await validateRowColumns(table, data);

  const columnIdents = sql.join(
    [sql.identifier("owner_id"), ...keys.map((k) => sql.identifier(k))],
    sql`, `
  );
  const valuePlaceholders = sql.join(
    [sql`${ownerId}`, ...keys.map((k) => sql`${data[k] as never}`)],
    sql`, `
  );

  const result = await executor.execute(
    sql`INSERT INTO ${sql.identifier(table)} (${columnIdents}) VALUES (${valuePlaceholders}) RETURNING *`
  );
  return result.rows[0];
}

/**
 * UPDATE parameterized by id (RLS decides whether the caller can touch the row).
 */
export async function updateRow(
  executor: Executor,
  collection: string,
  id: string,
  data: Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  const table = vaultTableName(collection);
  const keys = await validateRowColumns(table, data);

  const setClauses = sql.join(
    [
      ...keys.map((k) => sql`${sql.identifier(k)} = ${data[k] as never}`),
      sql`${sql.identifier("updated_at")} = now()`,
    ],
    sql`, `
  );

  const result = await executor.execute(
    sql`UPDATE ${sql.identifier(table)} SET ${setClauses} WHERE id::text = ${id} RETURNING *`
  );
  return result.rows[0] ?? null;
}

/**
 * DELETE by id (RLS applies).
 */
export async function deleteRow(
  executor: Executor,
  collection: string,
  id: string
): Promise<boolean> {
  const table = vaultTableName(collection);
  const introspected = await introspectTable(table);
  if (!introspected) throw new VaultError(404, `Collection not found`);

  const result = await executor.execute(
    sql`DELETE FROM ${sql.identifier(table)} WHERE id::text = ${id} RETURNING id`
  );
  return result.rows.length > 0;
}
