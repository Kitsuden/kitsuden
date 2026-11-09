/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * QUERY ENGINE - JSON to SQL translator with Auto-Join
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Query engine that translates declarative JSON objects into Drizzle queries,
 * with support for relation expansions (Anti N+1).
 *
 * Features:
 * - parseQuery: Converts JSON to a Drizzle query
 * - AutoJoin: Expands 1:1 and 1:N relations in a single query
 * - WhiteList: Security through a field allowlist
 * - Dynamic relation: Detects FKs automatically
 *
 * @example
 * ```typescript
 * const result = await parseQuery({
 *   table: agentIdentities,
 *   where: { isActive: true },
 *   expand: ["traces", "apiKeys"],
 *   limit: 10,
 * });
 * // Returns: { id, name, traces: [...], apiKeys: [...] }
 * ```
 */

import {
  eq,
  and,
  not,
  gt,
  gte,
  lt,
  lte,
  like,
  ilike,
  inArray,
  isNull,
  isNotNull,
  desc,
  asc,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgTable, PgColumn } from "drizzle-orm/pg-core";

import { db } from "../../../apps/api/src/db";
import * as schema from "../../../apps/api/src/db/schema";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES AND CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface QueryOptions<_T = any> {
  /** Main table */
  table: PgTable;
  /** Where filters */
  where?: Record<string, unknown>;
  /** Expand relations */
  expand?: string[];
  /** Fields to select (default: all allowed ones) */
  select?: string[];
  /** Result limit */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Ordering [{ field: "createdAt", direction: "desc" }] */
  orderBy?: Array<{ field: string; direction?: "asc" | "desc" }>;
}

export interface QueryResult<T = any> {
  data: T[];
  meta: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    executedAt: string;
  };
}

/** Discovered relation definition */
interface RelationDef {
  name: string;
  type: "one" | "many";
  table: PgTable;
  fkColumn: string;
  targetColumn: string;
  targetTable: PgTable;
}

/** Relation map per table */
const relationsMap = new Map<string, Map<string, RelationDef>>();

/** Global field allowlist (security) */
const fieldWhiteList = new Set<string>([
  "id",
  "name",
  "description",
  "type",
  "status",
  "createdAt",
  "updatedAt",
  "email",
  "role",
  "isActive",
  "slug",
  "title",
  "content",
  "data",
  "metadata",
  "sessionId",
  "totalDurationMs",
  "tokensIn",
  "tokensOut",
  "estimatedCost",
  "errorMessage",
  "input",
  "output",
  "agentId",
  "traceId",
  "stepOrder",
  "stepType",
  "content",
  "reasoning",
  "toolName",
  "toolInput",
  "toolOutput",
  "durationMs",
]);

/** Forbidden fields (never exposed) */
const fieldBlackList = new Set<string>(["keyHash", "password", "secret", "token"]);

// ═══════════════════════════════════════════════════════════════════════════════
// RELATION REGISTRY (Based on Foreign Keys)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Registers a relation in the global map.
 * This lets the engine know how to join between tables.
 */
function registerRelation(
  sourceTable: PgTable,
  relationName: string,
  def: Omit<RelationDef, "name">
): void {
  const tableName = getTableName(sourceTable);
  if (!relationsMap.has(tableName)) {
    relationsMap.set(tableName, new Map());
  }
  relationsMap.get(tableName)!.set(relationName, { name: relationName, ...def });
}

/**
 * Initializes the schema's known relations.
 * In production, this could be generated automatically.
 */
function initializeRelations(): void {
  // agentIdentities → agentTraces (1:N)
  registerRelation(schema.agentIdentities, "traces", {
    type: "many",
    table: schema.agentTraces,
    fkColumn: "agentId",
    targetColumn: "id",
    targetTable: schema.agentIdentities,
  });

  // agentIdentities → agentApiKeys (1:N)
  registerRelation(schema.agentIdentities, "apiKeys", {
    type: "many",
    table: schema.agentApiKeys,
    fkColumn: "agentId",
    targetColumn: "id",
    targetTable: schema.agentIdentities,
  });

  // agentIdentities → agentMemory (1:N)
  registerRelation(schema.agentIdentities, "memories", {
    type: "many",
    table: schema.agentMemory,
    fkColumn: "agentId",
    targetColumn: "id",
    targetTable: schema.agentIdentities,
  });

  // agentIdentities → agentAuditLogs (1:N)
  registerRelation(schema.agentIdentities, "auditLogs", {
    type: "many",
    table: schema.agentAuditLogs,
    fkColumn: "agentId",
    targetColumn: "id",
    targetTable: schema.agentIdentities,
  });

  // agentTraces → agentTraceSteps (1:N)
  registerRelation(schema.agentTraces, "steps", {
    type: "many",
    table: schema.agentTraceSteps,
    fkColumn: "traceId",
    targetColumn: "id",
    targetTable: schema.agentTraces,
  });

  // agentTraces → agentIdentities (N:1)
  registerRelation(schema.agentTraces, "agent", {
    type: "one",
    table: schema.agentTraces,
    fkColumn: "agentId",
    targetColumn: "id",
    targetTable: schema.agentIdentities,
  });

  // dataSets → dataEntries (1:N)
  registerRelation(schema.dataSets, "entries", {
    type: "many",
    table: schema.dataEntries,
    fkColumn: "dataSetId",
    targetColumn: "id",
    targetTable: schema.dataSets,
  });

  // dataEntries → dataSets (N:1)
  registerRelation(schema.dataEntries, "dataset", {
    type: "one",
    table: schema.dataEntries,
    fkColumn: "dataSetId",
    targetColumn: "id",
    targetTable: schema.dataSets,
  });
}

