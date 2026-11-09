/**
 * Kitsuden — Graphify Engine (KITSUDEN architecture §3)
 *
 * Automatic relational API engine. It maps the real PostgreSQL
 * relations (via schema-introspector) and exposes nested endpoints without
 * the developer writing controllers:
 *
 *   GET /api/graph                      → full graph (tables + relations)
 *   GET /api/graph/:table               → paginated list
 *   GET /api/graph/:table/:id           → single record
 *   GET /api/graph/:table/:id/:relation → related rows (1:N, N:1 and N:M)
 *
 * SECURITY:
 *   - Only identifiers verified against information_schema (zero SQL injection:
 *     table/column names are never interpolated without validating existence).
 *   - Deny-list of sensitive tables (auth_*, api_keys, kitsuden_secrets...).
 *   - Runs under withTransactionalRLS → PostgreSQL applies RLS on every query.
 *   - Whoever is NOT admin only sees tables with FORCED RLS (`canViewTable`).
 *
 * ── WHY THE LAST ONE (security audit) ─────────────────────────────────────
 *
 * The deny-list alone let ANY account (sign-up is open) read
 * the ~170 tables without RLS: newsletter subscribers with their email, CRM
 * contacts, directory employees, orders with addresses, `data_sources`
 * with their password, the actions' configuration (webhook secrets),
 * the functions' code, audit logs with IPs… RLS filters
 * nothing on a table that does not have it. Now, without the admin role, a table
 * is readable only if Postgres isolates it per row (RLS enabled AND forced:
 * Vault collections and the personal tables in rls-owned-tables.sql).
 */

import { sql } from "drizzle-orm";

import { db } from "../db";

import { introspectTable, getAllTables, type IntrospectedTable } from "./schema-introspector";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Executor = { execute: (q: any) => Promise<{ rows: any[] }> };

// ═══════════════════════════════════════════════════════════════
// SECURITY — tables never exposed by Graphify
// ═══════════════════════════════════════════════════════════════

// `oauth_`: OAuth clients, grants and token hashes for MCP (0055)
const DENY_PREFIXES = ["auth_", "pg_", "drizzle_", "_", "oauth_"];
const DENY_TABLES = new Set([
  "api_keys",
  "kitsuden_secrets",
  "agent_tokens",
  "agent_api_keys",
  "auth_users",
  "auth_sessions",
  "auth_accounts",
  "auth_verifications",
]);

/** The one from `services/vault.ts` (literal here: vault imports this module). */
const VAULT_PREFIX = "vault_";

export function isTableExposed(tableName: string): boolean {
  if (DENY_TABLES.has(tableName)) return false;
  return !DENY_PREFIXES.some((p) => tableName.startsWith(p));
}

/** Who is asking. By default, nobody with privileges. */
export interface GraphifyAccess {
  isAdmin?: boolean;
}

/**
 * Can this identity read this table through Graphify?
 *
 * Admin: everything exposed. Any other account: only what is exposed and has
 * forced RLS, because only there does Postgres trim by owner the rows it sees.
 */
export function canViewTable(
  tableName: string,
  access: GraphifyAccess,
  withForcedRls: ReadonlySet<string>
): boolean {
  if (!isTableExposed(tableName)) return false;
  if (access.isAdmin === true) return true;
  // Without admin, ONLY Vault collections (and with forced RLS). Audit
  // finding: kon tables also have forced RLS, but their
  // policies allow rows to be seen whose COLUMN trimming is done by the kon's route
  // (directory: salary, date of birth; DMS: `storage_path` of files
  // in /media). Graph does `SELECT *` and skipped that trimming.
  return tableName.startsWith(VAULT_PREFIX) && withForcedRls.has(tableName);
}

let rlsCache: { tables: Set<string>; ts: number } | null = null;

/** `public` tables with RLS enabled and forced (cached like the graph). */
export async function tablesWithForcedRls(): Promise<Set<string>> {
  if (rlsCache && Date.now() - rlsCache.ts < GRAPH_CACHE_TTL) return rlsCache.tables;
  const result = await db.execute(sql`
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND c.relrowsecurity AND c.relforcerowsecurity
  `);
  const rows = ((result as unknown as { rows?: { table_name: string }[] }).rows ??
    (result as unknown as { table_name: string }[])) as { table_name: string }[];
  const tables = new Set<string>(rows.map((r) => r.table_name));
  rlsCache = { tables, ts: Date.now() };
  return tables;
}

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

function assertIdentifier(name: string, kind: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new GraphifyError(400, `Invalid ${kind} identifier: ${name}`);
  }
}

export class GraphifyError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "GraphifyError";
  }
}

// ═══════════════════════════════════════════════════════════════
// RELATION GRAPH (cached)
// ═══════════════════════════════════════════════════════════════

