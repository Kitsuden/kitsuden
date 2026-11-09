/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * KITSUDEN QL ENGINE - Prisma JSON to Drizzle SQL translator
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Translates queries in Prisma JSON format into safe SQL statements through
 * Drizzle ORM. Supports complex operators, nested AND/OR logic and
 * relation resolution (Anti N+1) through Auto-Join.
 *
 * Features:
 * - Operators: eq, neq, gt, gte, lt, lte, in, contains
 * - Nested logic: AND, OR, NOT
 * - Schema validation: Verifies existing columns
 * - Auto-Join: Expands relations with findMany({ with: {} })
 * - Security: Only typed Drizzle operators, no dynamic SQL
 *
 * @example
 * ```typescript
 * const result = await parseKitsudenQuery(agentIdentities, {
 *   where: {
 *     AND: [
 *       { isActive: true },
 *       { type: { eq: "service" } },
 *       { rateLimit: { gte: 60 } }
 *     ]
 *   },
 *   expand: ["traces", "apiKeys"]
 * });
 * ```
 */

import { eq, ne, gt, gte, lt, lte, inArray, ilike, and, or, not, sql, SQL } from "drizzle-orm";
import type { PgTable, PgColumn } from "drizzle-orm/pg-core";

import { db } from "../../../apps/api/src/db";
import * as schema from "../../../apps/api/src/db/schema";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES AND CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/** Supported filter operators */
export type FilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "contains"
  | "startsWith"
  | "endsWith";

/** Logical operators */
export type LogicalOperator = "AND" | "OR" | "NOT";

/** Individual field filter */
export interface FieldFilter {
  eq?: any;
  neq?: any;
  gt?: any;
  gte?: any;
  lt?: any;
  lte?: any;
  in?: any[];
  contains?: string;
  startsWith?: string;
  endsWith?: string;
}

/** Recursive where filter */
export interface WhereFilter {
  [key: string]: FieldFilter | any | WhereFilter[];
  AND?: WhereFilter[];
  OR?: WhereFilter[];
  NOT?: WhereFilter;
}

/** Kitsuden QL query options */
export interface KitsudenQueryOptions {
  /** Where filters */
  where?: WhereFilter;
  /** Relations to expand */
  expand?: string[];
  /** Fields to select */
  select?: string[];
  /** Result limit */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Ordering [{ field: "createdAt", direction: "desc" }] */
  orderBy?: Array<{ field: string; direction?: "asc" | "desc" }>;
}

/** Query result */
export interface KitsudenQueryResult<T = any> {
  data: T[];
  meta: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    executedAt: string;
    queryTimeMs: number;
  };
}

/** Semantic validation error */
export class KitsudenQLError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "KitsudenQLError";
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RELATION MAP (Schema Metadata)
// ═══════════════════════════════════════════════════════════════════════════════

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

/**
 * Registers a relation in the global map.
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
 */
function initializeRelations(): void {
  // Agent Identities relations
  registerRelation(schema.agentIdentities, "traces", {
    type: "many",
    table: schema.agentTraces,
    fkColumn: "agentId",
    targetColumn: "id",
    targetTable: schema.agentIdentities,
  });

  registerRelation(schema.agentIdentities, "apiKeys", {
    type: "many",
    table: schema.agentApiKeys,
    fkColumn: "agentId",
    targetColumn: "id",
    targetTable: schema.agentIdentities,
  });

  registerRelation(schema.agentIdentities, "memories", {
    type: "many",
    table: schema.agentMemory,
    fkColumn: "agentId",
    targetColumn: "id",
    targetTable: schema.agentIdentities,
  });

  registerRelation(schema.agentIdentities, "auditLogs", {
    type: "many",
    table: schema.agentAuditLogs,
    fkColumn: "agentId",
    targetColumn: "id",
    targetTable: schema.agentIdentities,
  });

  // Agent Traces relations
  registerRelation(schema.agentTraces, "steps", {
    type: "many",
    table: schema.agentTraceSteps,
    fkColumn: "traceId",
    targetColumn: "id",
    targetTable: schema.agentTraces,
  });

  registerRelation(schema.agentTraces, "agent", {
    type: "one",
    table: schema.agentTraces,
    fkColumn: "agentId",
    targetColumn: "id",
    targetTable: schema.agentIdentities,
  });

  // Data Sets relations
  registerRelation(schema.dataSets, "entries", {
    type: "many",
    table: schema.dataEntries,
    fkColumn: "dataSetId",
    targetColumn: "id",
    targetTable: schema.dataSets,
  });

  registerRelation(schema.dataEntries, "dataset", {
    type: "one",
    table: schema.dataEntries,
    fkColumn: "dataSetId",
    targetColumn: "id",
    targetTable: schema.dataSets,
  });
}

