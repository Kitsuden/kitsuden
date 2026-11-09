/**
 * Inline Relations Service — Django-style Inlines
 *
 * Enables viewing and editing related records inline within parent forms:
 * - ForeignKey inlines (parent → children)
 * - Many-to-Many inlines with through table
 * - Tabular and Stacked layouts
 * - Nested inlines (limited depth)
 */

import { resolveExecutor } from "@kitsuden/engine";
import { sql } from "drizzle-orm";

import { db } from "../db";
import {
  isForbiddenNativeTable,
  isSecretColumn,
  tableIsExplorable,
  withoutSecretColumns,
} from "../lib/explorable-tables";

import { introspectTable } from "./schema-introspector";

/**
 * ── THE DENY-LIST HERE TOO (security review 2026-11-04, F10/F69) ───────────
 *
 * A table's children come from `information_schema`: any table with an FK to
 * `<parent>.id`. With `auth_users` as the parent, that was `auth_accounts`
 * (password hashes and OAuth tokens), `auth_sessions` and `api_keys`, and the
 * POST rewrote a credential with column names chosen by the caller. Now the
 * parent and every child go through the explorer's gate (`tableIsExplorable`,
 * plus every `auth_*` table except `auth_users`, as in MCP), rows leave
 * without secret columns, and a write only names real, non-secret columns.
 *
 * Platform tables the explorer shows although no kon declares them (SQL
 * names; the explorer's registry has them by key).
 */
const CORE_REGISTRY = [
  "auth_users",
  "media",
  "data_sets",
  "data_entries",
  "site_settings",
  "modules",
];

/** Can this table be the parent or the child of an inline relation? */
export async function inlineTableAllowed(name: string): Promise<boolean> {
  if (isForbiddenNativeTable(name)) return false;
  return (await tableIsExplorable(name, CORE_REGISTRY)).allowed;
}

/** The request's executor (transaction with RLS context) or, outside one, the global db. */
const exec = (): typeof db => resolveExecutor(db) as typeof db;

/** Inline configuration for a relationship */
export interface InlineConfig {
  /** Name of the inline relationship */
  name: string;

  /** Label for the UI */
  label: string;

  /** Type of inline */
  type: "fk" | "m2m" | "generic";

  /** Table containing the related records */
  table: string;

  /** Foreign key column in the related table pointing to parent */
  fkColumn: string;

  /** Columns to display in the inline */
  fields: string[];

  /** Whether inline is editable */
  editable?: boolean;

  /** Whether records can be added */
  canAdd?: boolean;

  /** Whether records can be deleted */
  canDelete?: boolean;

  /** Maximum number of inline records to show */
  maxCount?: number;

  /** Layout style */
  layout?: "tabular" | "stacked";

  /** Sort field */
  sortField?: string;
}

/** Data returned for an inline relationship */

export interface InlineData {
  config: InlineConfig;

  records: Record<string, unknown>[];
  totalCount: number;
  canAddMore: boolean;
}

/** Information about a relation between tables */
export interface RelationInfo {
  /** Column in parent table that is a FK */
  column: string;

  /** Table being referenced */
  relatedTable: string;

  /** Column in related table */
  relatedColumn: string;

  /** Type of relation */
  type: "belongs_to" | "has_many" | "many_to_many";

  /** For has_many: column in child table pointing to parent */
  inverseColumn?: string;
}

/** Query row from database execution */

interface QueryRow extends Record<string, unknown> {}

/**
 * Detect all relations for a table
 */