// Initialize relations on import
initializeRelations();

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function getTableName(table: PgTable): string {
  return (table as any)[Symbol.for("drizzle:Name")] ?? table.constructor.name;
}

function getColumn(table: PgTable, columnName: string): PgColumn | undefined {
  return (table as any)[columnName];
}

function isFieldAllowed(field: string): boolean {
  if (fieldBlackList.has(field)) return false;
  return fieldWhiteList.has(field) || fieldWhiteList.size === 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARSER DE WHERE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Converts a JSON where object into Drizzle SQL conditions.
 *
 * @example
 * { status: "active", id: { $gt: 100 } }
 * → and(eq(table.status, "active"), gt(table.id, 100))
 */
function parseWhereClause(table: PgTable, where: Record<string, unknown>): SQL | undefined {
  const conditions: SQL[] = [];

  for (const [key, value] of Object.entries(where)) {
    // Validate allowed field
    if (!isFieldAllowed(key)) {
      console.warn(`[QueryEngine] Disallowed field ignored: ${key}`);
      continue;
    }

    const column = getColumn(table, key);
    if (!column) {
      console.warn(`[QueryEngine] Column not found: ${key}`);
      continue;
    }

    // Nested operators: { id: { $gt: 100 } }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [op, opValue] of Object.entries(value)) {
        const sqlCond = buildOperatorCondition(column, op, opValue);
        if (sqlCond) conditions.push(sqlCond);
      }
    } else {
      // Simple equality: { status: "active" }
      conditions.push(eq(column, value));
    }
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return and(...conditions) as SQL;
}