// Initialize relations
initializeRelations();

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS AND UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Gets a table's name */
function getTableName(table: PgTable): string {
  return (table as any)[Symbol.for("drizzle:Name")] ?? table.constructor.name;
}

/** Gets a column of the table */
function getColumn(table: PgTable, columnName: string): PgColumn | undefined {
  return (table as any)[columnName];
}

/** Gets all columns of a table */
function getTableColumns(table: PgTable): string[] {
  const columns: string[] = [];
  for (const key of Object.keys(table)) {
    if (key !== "_" && key !== "$inferSelect" && key !== "$inferInsert") {
      columns.push(key);
    }
  }
  return columns;
}

/** Checks whether a field exists in the table */
function validateColumnExists(table: PgTable, columnName: string): boolean {
  // Special logical operator fields
  if (["AND", "OR", "NOT"].includes(columnName)) return true;

  const column = getColumn(table, columnName);
  return column !== undefined;
}

/** Validates that an operator is supported */
function validateOperator(operator: string): operator is FilterOperator {
  const validOperators: FilterOperator[] = [
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "in",
    "contains",
    "startsWith",
    "endsWith",
  ];
  return validOperators.includes(operator as FilterOperator);
}

// ═══════════════════════════════════════════════════════════════════════════════
// OPERATOR MAPPING TO DRIZZLE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Builds a SQL condition for a specific operator.
 *
 * Operator mapping:
 * - eq -> eq()
 * - neq -> ne()
 * - gt/gte/lt/lte -> gt()/gte()/lt()/lte()
 * - in -> inArray()
 * - contains -> ilike(column, `%${value}%`)
 * - startsWith -> ilike(column, `${value}%`)
 * - endsWith -> ilike(column, `%${value}`)
 */