export async function detectRelations(tableName: string): Promise<RelationInfo[]> {
  const introspected = await introspectTable(tableName);
  if (!introspected) return [];

  const relations: RelationInfo[] = [];

  // 1. Detect outgoing FKs (belongs_to)
  for (const col of introspected.columns) {
    if (col.isForeignKey && col.foreignTable) {
      relations.push({
        column: col.name,
        relatedTable: col.foreignTable,
        relatedColumn: col.foreignColumn || "id",
        type: "belongs_to",
      });
    }
  }

  // 2. Detect incoming relations (has_many)
  // Find tables that have FKs pointing to this table
  try {
    const result = await db.execute(sql`
      SELECT
        tc.table_name as child_table,
        kcu.column_name as fk_column,
        ccu.table_name as parent_table,
        ccu.column_name as parent_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = ${tableName}
      AND ccu.column_name = 'id'
    `);

    for (const row of result.rows as QueryRow[]) {
      // Avoid self-referential loops
      if (row.child_table !== tableName) {
        relations.push({
          column: "id", // parent's id is referenced
          relatedTable: row.child_table as string,
          relatedColumn: row.parent_column as string,
          type: "has_many",
          inverseColumn: row.fk_column as string,
        });
      }
    }
  } catch (err) {
    console.error(`[InlineRelations] Failed to detect incoming relations for ${tableName}:`, err);
  }

  // 3. Detect many-to-many through junction tables
  try {
    // Find potential junction tables (contain two FKs)
    const result = await db.execute(sql`
      SELECT 
        tc.table_name as junction_table,
        COUNT(*) as fk_count
      FROM information_schema.table_constraints tc
      WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_name IN (
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
      )
      GROUP BY tc.table_name
      HAVING COUNT(*) = 2
    `);

    for (const row of result.rows as QueryRow[]) {
      // Check if this junction table references our table
      const refsResult = await db.execute(sql`
        SELECT
          kcu.column_name,
          ccu.table_name as referenced_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = ${row.junction_table}
      `);

      const refs = refsResult.rows as QueryRow[];
      const hasCurrentTable = refs.some((r) => r.referenced_table === tableName);

      if (hasCurrentTable && refs.length === 2) {
        const otherRef = refs.find((r) => r.referenced_table !== tableName);
        if (otherRef) {
          relations.push({
            column: "id",
            relatedTable: otherRef.referenced_table as string,
            relatedColumn: "id",
            type: "many_to_many",
          });
        }
      }
    }
  } catch (err) {
    console.error(`[InlineRelations] Failed to detect M2M relations for ${tableName}:`, err);
  }

  return relations;
}

/**
 * Generate inline configs for a table
 */
export async function generateInlineConfigs(tableName: string): Promise<InlineConfig[]> {
  // Neither the parent nor the children outside the white list, nor forbidden.
  if (!(await inlineTableAllowed(tableName))) return [];
  const relations = await detectRelations(tableName);
  const configs: InlineConfig[] = [];

  for (const relation of relations) {
    // Only create inlines for has_many relations
    if (relation.type !== "has_many" || !relation.inverseColumn) continue;
    if (!(await inlineTableAllowed(relation.relatedTable))) continue;

    // Introspect the child table to get field suggestions
    const childIntrospected = await introspectTable(relation.relatedTable);
    if (!childIntrospected) continue;

    // Pick fields to display (exclude FK to parent, metadata and secrets)
    const visible = childIntrospected.columns.filter((c) => !isSecretColumn(c.name));
    const fields = visible
      .filter(
        (c) =>
          c.name !== relation.inverseColumn &&
          c.name !== "id" &&
          !c.name.endsWith("_id") &&
          !c.name.endsWith("At") &&
          !c.name.startsWith("created") &&
          !c.name.startsWith("updated")
      )
      .slice(0, 5) // Max 5 fields
      .map((c) => c.name);

    // Add some meaningful fields if we filtered too aggressively
    if (fields.length === 0) {
      fields.push(
        ...visible
          .filter((c) => c.name !== "id" && c.name !== relation.inverseColumn)
          .slice(0, 3)
          .map((c) => c.name)
      );
    }

    configs.push({
      name: relation.relatedTable,
      label: humanize(relation.relatedTable),
      type: "fk",
      table: relation.relatedTable,
      fkColumn: relation.inverseColumn,
      fields,
      editable: true,
      canAdd: true,
      canDelete: true,
      maxCount: 10,
      layout: "tabular",
      sortField: childIntrospected.columns.find(
        (c) => c.name === "created_at" || c.name === "sort_order"
      )?.name,
    });
  }

  return configs;
}

/**
 * Fetch inline data for a parent record
 */