export interface GraphEdge {
  from: string; // table with the FK
  fromColumn: string;
  to: string; // referenced table
  toColumn: string;
}

export interface RelationResolution {
  kind: "belongs-to" | "has-many" | "many-to-many";
  edge: GraphEdge;
  /** For N:M only — junction table and its edge to the target */
  through?: { table: string; edgeToTarget: GraphEdge };
}

let graphCache: { edges: GraphEdge[]; tables: string[]; ts: number } | null = null;
const GRAPH_CACHE_TTL = 5 * 60 * 1000;

/**
 * Builds the global FK graph (all exposed tables).
 */
export async function buildGraph(): Promise<{ edges: GraphEdge[]; tables: string[] }> {
  if (graphCache && Date.now() - graphCache.ts < GRAPH_CACHE_TTL) {
    return { edges: graphCache.edges, tables: graphCache.tables };
  }

  const result = await db.execute(sql`
    SELECT
      tc.table_name AS from_table,
      kcu.column_name AS from_column,
      ccu.table_name AS to_table,
      ccu.column_name AS to_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public'
  `);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const edges: GraphEdge[] = result.rows.map((r: any) => ({
    from: r.from_table as string,
    fromColumn: r.from_column as string,
    to: r.to_table as string,
    toColumn: r.to_column as string,
  }));

  const allTables = await getAllTables();
  const tables = allTables.filter(isTableExposed);
  const exposedEdges = edges.filter((e) => isTableExposed(e.from) && isTableExposed(e.to));

  graphCache = { edges: exposedEdges, tables, ts: Date.now() };
  return { edges: exposedEdges, tables };
}

export function invalidateGraphifyCache(): void {
  graphCache = null;
  rlsCache = null;
}

/** The graph this identity can see: readable tables and the edges between them. */
export async function buildGraphFor(
  access: GraphifyAccess
): Promise<{ edges: GraphEdge[]; tables: string[] }> {
  const graph = await buildGraph();
  if (access.isAdmin) return graph;
  const forcedItems = await tablesWithForcedRls();
  const view = (t: string) => canViewTable(t, access, forcedItems);
  return {
    tables: graph.tables.filter(view),
    edges: graph.edges.filter((e) => view(e.from) && view(e.to)),
  };
}

/**
 * Resolves how to get from `sourceTable` to `relation`:
 *   1. belongs-to  → source has an FK to relation (N:1)
 *   2. has-many    → relation has an FK to source (1:N)
 *   3. many-to-many→ a junction table exists with FKs to both
 */