function buildOperatorCondition(
  column: PgColumn,
  operator: FilterOperator,
  value: any
): SQL | undefined {
  switch (operator) {
    case "eq":
      return eq(column, value);
    case "neq":
      return ne(column, value);
    case "gt":
      return gt(column, value);
    case "gte":
      return gte(column, value);
    case "lt":
      return lt(column, value);
    case "lte":
      return lte(column, value);
    case "in":
      if (!Array.isArray(value)) {
        throw new KitsudenQLError(
          `The "in" operator requires an array of values`,
          "INVALID_OPERATOR_VALUE",
          { operator, value, expected: "array" }
        );
      }
      return inArray(column, value);
    case "contains":
      if (typeof value !== "string") {
        throw new KitsudenQLError(
          `The "contains" operator requires a string`,
          "INVALID_OPERATOR_VALUE",
          { operator, value, expected: "string" }
        );
      }
      // Escape special SQL LIKE characters
      const escapedValue = value.replace(/[%_]/g, "\\$&");
      return ilike(column, `%${escapedValue}%`);
    case "startsWith":
      if (typeof value !== "string") {
        throw new KitsudenQLError(
          `The "startsWith" operator requires a string`,
          "INVALID_OPERATOR_VALUE",
          { operator, value, expected: "string" }
        );
      }
      const escapedStart = value.replace(/[%_]/g, "\\$&");
      return ilike(column, `${escapedStart}%`);
    case "endsWith":
      if (typeof value !== "string") {
        throw new KitsudenQLError(
          `The "endsWith" operator requires a string`,
          "INVALID_OPERATOR_VALUE",
          { operator, value, expected: "string" }
        );
      }
      const escapedEnd = value.replace(/[%_]/g, "\\$&");
      return ilike(column, `%${escapedEnd}`);
    default:
      throw new KitsudenQLError(`Unsupported operator: ${operator}`, "UNSUPPORTED_OPERATOR", {
        operator,
        supportedOperators: [
          "eq",
          "neq",
          "gt",
          "gte",
          "lt",
          "lte",
          "in",
          "contains",
          "startsWith",
          "endsWith",
        ],
      });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECURSIVE WHERE PARSER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Recursively parses a where object and converts it into Drizzle SQL conditions.
 *
 * Supports:
 * - Field filters: { level: { gte: 50 } }
 * - Direct equality: { element: "pyro" }
 * - AND/OR logical operators: { AND: [{...}, {...}] }
 * - NOT operator: { NOT: { level: { lt: 10 } } }
 */
function parseWhereClause(table: PgTable, where: WhereFilter | undefined): SQL | undefined {
  if (!where || Object.keys(where).length === 0) {
    return undefined;
  }

  const conditions: SQL[] = [];

  for (const [key, value] of Object.entries(where)) {
    // AND logical operator
    if (key === "AND") {
      if (!Array.isArray(value)) {
        throw new KitsudenQLError(
          "AND requires an array of conditions",
          "INVALID_LOGICAL_OPERATOR",
          {
            key,
            value,
          }
        );
      }
      const andConditions = value
        .map((w) => parseWhereClause(table, w))
        .filter((c): c is SQL => c !== undefined);
      if (andConditions.length > 0) {
        conditions.push(and(...andConditions) as SQL);
      }
      continue;
    }

    // OR logical operator
    if (key === "OR") {
      if (!Array.isArray(value)) {
        throw new KitsudenQLError(
          "OR requires an array of conditions",
          "INVALID_LOGICAL_OPERATOR",
          {
            key,
            value,
          }
        );
      }
      const orConditions = value
        .map((w) => parseWhereClause(table, w))
        .filter((c): c is SQL => c !== undefined);
      if (orConditions.length > 0) {
        conditions.push(or(...orConditions) as SQL);
      }
      continue;
    }

    // NOT logical operator
    if (key === "NOT") {
      if (typeof value !== "object" || Array.isArray(value)) {
        throw new KitsudenQLError(
          "NOT requires an object of conditions",
          "INVALID_LOGICAL_OPERATOR",
          {
            key,
            value,
          }
        );
      }
      const notCondition = parseWhereClause(table, value as WhereFilter);
      if (notCondition) {
        conditions.push(not(notCondition));
      }
      continue;
    }

    // Validate that the column exists in the schema
    if (!validateColumnExists(table, key)) {
      const tableName = getTableName(table);
      const availableColumns = getTableColumns(table);
      throw new KitsudenQLError(
        `Unknown column "${key}" in table "${tableName}"`,
        "COLUMN_NOT_FOUND",
        {
          column: key,
          table: tableName,
          availableColumns: availableColumns.slice(0, 20), // Limit for brevity
        }
      );
    }

    const column = getColumn(table, key);
    if (!column) {
      continue; // Skip if the column is not found (we already threw an error above)
    }

    // Value is an object with operators: { level: { gte: 50 } }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [op, opValue] of Object.entries(value)) {
        if (!validateOperator(op)) {
          throw new KitsudenQLError(`Operator "${op}" not supported`, "UNSUPPORTED_OPERATOR", {
            operator: op,
            column: key,
            supportedOperators: [
              "eq",
              "neq",
              "gt",
              "gte",
              "lt",
              "lte",
              "in",
              "contains",
              "startsWith",
              "endsWith",
            ],
          });
        }
        const sqlCond = buildOperatorCondition(column, op, opValue);
        if (sqlCond) conditions.push(sqlCond);
      }
    } else {
      // Direct equality: { element: "pyro" } -> eq(column, "pyro")
      conditions.push(eq(column, value));
    }
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return and(...conditions) as SQL;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-JOIN ENGINE (Anti N+1) with findMany({ with: {} })
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Builds the "with" object for findMany with relations.
 *
 * @example
 * Input: ["traces", "apiKeys"]
 * Output: { traces: true, apiKeys: true }
 */
function buildWithObject(
  table: PgTable,
  expand: string[]
): Record<string, true | { with: Record<string, true> }> | undefined {
  if (!expand || expand.length === 0) return undefined;

  const tableName = getTableName(table);
  const tableRelations = relationsMap.get(tableName);

  if (!tableRelations) return undefined;

  const withObj: Record<string, true | { with: Record<string, true> }> = {};

  for (const relName of expand) {
    const relation = tableRelations.get(relName);
    if (!relation) {
      const availableRelations = Array.from(tableRelations.keys());
      throw new KitsudenQLError(
        `Unknown relation "${relName}" in table "${tableName}"`,
        "RELATION_NOT_FOUND",
        {
          relation: relName,
          table: tableName,
          availableRelations,
        }
      );
    }

    // For simple relations, we only include true
    // For nested relations, we could expand further
    withObj[relName] = true;
  }

  return Object.keys(withObj).length > 0 ? withObj : undefined;
}

/**
 * Runs the query using db.query.findMany with relations.
 *
 * This is the Anti N+1 implementation using Drizzle's query API,
 * which automatically does the necessary joins in a single query.
 */
async function executeWithRelations<T>(
  table: PgTable,
  whereClause: SQL | undefined,
  withObj: Record<string, true | { with: Record<string, true> }> | undefined,
  options: KitsudenQueryOptions
): Promise<T[]> {
  const tableName = getTableName(table);
  const limit = Math.min(Math.max(1, options.limit ?? 50), 1000);
  const offset = Math.max(0, options.offset ?? 0);

  // Build the base query
  // Note: Drizzle ORM has a query API that allows "with" for relations
  // db.query[tableName].findMany({ where, with, limit, offset })

  const queryConfig: any = {
    limit,
    offset,
  };

  if (whereClause) {
    queryConfig.where = whereClause;
  }

  if (withObj) {
    queryConfig.with = withObj;
  }

  // Run the query using Drizzle's query API
  // We need to access db.query[tableName]
  const queryApi = (db.query as any)[tableName];

  if (!queryApi) {
    // Fall back to a traditional select if there is no query API
    return executeFallback<T>(table, whereClause, options);
  }

  try {
    const results = await queryApi.findMany(queryConfig);
    return results as T[];
  } catch (error) {
    // If the query API fails, fall back to the traditional method
    console.warn(`[KitsudenQL] Query API failed for ${tableName}, using fallback:`, error);
    return executeFallback<T>(table, whereClause, options);
  }
}

/**
 * Fallback to the traditional method using select().
 * Implements Anti N+1 manually.
 */
async function executeFallback<T>(
  table: PgTable,
  whereClause: SQL | undefined,
  options: KitsudenQueryOptions
): Promise<T[]> {
  const limit = Math.min(Math.max(1, options.limit ?? 50), 1000);
  const offset = Math.max(0, options.offset ?? 0);

  // Query base
  let query = db.select().from(table).$dynamic();

  if (whereClause) {
    query = query.where(whereClause);
  }

  // Apply limit and offset
  query = query.limit(limit).offset(offset);

  const rows = await query;

  // If there are expansions, load them manually (Anti N+1)
  if (options.expand && options.expand.length > 0) {
    return expandRelationsManually(table, rows, options.expand) as Promise<T[]>;
  }

  return rows as T[];
}

/**
 * Expands relations manually using an Anti N+1 strategy.
 * 1. Get the IDs of the main rows
 * 2. Run separate queries per relation using IN (ids)
 * 3. Merge results
 */
async function expandRelationsManually(
  table: PgTable,
  rows: any[],
  expand: string[]
): Promise<any[]> {
  if (rows.length === 0) return rows;

  const tableName = getTableName(table);
  const ids = rows.map((r) => r.id).filter(Boolean);
  if (ids.length === 0) return rows;

  // Load all relations in parallel
  const relationsData = await Promise.all(
    expand.map(async (relName) => {
      const relation = relationsMap.get(tableName)?.get(relName);
      if (!relation) {
        console.warn(`[KitsudenQL] Relation not found: ${tableName}.${relName}`);
        return { relName, data: new Map() };
      }

      const relData = await loadRelationData(relation, ids);
      return { relName, data: relData, relation };
    })
  );

  // Merge results
  return rows.map((row) => {
    const expanded = { ...row };
    for (const { relName, data, relation } of relationsData) {
      if (!relation) continue;

      if (relation.type === "one") {
        // N:1 relation
        expanded[relName] = data.get(row[relation.fkColumn]) || null;
      } else {
        // 1:N relation
        expanded[relName] = data.get(row.id) || [];
      }
    }
    return expanded;
  });
}

/**
 * Loads a relation's data for a set of IDs.
 */
async function loadRelationData(
  relation: RelationDef,
  parentIds: string[]
): Promise<Map<string, any | any[]>> {
  const result = new Map<string, any | any[]>();

  if (relation.type === "one") {
    // N:1 - Look up in the target table
    const targetColumn = getColumn(relation.targetTable, "id");
    if (!targetColumn) return result;

    const rows = await db
      .select()
      .from(relation.targetTable)
      .where(inArray(targetColumn, parentIds));

    for (const row of rows) {
      result.set((row as any).id, row);
    }
  } else {
    // 1:N - Look up in the related table by FK
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
// MAIN PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parses and runs a Kitsuden QL query.
 *
 * Translates a Prisma-style JSON object into an executable SQL query through Drizzle.
 *
 * @param table - Drizzle ORM table (e.g. schema.agentIdentities)
 * @param jsonPayload - JSON object with the query (where, expand, limit, etc.)
 * @returns Query result with metadata
 *
 * @example
 * ```typescript
 * const result = await parseKitsudenQuery(agentIdentities, {
 *   where: {
 *     AND: [
 *       { isActive: true },
 *       { type: { eq: "service" } },
 *       { rateLimit: { gte: 60 } }
 *     ]
 *   },
 *   expand: ["traces", "apiKeys"],
 *   limit: 10,
 *   orderBy: [{ field: "createdAt", direction: "desc" }]
 * });
 * ```
 */
export async function parseKitsudenQuery<T = any>(
  table: PgTable,
  jsonPayload: KitsudenQueryOptions
): Promise<KitsudenQueryResult<T>> {
  const startTime = performance.now();
  const tableName = getTableName(table);

  try {
    // 1. Validate and parse the where clause
    const whereClause = parseWhereClause(table, jsonPayload.where);

    // 2. Build "with" object for relations
    const withObj = jsonPayload.expand ? buildWithObject(table, jsonPayload.expand) : undefined;

    // 3. Run query with or without relations
    const data = await executeWithRelations<T>(table, whereClause, withObj, jsonPayload);

    // 4. Count total for metadata
    let totalQuery = db.select({ count: sql<number>`count(*)` }).from(table);
    if (whereClause) {
      totalQuery = totalQuery.where(whereClause) as any;
    }
    // `count(*)` is bigint, and Postgres drivers deliver it as a STRING
    // so as not to lose precision. Without the conversion, `total` ends up being "42" and
    // the `hasMore` comparison (`offset + data.length < total`) compares a
    // number with a string — which in JavaScript does not fail, it just gives
    // silently wrong results.
    const [totalRow] = await totalQuery;
    const total = Number(totalRow?.count ?? 0);

    const queryTimeMs = performance.now() - startTime;

    return {
      data,
      meta: {
        total,
        limit: jsonPayload.limit ?? 50,
        offset: jsonPayload.offset ?? 0,
        hasMore: (jsonPayload.offset ?? 0) + data.length < total,
        executedAt: new Date().toISOString(),
        queryTimeMs: Math.round(queryTimeMs * 100) / 100,
      },
    };
  } catch (error) {
    if (error instanceof KitsudenQLError) {
      throw error;
    }

    // Wrap unexpected errors
    throw new KitsudenQLError(
      `Error executing query: ${(error as Error).message}`,
      "QUERY_EXECUTION_ERROR",
      { table: tableName, payload: jsonPayload, originalError: error }
    );
  }
}

/**
 * Validates a Kitsuden QL query without running it.
 *
 * @returns Object with validation and a list of errors if any
 *
 * @example
 * ```typescript
 * const { valid, errors } = validateKitsudenQuery(agentIdentities, {
 *   where: { level: { gte: 50 } },
 *   expand: ["traces"]
 * });
 * ```
 */
export function validateKitsudenQuery(
  table: PgTable,
  jsonPayload: KitsudenQueryOptions
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const tableName = getTableName(table);

  try {
    // Try to parse the where (this validates columns and operators)
    parseWhereClause(table, jsonPayload.where);
  } catch (error) {
    if (error instanceof KitsudenQLError) {
      errors.push(`${error.code}: ${error.message}`);
    } else {
      errors.push(`Unexpected error: ${(error as Error).message}`);
    }
  }

  // Validate expansions
  if (jsonPayload.expand) {
    const tableRelations = relationsMap.get(tableName);
    for (const rel of jsonPayload.expand) {
      if (!tableRelations?.has(rel)) {
        const available = tableRelations ? Array.from(tableRelations.keys()) : [];
        errors.push(
          `RELATION_NOT_FOUND: Unknown relation "${rel}". Available: ${available.join(", ")}`
        );
      }
    }
  }

  // Validate limits
  if (jsonPayload.limit !== undefined) {
    if (jsonPayload.limit < 1 || jsonPayload.limit > 1000) {
      errors.push("INVALID_LIMIT: limit must be between 1 and 1000");
    }
  }

  if (jsonPayload.offset !== undefined && jsonPayload.offset < 0) {
    errors.push("INVALID_OFFSET: offset cannot be negative");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Gets the relations available for a table.
 *
 * @example
 * ```typescript
 * const relations = getAvailableRelations(agentIdentities);
 * // ["traces", "apiKeys", "memories", "auditLogs"]
 * ```
 */
export function getAvailableRelations(table: PgTable): string[] {
  const tableName = getTableName(table);
  const rels = relationsMap.get(tableName);
  return rels ? Array.from(rels.keys()) : [];
}

/**
 * Dynamically registers a new relation for Auto-Join.
 *
 * @example
 * ```typescript
 * registerDynamicRelation(characters, "weapon", {
 *   type: "one",
 *   table: characters,
 *   fkColumn: "weaponId",
 *   targetColumn: "id",
 *   targetTable: weapons
 * });
 * ```
 */
export function registerDynamicRelation(
  sourceTable: PgTable,
  relationName: string,
  def: Omit<RelationDef, "name">
): void {
  registerRelation(sourceTable, relationName, def);
}

/**
 * Gets the complete relation map (for debugging).
 */
export function getRelationsMap(): Map<string, Map<string, RelationDef>> {
  return relationsMap;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEBUG UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Prints the generated SQL for a query (without running it).
 * Useful for debugging.
 */
export function debugQuery(
  table: PgTable,
  jsonPayload: KitsudenQueryOptions
): { sql: string; params: any[] } {
  const tableName = getTableName(table);

  try {
    const whereClause = parseWhereClause(table, jsonPayload.where);

    return {
      sql: `SELECT * FROM "${tableName}"${whereClause ? " WHERE ?" : ""}`,
      params: whereClause ? [whereClause] : [],
    };
  } catch (error) {
    return {
      sql: `Error generating SQL: ${(error as Error).message}`,
      params: [],
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADDITIONAL EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export { relationsMap, getTableName, getColumn, validateColumnExists, validateOperator };