export async function fetchInlineData(
  config: InlineConfig,
  parentId: string,
  options: { page?: number; limit?: number } = {}
): Promise<InlineData> {
  const { page = 1, limit = 10 } = options;
  const offset = (page - 1) * limit;

  try {
    // Build query dynamically
    const result = await exec().execute(sql`
      SELECT *
      FROM ${sql.identifier(config.table)}
      WHERE ${sql.identifier(config.fkColumn)} = ${parentId}
      ${config.sortField ? sql`ORDER BY ${sql.identifier(config.sortField)} DESC` : sql``}
      LIMIT ${limit}
      OFFSET ${offset}
    `);

    // Get total count
    const countResult = await exec().execute(sql`
      SELECT COUNT(*) as count
      FROM ${sql.identifier(config.table)}
      WHERE ${sql.identifier(config.fkColumn)} = ${parentId}
    `);

    const totalCount = parseInt((countResult.rows[0] as QueryRow).count as string);

    return {
      config,
      // Not even an admin is shown a token or a hash this way.
      records: withoutSecretColumns(result.rows) as Record<string, unknown>[],
      totalCount,
      canAddMore: !config.maxCount || totalCount < config.maxCount,
    };
  } catch (err) {
    console.error(`[InlineRelations] Failed to fetch inline data:`, err);
    return {
      config,
      records: [],
      totalCount: 0,
      canAddMore: false,
    };
  }
}

/** Inline record with optional id */
interface InlineRecord {
  id?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * What is wrong with this write? `null` if nothing.
 *
 * Column names go to `sql.identifier`, so they do not inject SQL, but they do
 * choose WHAT gets written: only real columns of the table, and never a
 * secret one (password, token, key hash).
 */
export function inlineRecordsProblem(
  records: unknown,
  deletedIds: unknown,
  columns: ReadonlySet<string>
): string | null {
  if (!Array.isArray(records)) return "'records' must be an array";
  if (!Array.isArray(deletedIds) || deletedIds.some((id) => typeof id !== "string")) {
    return "'deletedIds' must be an array of ids";
  }
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return "Each record must be an object";
    }
    for (const column of Object.keys(record)) {
      if (isSecretColumn(column)) return `Column '${column}' cannot be written here`;
      if (!columns.has(column)) return `Unknown column '${column}'`;
    }
  }
  return null;
}

/**
 * Save inline records (create/update/delete)
 */
export async function saveInlineRecords(
  tableName: string,
  fkColumn: string,
  parentId: string,
  records: InlineRecord[],
  deletedIds: string[] = []
): Promise<{ success: boolean; error?: string }> {
  // The child table's real columns, from `information_schema`.
  const child = await introspectTable(tableName);
  if (!child) return { success: false, error: `Table '${tableName}' not found` };
  const problem = inlineRecordsProblem(
    records,
    deletedIds,
    new Set(child.columns.map((c) => c.name))
  );
  if (problem) return { success: false, error: problem };

  try {
    // Delete removed records
    if (deletedIds.length > 0) {
      const idPlaceholders = deletedIds.map((id: string) => sql`${id}`);
      await exec().execute(sql`
        DELETE FROM ${sql.identifier(tableName)}
        WHERE id IN (${sql.join(idPlaceholders, sql`, `)})
        AND ${sql.identifier(fkColumn)} = ${parentId}
      `);
    }

    // Upsert records
    for (const record of records) {
      const data = { ...record, [fkColumn]: parentId };

      if (record.id) {
        // Update
        const { id, ...updateData } = data;
        const entries = Object.entries(updateData);
        await exec().execute(sql`
          UPDATE ${sql.identifier(tableName)}
          SET ${sql.join(
            entries.map(([k, v]) => sql`${sql.identifier(k)} = ${v}`),
            sql`, `
          )}
          WHERE id = ${id}
          AND ${sql.identifier(fkColumn)} = ${parentId}
        `);
      } else {
        // Insert
        const keys = Object.keys(data);
        const values = Object.values(data);
        await exec().execute(sql`
          INSERT INTO ${sql.identifier(tableName)} (${sql.join(
            keys.map((k) => sql.identifier(k)),
            sql`, `
          )})
          VALUES (${sql.join(
            values.map((v) => sql`${v}`),
            sql`, `
          )})
        `);
      }
    }

    return { success: true };
  } catch (err) {
    console.error(`[InlineRelations] Failed to save inline records:`, err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to save records",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function humanize(str: string): string {
  return str
    .replace(/_/g, " ")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}
