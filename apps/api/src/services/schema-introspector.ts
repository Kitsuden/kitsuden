/**
 * Schema Introspector Service — True Zero Config
 *
 * Auto-discovers database schema for any table:
 * - Column names, types, constraints
 * - Primary keys, foreign keys
 * - Indexes, defaults
 * - Relations between tables
 *
 * Enables any table to work without manual configuration.
 */

import { sql } from "drizzle-orm";

import { db } from "../db";

export interface IntrospectedColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  foreignTable: string | null;
  foreignColumn: string | null;
  maxLength: number | null;
  isUnique: boolean;
  isIndexed: boolean;
}

export interface IntrospectedTable {
  name: string;
  schema: string;
  columns: IntrospectedColumn[];
  primaryKey: string[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
  estimatedRowCount: number;
}

export interface ForeignKeyInfo {
  column: string;
  foreignTable: string;
  foreignColumn: string;
  constraintName: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

/** Admin column config generated from introspection */
export interface AdminColumnConfig {
  name: string;
  label: string;
  type: string;
  searchable: boolean;
  filterable: boolean;
  relation?: { table: string; displayField: string };
}

/** Admin config generated from introspection */
export interface AdminConfig {
  table: string;
  label: string;
  icon: string;
  columns: AdminColumnConfig[];
  defaultSort: { column: string; direction: "asc" | "desc" };
}

/** Query row from database execution */

interface QueryRow extends Record<string, unknown> {}

// Cache for introspection results
interface CacheEntry {
  data: IntrospectedTable;
  timestamp: number;
}

const introspectionCache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Introspect any table in the database
 */
export async function introspectTable(
  tableName: string,
  schema = "public"
): Promise<IntrospectedTable | null> {
  const cacheKey = `${schema}.${tableName}`;
  const cached = introspectionCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  try {
    // Check if table exists
    const tableExists = await checkTableExists(tableName, schema);
    if (!tableExists) {
      return null;
    }

    // Get all column info
    const columns = await getColumns(tableName, schema);
    const primaryKey = await getPrimaryKey(tableName, schema);
    const foreignKeys = await getForeignKeys(tableName, schema);
    const indexes = await getIndexes(tableName, schema);
    const rowCount = await getEstimatedRowCount(tableName, schema);

    // Enhance columns with FK info
    const enhancedColumns = columns.map((col) => {
      const fk = foreignKeys.find((fk) => fk.column === col.name);
      return {
        ...col,
        isForeignKey: !!fk,
        foreignTable: fk?.foreignTable || null,
        foreignColumn: fk?.foreignColumn || null,
      };
    });

    const result: IntrospectedTable = {
      name: tableName,
      schema,
      columns: enhancedColumns,
      primaryKey,
      foreignKeys,
      indexes,
      estimatedRowCount: rowCount,
    };

    // Cache result
    introspectionCache.set(cacheKey, { data: result, timestamp: Date.now() });

    return result;
  } catch (err) {
    console.error(`[SchemaIntrospector] Failed to introspect ${tableName}:`, err);
    return null;
  }
}

/**
 * Get all tables in the database
 */
export async function getAllTables(schema = "public"): Promise<string[]> {
  try {
    const result = await db.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = ${schema}
      AND table_type = 'BASE TABLE'
      AND table_name NOT LIKE 'pg_%'
      AND table_name NOT LIKE '_prisma_%'
      ORDER BY table_name
    `);

    return result.rows.map((r: QueryRow) => r.table_name as string);
  } catch (err) {
    console.error("[SchemaIntrospector] Failed to get tables:", err);
    return [];
  }
}

/**
 * Search tables by name pattern
 */
export async function searchTables(pattern: string, schema = "public"): Promise<string[]> {
  const tables = await getAllTables(schema);
  // A substring, not a regular expression: `(a+)+$` from the query string
  // blocked the event loop (security review 2026-11-03).
  const needle = pattern.toLowerCase();
  return tables.filter((t) => t.toLowerCase().includes(needle));
}

/**
 * Get tables related to a table (via FKs)
 */
export async function getRelatedTables(
  tableName: string,
  schema = "public"
): Promise<{
  incoming: string[];
  outgoing: string[];
}> {
  const introspected = await introspectTable(tableName, schema);
  if (!introspected) return { incoming: [], outgoing: [] };

  // Outgoing: tables this table references
  const outgoing = introspected.foreignKeys.map((fk) => fk.foreignTable);

  // Incoming: tables that reference this table
  try {
    const result = await db.execute(sql`
      SELECT
        tc.table_name as referencing_table
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = ${tableName}
      AND ccu.table_schema = ${schema}
      GROUP BY tc.table_name
    `);

    const incoming = result.rows.map((r: QueryRow) => r.referencing_table as string);

    return { incoming, outgoing };
  } catch (err) {
    console.error(`[SchemaIntrospector] Failed to get related tables for ${tableName}:`, err);
    return { incoming: [], outgoing };
  }
}

/**
 * Generate AdminConfig from introspected table
 */
export async function generateAdminConfigFromIntrospection(
  tableName: string,
  schema = "public"
): Promise<AdminConfig> {
  const introspected = await introspectTable(tableName, schema);
  if (!introspected) {
    throw new Error(`Table ${tableName} not found`);
  }

  // Determine icon based on table name
  const icon = getTableIcon(tableName);

  // Process columns
  const columns = introspected.columns.map((col): AdminColumnConfig => {
    const inferredType = inferAdminType(col);

    const result: AdminColumnConfig = {
      name: col.name,
      label: humanizeColumnName(col.name),
      type: inferredType,
      searchable: isSearchableType(col),
      filterable: isFilterableType(col),
    };

    // Add relation info for FKs
    if (col.isForeignKey && col.foreignTable) {
      result.relation = {
        table: col.foreignTable,
        displayField: inferDisplayField(col.foreignTable),
      };
    }

    return result;
  });

  // Determine default sort (prefer created_at, updated_at, or first column)
  const timeColumn = introspected.columns.find(
    (c) => c.name === "created_at" || c.name === "createdAt"
  );
  const defaultSort: { column: string; direction: "asc" | "desc" } = {
    column: timeColumn?.name || introspected.primaryKey[0] || columns[0]?.name || "id",
    direction: timeColumn ? "desc" : "asc",
  };

  return {
    table: tableName,
    label: humanizeTableName(tableName),
    icon,
    columns,
    defaultSort,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ═══════════════════════════════════════════════════════════════════════════

async function checkTableExists(tableName: string, schema: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 
      FROM information_schema.tables 
      WHERE table_schema = ${schema} 
      AND table_name = ${tableName}
    )
  `);
  return result.rows[0]?.exists === true;
}

async function getColumns(tableName: string, schema: string): Promise<IntrospectedColumn[]> {
  const result = await db.execute(sql`
    SELECT 
      c.column_name,
      c.data_type,
      c.is_nullable,
      c.column_default,
      c.character_maximum_length,
      CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key,
      CASE WHEN uk.column_name IS NOT NULL THEN true ELSE false END as is_unique
    FROM information_schema.columns c
    LEFT JOIN (
      SELECT ku.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage ku 
        ON tc.constraint_name = ku.constraint_name
      WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_name = ${tableName}
      AND tc.table_schema = ${schema}
    ) pk ON c.column_name = pk.column_name
    LEFT JOIN (
      SELECT ku.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage ku 
        ON tc.constraint_name = ku.constraint_name
      WHERE tc.constraint_type = 'UNIQUE'
      AND tc.table_name = ${tableName}
      AND tc.table_schema = ${schema}
    ) uk ON c.column_name = uk.column_name
    WHERE c.table_name = ${tableName}
    AND c.table_schema = ${schema}
    ORDER BY c.ordinal_position
  `);

  return result.rows.map(
    (r: QueryRow): IntrospectedColumn => ({
      name: r.column_name as string,
      type: r.data_type as string,
      nullable: r.is_nullable === "YES",
      defaultValue: r.column_default as string | null,
      isPrimaryKey: r.is_primary_key as boolean,
      isForeignKey: false, // Will be set later
      foreignTable: null,
      foreignColumn: null,
      maxLength: r.character_maximum_length as number | null,
      isUnique: r.is_unique as boolean,
      isIndexed: r.is_primary_key as boolean, // PKs are always indexed
    })
  );
}

async function getPrimaryKey(tableName: string, schema: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT ku.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage ku 
      ON tc.constraint_name = ku.constraint_name
    WHERE tc.constraint_type = 'PRIMARY KEY'
    AND tc.table_name = ${tableName}
    AND tc.table_schema = ${schema}
    ORDER BY ku.ordinal_position
  `);

  return result.rows.map((r: QueryRow) => r.column_name as string);
}

async function getForeignKeys(tableName: string, schema: string): Promise<ForeignKeyInfo[]> {
  const result = await db.execute(sql`
    SELECT
      kcu.column_name,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name,
      tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_name = ${tableName}
    AND tc.table_schema = ${schema}
  `);

  return result.rows.map(
    (r: QueryRow): ForeignKeyInfo => ({
      column: r.column_name as string,
      foreignTable: r.foreign_table_name as string,
      foreignColumn: r.foreign_column_name as string,
      constraintName: r.constraint_name as string,
    })
  );
}

async function getIndexes(tableName: string, schema: string): Promise<IndexInfo[]> {
  const result = await db.execute(sql`
    SELECT
      i.relname as index_name,
      ix.indisunique as is_unique,
      ix.indisprimary as is_primary,
      array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) as columns
    FROM pg_index ix
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE t.relname = ${tableName}
    AND n.nspname = ${schema}
    GROUP BY i.relname, ix.indisunique, ix.indisprimary
  `);

  return result.rows.map(
    (r: QueryRow): IndexInfo => ({
      name: r.index_name as string,
      columns: r.columns as string[],
      unique: r.is_unique as boolean,
      primary: r.is_primary as boolean,
    })
  );
}

async function getEstimatedRowCount(tableName: string, schema: string): Promise<number> {
  try {
    const result = await db.execute(sql`
      SELECT n_live_tup as estimate
      FROM pg_stat_user_tables
      WHERE relname = ${tableName}
      AND schemaname = ${schema}
    `);
    const estimate = (result.rows[0] as QueryRow)?.estimate;
    return parseInt(estimate as string) || 0;
  } catch {
    return 0;
  }
}

function inferAdminType(col: IntrospectedColumn): string {
  const type = col.type.toLowerCase();

  if (col.isForeignKey) return "relation";
  if (type.includes("uuid") && col.name === "id") return "id";
  if (type.includes("bool")) return "boolean";
  if (
    type.includes("int") ||
    type.includes("decimal") ||
    type.includes("numeric") ||
    type.includes("float") ||
    type.includes("double")
  )
    return "number";
  if (type.includes("timestamp") || type.includes("datetime")) return "datetime";
  if (type.includes("date")) return "date";
  if (type.includes("json")) return "json";
  if (type.includes("text")) return "text";
  if (col.name.includes("email")) return "email";
  if (col.name.includes("url") || col.name.includes("link")) return "url";
  if (col.name.includes("color")) return "color";
  if (col.name.includes("password")) return "password";

  return "text";
}

function isSearchableType(col: IntrospectedColumn): boolean {
  const searchableTypes = ["text", "varchar", "char"];
  const type = col.type.toLowerCase();

  // Also check common searchable field names
  const searchableNames = ["name", "title", "label", "email", "description", "slug"];

  return (
    searchableTypes.some((t) => type.includes(t)) ||
    searchableNames.some((n) => col.name.toLowerCase().includes(n))
  );
}

function isFilterableType(col: IntrospectedColumn): boolean {
  // Skip certain columns from filtering
  if (col.name === "id") return false;
  if (col.name.endsWith("_id") && col.name !== "id") return true; // FKs are filterable
  if (col.type.toLowerCase().includes("json")) return false;

  return true;
}

function getTableIcon(tableName: string): string {
  const icons: Record<string, string> = {
    users: "Users",
    accounts: "UserCircle",
    products: "Package",
    orders: "ShoppingCart",
    categories: "Tags",
    tags: "Tag",
    posts: "FileText",
    articles: "Newspaper",
    media: "Image",
    files: "File",
    comments: "MessageCircle",
    reviews: "Star",
    settings: "Settings",
    logs: "Scroll",
    events: "Calendar",
    bookings: "CalendarDays",
    payments: "CreditCard",
    subscriptions: "Repeat",
    notifications: "Bell",
    messages: "Mail",
  };

  const normalized = tableName.toLowerCase().replace(/_/g, "");
  return icons[normalized] || "Table";
}

function inferDisplayField(_foreignTable: string): string {
  const commonFields = ["name", "title", "label", "email", "username"];
  return commonFields[0];
}

function humanizeColumnName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

function humanizeTableName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/^kon[-_]/, "")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

/**
 * Clear introspection cache
 */
export function clearIntrospectionCache() {
  introspectionCache.clear();
}
