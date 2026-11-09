/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * QUERY TRANSLATOR - PHASE 2: The Magic of Data
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Translates JSON queries into executable SQL through Drizzle ORM.
 * Solves the N+1 problem through Auto-Join with relations.
 *
 * Features:
 * - Operators: eq, neq, gt, gte, lt, lte, in, nin, contains, startsWith, exists
 * - Nested logic: AND, OR, NOT
 * - Auto-Join (?expand): Resolves relations in a single query
 * - Schema validation: Verifies existing columns
 * - Security: Only typed Drizzle operators
 *
 * @example
 * ```typescript
 * const result = await queryTranslator(agentIdentities, {
 *   where: {
 *     AND: [
 *       { isActive: true },
 *       { type: { in: ["service", "worker"] } },
 *       { rateLimit: { gte: 60 } }
 *     ]
 *   },
 *   expand: ["traces", "apiKeys"],
 *   limit: 10
 * });
 * ```
 */

import {
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  inArray,
  notInArray,
  ilike,
  and,
  or,
  not,
  isNull,
  isNotNull,
  sql,
  SQL,
  asc,
  desc,
} from "drizzle-orm";
import type { PgTable, PgColumn } from "drizzle-orm/pg-core";

import { db } from "../../../apps/api/src/db";
import * as schema from "../../../apps/api/src/db/schema";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES AND CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/** Supported filter operators according to KitsudenDataset.md */
export type FilterOperator =
  | "eq" // Equal
  | "neq" // Not equal
  | "gt" // Greater than
  | "gte" // Greater than or equal
  | "lt" // Less than
  | "lte" // Less than or equal
  | "in" // In list
  | "nin" // Not in list
  | "contains" // Contains text
  | "startsWith" // Starts with
  | "exists"; // Field exists

/** Logical operators */
export type LogicalOperator = "AND" | "OR" | "NOT";

/** Individual field filter */
export interface FieldFilter {
  eq?: any;
  neq?: any;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  in?: any[];
  nin?: any[];
  contains?: string;
  startsWith?: string;
  exists?: boolean;
}

/** Recursive where filter with AND/OR/NOT support */
export interface WhereFilter {
  [key: string]: FieldFilter | any | WhereFilter[];
  AND?: WhereFilter[];
  OR?: WhereFilter[];
  NOT?: WhereFilter;
}

/** Ordering options */
export interface OrderBy {
  field: string;
  direction?: "asc" | "desc";
}

/** QueryTranslator query options */
export interface QueryTranslatorOptions {
  /** Where filters */
  where?: WhereFilter;
  /** Fields to select (default: all) */
  select?: string[];
  /** Relations to expand (Anti N+1) */
  expand?: string[];
  /** Maximum expansion depth (DoS protection) */
  maxExpandDepth?: number;
  /** Result limit */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Ordering */
  orderBy?: OrderBy | OrderBy[];
}

/** Query result with metadata */
export interface QueryTranslatorResult<T = any> {
  data: T[];
  meta: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    executedAt: string;
    queryTimeMs: number;
    expandedRelations: string[];
  };
}

/** QueryTranslator error */
export class QueryTranslatorError extends Error {
  constructor(
    message: string,
    public code:
      | "INVALID_OPERATOR"
      | "INVALID_COLUMN"
      | "INVALID_EXPAND"
      | "MAX_EXPAND_DEPTH_EXCEEDED"
      | "INVALID_WHERE_CLAUSE"
      | "QUERY_EXECUTION_ERROR",
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "QueryTranslatorError";
  }
}