export async function resolveRelation(
  sourceTable: string,
  relation: string
): Promise<RelationResolution | null> {
  const { edges } = await buildGraph();

  // N:1 — source → relation
  const belongsTo = edges.find((e) => e.from === sourceTable && e.to === relation);
  if (belongsTo) return { kind: "belongs-to", edge: belongsTo };

  // 1:N — relation → source
  const hasMany = edges.find((e) => e.from === relation && e.to === sourceTable);
  if (hasMany) return { kind: "has-many", edge: hasMany };

  // N:M — join table with FK to source AND FK to relation
  const edgesToSource = edges.filter((e) => e.to === sourceTable);
  for (const edgeToSource of edgesToSource) {
    const joinTable = edgeToSource.from;
    const edgeToTarget = edges.find((e) => e.from === joinTable && e.to === relation);
    if (edgeToTarget) {
      return {
        kind: "many-to-many",
        edge: edgeToSource,
        through: { table: joinTable, edgeToTarget },
      };
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// DYNAMIC QUERIES (identifiers validated against introspection)
// ═══════════════════════════════════════════════════════════════

async function requireTable(tableName: string, access: GraphifyAccess): Promise<IntrospectedTable> {
  assertIdentifier(tableName, "table");
  if (!isTableExposed(tableName)) {
    throw new GraphifyError(403, `Table '${tableName}' is not exposed by Graphify`);
  }
  // 404 and not 403: whoever cannot read it is not told that it exists
  if (!canViewTable(tableName, access, access.isAdmin ? new Set() : await tablesWithForcedRls())) {
    throw new GraphifyError(404, `Table '${tableName}' not found`);
  }
  const table = await introspectTable(tableName);
  if (!table) throw new GraphifyError(404, `Table '${tableName}' not found`);
  return table;
}

function requireColumn(table: IntrospectedTable, columnName: string): void {
  assertIdentifier(columnName, "column");
  if (!table.columns.some((col) => col.name === columnName)) {
    throw new GraphifyError(400, `Column '${columnName}' does not exist on '${table.name}'`);
  }
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  orderBy?: string;
  order?: "asc" | "desc";
  /** Equality filters column=value (validated columns) */
  filters?: Record<string, string>;
}

/**
 * Paginated list of a table, with optional equality filters.
 */
export async function listRows(
  executor: Executor,
  tableName: string,
  opts: ListOptions = {},
  access: GraphifyAccess = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ rows: any[]; limit: number; offset: number }> {
  const table = await requireTable(tableName, access);

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const orderBy = opts.orderBy ?? table.primaryKey[0] ?? table.columns[0]?.name ?? "id";
  requireColumn(table, orderBy);
  const orderDir = opts.order === "desc" ? sql.raw("DESC") : sql.raw("ASC");

  // Dynamic WHERE with parameterized placeholders (VALUES are never interpolated)
  const conditions = [];
  for (const [col, value] of Object.entries(opts.filters ?? {})) {
    requireColumn(table, col);
    conditions.push(sql`${sql.identifier(col)}::text = ${value}`);
  }
  const whereClause =
    conditions.length > 0 ? sql` WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

  const query = sql`
    SELECT * FROM ${sql.identifier(tableName)}${whereClause}
    ORDER BY ${sql.identifier(orderBy)} ${orderDir}
    LIMIT ${limit} OFFSET ${offset}
  `;

  const result = await executor.execute(query);
  return { rows: result.rows, limit, offset };
}

/**
 * Single record by primary key.
 */
export async function getRow(
  executor: Executor,
  tableName: string,
  id: string,
  access: GraphifyAccess = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  const table = await requireTable(tableName, access);
  const pk = table.primaryKey[0];
  if (!pk) throw new GraphifyError(400, `Table '${tableName}' has no primary key`);

  const result = await executor.execute(
    sql`SELECT * FROM ${sql.identifier(tableName)} WHERE ${sql.identifier(pk)}::text = ${id} LIMIT 1`
  );
  return result.rows[0] ?? null;
}

/**
 * Related rows — resolves JOINs automatically according to the direction
 * of the FK (belongs-to / has-many / many-to-many).
 */
export async function getRelatedRows(
  executor: Executor,
  tableName: string,
  id: string,
  relation: string,
  opts: ListOptions = {},
  access: GraphifyAccess = {}
): Promise<{
  kind: RelationResolution["kind"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[];
  limit: number;
  offset: number;
}> {
  const sourceTable = await requireTable(tableName, access);
  await requireTable(relation, access);

  const resolution = await resolveRelation(tableName, relation);
  if (!resolution) {
    throw new GraphifyError(
      404,
      `No relation found between '${tableName}' and '${relation}'. ` +
        `Check GET /api/graph for available edges.`
    );
  }

  const pk = sourceTable.primaryKey[0];
  if (!pk) throw new GraphifyError(400, `Table '${tableName}' has no primary key`);

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rows: any[] = [];

  if (resolution.kind === "belongs-to") {
    // source.fkColumn → relation.pk : returns the parent (0..1 rows)
    const { fromColumn, toColumn } = resolution.edge;
    const result = await executor.execute(sql`
      SELECT r.* FROM ${sql.identifier(relation)} r
      JOIN ${sql.identifier(tableName)} s
        ON s.${sql.identifier(fromColumn)} = r.${sql.identifier(toColumn)}
      WHERE s.${sql.identifier(pk)}::text = ${id}
      LIMIT ${limit} OFFSET ${offset}
    `);
    rows = result.rows;
  } else if (resolution.kind === "has-many") {
    // relation.fkColumn → source.pk : returns the children (0..N rows)
    const { fromColumn, toColumn } = resolution.edge;
    const result = await executor.execute(sql`
      SELECT r.* FROM ${sql.identifier(relation)} r
      JOIN ${sql.identifier(tableName)} s
        ON r.${sql.identifier(fromColumn)} = s.${sql.identifier(toColumn)}
      WHERE s.${sql.identifier(pk)}::text = ${id}
      LIMIT ${limit} OFFSET ${offset}
    `);
    rows = result.rows;
  } else {
    // many-to-many via join table
    const { edge: edgeToSource, through } = resolution;
    const { table: joinTable, edgeToTarget } = through!;
    const result = await executor.execute(sql`
      SELECT r.* FROM ${sql.identifier(relation)} r
      JOIN ${sql.identifier(joinTable)} j
        ON j.${sql.identifier(edgeToTarget.fromColumn)} = r.${sql.identifier(edgeToTarget.toColumn)}
      JOIN ${sql.identifier(tableName)} s
        ON j.${sql.identifier(edgeToSource.fromColumn)} = s.${sql.identifier(edgeToSource.toColumn)}
      WHERE s.${sql.identifier(pk)}::text = ${id}
      LIMIT ${limit} OFFSET ${offset}
    `);
    rows = result.rows;
  }

  return { kind: resolution.kind, rows, limit, offset };
}