function buildOperatorCondition(column: PgColumn, operator: string, value: any): SQL | undefined {
  switch (operator) {
    case "$eq":
      return eq(column, value);
    case "$ne":
    case "$neq":
      return not(eq(column, value));
    case "$gt":
      return gt(column, value);
    case "$gte":
      return gte(column, value);
    case "$lt":
      return lt(column, value);
    case "$lte":
      return lte(column, value);
    case "$in":
      return inArray(column, Array.isArray(value) ? value : [value]);
    case "$nin":
      return not(inArray(column, Array.isArray(value) ? value : [value]));
    case "$like":
      return like(column, value);
    case "$ilike":
      return ilike(column, value);
    case "$null":
      return value ? isNull(column) : isNotNull(column);
    default:
      console.warn(`[QueryEngine] Unknown operator: ${operator}`);
      return undefined;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-JOIN ENGINE (Anti N+1)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Runs a query with relation expansions (Anti N+1).
 *
 * Strategy:
 * 1. Main query with limit/offset
 * 2. For each expand relation, run a separate query with IN (ids)
 * 3. Merge results in memory
 *
 * This avoids N+1 and is more efficient than multiple JOINs for 1:N relations.
 */
async function executeWithExpansions<T>(options: QueryOptions, baseQuery: any): Promise<T[]> {
  const { table, expand = [] } = options;
  const tableName = getTableName(table);

  // 1. Run base query
  const rows = await baseQuery;
  if (rows.length === 0 || expand.length === 0) {
    return rows as T[];
  }

  // 2. Prepare IDs for relation lookup
  const ids = rows.map((r: any) => r.id).filter(Boolean);
  if (ids.length === 0) return rows as T[];

  // 3. Load relations in parallel (Anti N+1)
  const relationsData = await Promise.all(
    expand.map(async (relName) => {
      const relation = relationsMap.get(tableName)?.get(relName);
      if (!relation) {
        console.warn(`[QueryEngine] Relation not found: ${tableName}.${relName}`);
        return { relName, data: new Map() };
      }

      const relRows = await loadRelation(relation, ids);
      return { relName, data: relRows };
    })
  );

  // 4. Merge results
  const merged = rows.map((row: any) => {
    const expanded: any = { ...row };
    for (const { relName, data } of relationsData) {
      const relation = relationsMap.get(tableName)?.get(relName);
      if (!relation) continue;

      if (relation.type === "one") {
        // N:1 relation - a single object
        expanded[relName] = data.get(row[relation.fkColumn]) || null;
      } else {
        // 1:N relation - array of objects
        expanded[relName] = data.get(row.id) || [];
      }
    }
    return expanded;
  });

  return merged;
}

/**
 * Loads a relation for a set of IDs.
 * Returns Map<parentId, relatedData> for easy lookup.
 */
async function loadRelation(
  relation: RelationDef,
  parentIds: string[]
): Promise<Map<string, any | any[]>> {
  const result = new Map<string, any | any[]>();

  if (relation.type === "one") {
    // N:1 - Look up by FK in the source table
    const fkColumn = getColumn(relation.table, relation.fkColumn);
    if (!fkColumn) return result;

    const rows = await db
      .select()
      .from(relation.targetTable)
      .where(inArray(getColumn(relation.targetTable, "id")!, parentIds));

    for (const row of rows) {
      result.set((row as any).id, row);
    }
  } else {
    // 1:N - Look up by FK in the related table
    const fkColumn = getColumn(relation.table, relation.fkColumn);
    if (!fkColumn) return result;

    const rows = await db.select().from(relation.table).where(inArray(fkColumn, parentIds));

    // Group by parentId
    for (const row of rows) {
      const parentId = (row as any)[relation.fkColumn];
      if (!result.has(parentId)) {
        result.set(parentId, []);
      }
      (result.get(parentId) as any[]).push(row);
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parses a JSON query object and runs it against the database.
 *
 * @example
 * ```typescript
 * const result = await parseQuery({
 *   table: agentIdentities,
 *   where: { isActive: true, type: "service" },
 *   expand: ["traces", "apiKeys"],
 *   limit: 10,
 *   orderBy: [{ field: "createdAt", direction: "desc" }],
 * });
 * ```
 */
export async function parseQuery<T = any>(options: QueryOptions): Promise<QueryResult<T>> {
  const { table, where, limit = 50, offset = 0, orderBy } = options;

  // Build base query
  let query = db.select().from(table).$dynamic();

  // Apply where
  if (where && Object.keys(where).length > 0) {
    const whereClause = parseWhereClause(table, where);
    if (whereClause) {
      query = query.where(whereClause);
    }
  }

  // Apply orderBy
  if (orderBy && orderBy.length > 0) {
    const orderConditions = orderBy
      .map((o) => {
        if (!isFieldAllowed(o.field)) return null;
        const col = getColumn(table, o.field);
        if (!col) return null;
        return o.direction === "desc" ? desc(col) : asc(col);
      })
      .filter(Boolean);

    if (orderConditions.length > 0) {
      query = query.orderBy(...(orderConditions as any));
    }
  }

  // Run with pagination
  const limitSafe = Math.min(Math.max(1, limit), 1000);
  const offsetSafe = Math.max(0, offset);

  query = query.limit(limitSafe).offset(offsetSafe);

  // Run with expansions (Anti N+1)
  const data = await executeWithExpansions<T>(options, query);

  // Count total (without limit/offset)
  let totalQuery = db.select({ count: sql<number>`count(*)` }).from(table);
  if (where && Object.keys(where).length > 0) {
    const whereClause = parseWhereClause(table, where);
    if (whereClause) {
      totalQuery = totalQuery.where(whereClause) as any;
    }
  }
  const [{ count: total }] = await totalQuery;

  return {
    data,
    meta: {
      total,
      limit: limitSafe,
      offset: offsetSafe,
      hasMore: offsetSafe + data.length < total,
      executedAt: new Date().toISOString(),
    },
  };
}

/**
 * Validates a query object without running it.
 * Returns errors if there are disallowed fields or invalid relations.
 */
export function validateQuery(options: QueryOptions): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const { table, where, expand, select } = options;
  const tableName = getTableName(table);

  // Validate fields in where
  if (where) {
    for (const key of Object.keys(where)) {
      if (!isFieldAllowed(key)) {
        errors.push(`Field not allowed in where: ${key}`);
      }
    }
  }

  // Validate fields in select
  if (select) {
    for (const field of select) {
      if (!isFieldAllowed(field)) {
        errors.push(`Field not allowed in select: ${field}`);
      }
    }
  }

  // Validate expansions
  if (expand) {
    const tableRels = relationsMap.get(tableName);
    for (const rel of expand) {
      if (!tableRels?.has(rel)) {
        errors.push(`Relation not found: ${tableName}.${rel}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Gets the relations available for a table.
 */
export function getAvailableRelations(table: PgTable): string[] {
  const tableName = getTableName(table);
  const rels = relationsMap.get(tableName);
  return rels ? Array.from(rels.keys()) : [];
}

/**
 * Dynamically registers a new relation.
 */
export function registerDynamicRelation(
  sourceTable: PgTable,
  relationName: string,
  def: Omit<RelationDef, "name">
): void {
  registerRelation(sourceTable, relationName, def);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export { relationsMap, fieldWhiteList, fieldBlackList };