/** Relation definition for Auto-Join */
export interface RelationDef {
  name: string;
  type: "one" | "many";
  table: PgTable;
  fkColumn: string;
  targetColumn: string;
  targetTable: PgTable;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RELATION MAP (Schema Metadata)
// ═══════════════════════════════════════════════════════════════════════════════

const relationsMap = new Map<string, Map<string, RelationDef>>();

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

function initializeRelations(): void {
  // Agent Identities
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

  // Agent Traces
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

  // Data Sets
  registerRelation(schema.dataSets, "entries", {
    type: "many",
    table: schema.dataEntries,
    fkColumn: "dataSetId",
    targetColumn: "id",
    targetTable: schema.dataSets,
  });
  // Data Entries
  registerRelation(schema.dataEntries, "dataset", {
    type: "one",
    table: schema.dataEntries,
    fkColumn: "dataSetId",
    targetColumn: "id",
    targetTable: schema.dataSets,
  });
}

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

function getTableColumns(table: PgTable): string[] {
  return Object.keys(table).filter(
    (k) => !["_", "$inferSelect", "$inferInsert", Symbol.for("drizzle:Columns")].includes(k)
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// OPERATOR BUILDER (Mapping to Drizzle)
// ═══════════════════════════════════════════════════════════════════════════════

function buildOperatorCondition(column: PgColumn, operator: FilterOperator, value: any): SQL {
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
        throw new QueryTranslatorError(`The "in" operator requires an array`, "INVALID_OPERATOR", {
          operator,
          value,
        });
      }
      return inArray(column, value);
    case "nin":
      if (!Array.isArray(value)) {
        throw new QueryTranslatorError(`The "nin" operator requires an array`, "INVALID_OPERATOR", {
          operator,
          value,
        });
      }
      return notInArray(column, value);
    case "contains":
      if (typeof value !== "string") {
        throw new QueryTranslatorError(
          `The "contains" operator requires a string`,
          "INVALID_OPERATOR",
          { operator, value }
        );
      }
      // Escape special characters
      const escapedContains = value.replace(/[%_]/g, "\\$&");
      return ilike(column, `%${escapedContains}%`);
    case "startsWith":
      if (typeof value !== "string") {
        throw new QueryTranslatorError(
          `The "startsWith" operator requires a string`,
          "INVALID_OPERATOR",
          { operator, value }
        );
      }
      const escapedStart = value.replace(/[%_]/g, "\\$&");
      return ilike(column, `${escapedStart}%`);
    case "exists":
      return value ? isNotNull(column) : isNull(column);
    default:
      throw new QueryTranslatorError(`Unsupported operator: ${operator}`, "INVALID_OPERATOR", {
        operator,
        supportedOperators: [
          "eq",
          "neq",
          "gt",
          "gte",
          "lt",
          "lte",
          "in",
          "nin",
          "contains",
          "startsWith",
          "exists",
        ],
      });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECURSIVE WHERE PARSER
// ═══════════════════════════════════════════════════════════════════════════════

function parseWhereClause(
  table: PgTable,
  where: WhereFilter | undefined,
  depth: number = 0
): SQL | undefined {
  if (!where || Object.keys(where).length === 0) {
    return undefined;
  }

  // Protection against infinite recursion
  if (depth > 10) {
    throw new QueryTranslatorError("Maximum where clause depth exceeded", "INVALID_WHERE_CLAUSE", {
      maxDepth: 10,
    });
  }

  const conditions: SQL[] = [];

  for (const [key, value] of Object.entries(where)) {
    // AND logical operator
    if (key === "AND") {
      if (!Array.isArray(value)) {
        throw new QueryTranslatorError(
          "AND requires an array of conditions",
          "INVALID_WHERE_CLAUSE",
          { key, value }
        );
      }
      const andConditions = value
        .map((w) => parseWhereClause(table, w, depth + 1))
        .filter((c): c is SQL => c !== undefined);
      if (andConditions.length > 0) {
        conditions.push(and(...andConditions) as SQL);
      }
      continue;
    }

    // OR logical operator
    if (key === "OR") {
      if (!Array.isArray(value)) {
        throw new QueryTranslatorError(
          "OR requires an array of conditions",
          "INVALID_WHERE_CLAUSE",
          { key, value }
        );
      }
      const orConditions = value
        .map((w) => parseWhereClause(table, w, depth + 1))
        .filter((c): c is SQL => c !== undefined);
      if (orConditions.length > 0) {
        conditions.push(or(...orConditions) as SQL);
      }
      continue;
    }

    // NOT logical operator
    if (key === "NOT") {
      if (typeof value !== "object" || Array.isArray(value)) {
        throw new QueryTranslatorError(
          "NOT requires an object of conditions",
          "INVALID_WHERE_CLAUSE",
          { key, value }
        );
      }
      const notCondition = parseWhereClause(table, value as WhereFilter, depth + 1);
      if (notCondition) {
        conditions.push(not(notCondition));
      }
      continue;
    }

    // Validate column exists
    const column = getColumn(table, key);
    if (!column) {
      const tableName = getTableName(table);
      const availableColumns = getTableColumns(table);
      throw new QueryTranslatorError(
        `Unknown column "${key}" in table "${tableName}"`,
        "INVALID_COLUMN",
        { column: key, table: tableName, availableColumns: availableColumns.slice(0, 20) }
      );
    }

    // Value is an object with operators: { level: { gte: 50 } }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [op, opValue] of Object.entries(value)) {
        const sqlCond = buildOperatorCondition(column, op as FilterOperator, opValue);
        if (sqlCond) conditions.push(sqlCond);
      }
    } else {
      // Direct equality: { status: "active" }
      conditions.push(eq(column, value));
    }
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return and(...conditions) as SQL;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-JOIN ENGINE (Anti N+1) with Depth Limit
// ═══════════════════════════════════════════════════════════════════════════════

interface ExpandNode {
  relation: string;
  nested?: ExpandNode[];
}

function parseExpand(expand: string[]): ExpandNode[] {
  const root: ExpandNode[] = [];

  for (const item of expand) {
    const parts = item.split(".");
    let current = root;

    for (const part of parts) {
      let node = current.find((n) => n.relation === part);
      if (!node) {
        node = { relation: part };
        current.push(node);
      }
      if (!node.nested) node.nested = [];
      current = node.nested;
    }
  }

  return root;
}

function validateExpandDepth(
  nodes: ExpandNode[],
  maxDepth: number,
  currentDepth: number = 1
): void {
  if (currentDepth > maxDepth) {
    throw new QueryTranslatorError(
      `Maximum expand depth exceeded (${maxDepth})`,
      "MAX_EXPAND_DEPTH_EXCEEDED",
      { maxDepth, currentDepth }
    );
  }

  for (const node of nodes) {
    if (node.nested && node.nested.length > 0) {
      validateExpandDepth(node.nested, maxDepth, currentDepth + 1);
    }
  }
}

async function executeWithExpansions<T>(
  table: PgTable,
  baseQuery: any,
  expand: string[],
  maxDepth: number
): Promise<T[]> {
  const tableName = getTableName(table);
  const expandTree = parseExpand(expand);

  // Validate depth (DoS protection)
  validateExpandDepth(expandTree, maxDepth);

  // Run base query
  const rows = await baseQuery;
  if (rows.length === 0 || expand.length === 0) {
    return rows as T[];
  }

  // Get IDs
  const ids = rows.map((r: any) => r.id).filter(Boolean);
  if (ids.length === 0) return rows as T[];

  // Load relations in parallel (Anti N+1)
  const relationsData = await Promise.all(
    expandTree.map(async (node) => {
      const relation = relationsMap.get(tableName)?.get(node.relation);
      if (!relation) {
        throw new QueryTranslatorError(
          `Unknown relation "${node.relation}" in "${tableName}"`,
          "INVALID_EXPAND",
          {
            relation: node.relation,
            table: tableName,
            availableRelations: getAvailableRelations(table),
          }
        );
      }

      const data = await loadRelationBatch(relation, ids);
      return { name: node.relation, data, relation };
    })
  );

  // Merge results
  return rows.map((row: any) => {
    const expanded: any = { ...row };
    for (const { name, data, relation } of relationsData) {
      if (relation.type === "one") {
        expanded[name] = data.get(row[relation.fkColumn]) || null;
      } else {
        expanded[name] = data.get(row.id) || [];
      }
    }
    return expanded;
  });
}

async function loadRelationBatch(
  relation: RelationDef,
  parentIds: string[]
): Promise<Map<string, any | any[]>> {
  const result = new Map<string, any | any[]>();

  if (relation.type === "one") {
    // N:1
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
    // 1:N
    const fkColumn = getColumn(relation.table, relation.fkColumn);
    if (!fkColumn) return result;

    const rows = await db.select().from(relation.table).where(inArray(fkColumn, parentIds));

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
 * QueryTranslator - Translates JSON into executable SQL with Auto-Join.
 *
 * Solves the N+1 problem through batch loading of relations.
 *
 * @param table - Drizzle ORM table
 * @param options - Query options (where, expand, limit, etc.)
 * @returns Result with data and metadata
 *
 * @example
 * ```typescript
 * const result = await queryTranslator(agentIdentities, {
 *   where: {
 *     AND: [
 *       { isActive: true },
 *       { rateLimit: { gte: 60 } }
 *     ]
 *   },
 *   expand: ["traces", "apiKeys"],
 *   limit: 10
 * });
 * ```
 */
export async function queryTranslator<T = any>(
  table: PgTable,
  options: QueryTranslatorOptions
): Promise<QueryTranslatorResult<T>> {
  const startTime = performance.now();
  const {
    where,
    expand = [],
    maxExpandDepth = 3, // Default limit (DoS protection)
    limit = 50,
    offset = 0,
    orderBy,
  } = options;

  const tableName = getTableName(table);

  try {
    // 1. Parse the where clause
    const whereClause = parseWhereClause(table, where);

    // 2. Build base query
    let query = db.select().from(table).$dynamic();

    if (whereClause) {
      query = query.where(whereClause);
    }

    // 3. Apply ordering
    if (orderBy) {
      const orderList = Array.isArray(orderBy) ? orderBy : [orderBy];
      const orderConditions = orderList
        .map((o) => {
          const col = getColumn(table, o.field);
          if (!col) return null;
          return o.direction === "desc" ? desc(col) : asc(col);
        })
        .filter(Boolean);

      if (orderConditions.length > 0) {
        query = query.orderBy(...(orderConditions as any));
      }
    }

    // 4. Apply pagination
    const limitSafe = Math.min(Math.max(1, limit), 1000);
    const offsetSafe = Math.max(0, offset);
    query = query.limit(limitSafe).offset(offsetSafe);

    // 5. Run with or without expansions
    let data: T[];
    if (expand.length > 0) {
      data = await executeWithExpansions<T>(table, query, expand, maxExpandDepth);
    } else {
      data = (await query) as T[];
    }

    // 6. Count total
    let countQuery = db.select({ count: sql<number>`count(*)` }).from(table);
    if (whereClause) {
      countQuery = countQuery.where(whereClause) as any;
    }
    const [{ count: total }] = await countQuery;

    const queryTimeMs = performance.now() - startTime;

    return {
      data,
      meta: {
        total,
        limit: limitSafe,
        offset: offsetSafe,
        hasMore: offsetSafe + data.length < total,
        executedAt: new Date().toISOString(),
        queryTimeMs: Math.round(queryTimeMs * 100) / 100,
        expandedRelations: expand,
      },
    };
  } catch (error) {
    if (error instanceof QueryTranslatorError) {
      throw error;
    }
    throw new QueryTranslatorError(
      `Error executing query: ${(error as Error).message}`,
      "QUERY_EXECUTION_ERROR",
      { table: tableName, options, originalError: error }
    );
  }
}

/**
 * Validates a query without running it.
 */
export function validateQueryTranslator(
  table: PgTable,
  options: QueryTranslatorOptions
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const tableName = getTableName(table);

  try {
    parseWhereClause(table, options.where);
  } catch (error) {
    if (error instanceof QueryTranslatorError) {
      errors.push(`${error.code}: ${error.message}`);
    } else {
      errors.push(`Unexpected error: ${(error as Error).message}`);
    }
  }

  // Validate expansions
  if (options.expand) {
    const tableRels = relationsMap.get(tableName);
    for (const rel of options.expand) {
      const relName = rel.split(".")[0]; // First level only for simple validation
      if (!tableRels?.has(relName)) {
        const available = tableRels ? Array.from(tableRels.keys()) : [];
        errors.push(
          `INVALID_EXPAND: Unknown relation "${relName}". Available: ${available.join(", ")}`
        );
      }
    }

    // Validate depth
    if (options.maxExpandDepth && options.maxExpandDepth > 5) {
      errors.push(`MAX_EXPAND_DEPTH_EXCEEDED: maxExpandDepth cannot be greater than 5`);
    }
  }

  // Validate limits
  if (options.limit !== undefined && (options.limit < 1 || options.limit > 1000)) {
    errors.push("INVALID_LIMIT: limit must be between 1 and 1000");
  }

  if (options.offset !== undefined && options.offset < 0) {
    errors.push("INVALID_OFFSET: offset cannot be negative");
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
 * Registers a dynamic relation.
 */
export function registerDynamicRelation(
  table: PgTable,
  name: string,
  def: Omit<RelationDef, "name">
): void {
  registerRelation(table, name, def);
}

/**
 * Gets the relation map.
 */
export function getRelationsMap(): Map<string, Map<string, RelationDef>> {
  return relationsMap;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export { relationsMap, getTableName, getColumn, parseWhereClause };
