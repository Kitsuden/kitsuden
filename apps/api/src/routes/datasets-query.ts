/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DATASETS QUERY & BATCH ROUTES - PHASE 2: The Magic of Data
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Exposes the core engines (QueryTranslator, BatchProcessor, Auto-Join) via REST.
 *
 * Endpoints:
 * - POST /:id/query    → Runs Kitsuden QL queries with relation expansion
 * - POST /batch        → Runs transactional batch operations (ACID)
 *
 * Features:
 * - Anti N+1: Relation expansion in a single query
 * - Semantic validation: Clear errors (COLUMN_NOT_FOUND, etc.)
 * - ACID transactions: Automatic rollback in batch
 * - Security: Reuses the existing auth middleware
 */

import { zValidator } from "@hono/zod-validator";
import {
  parseKitsudenQuery,
  KitsudenQLError,
  getAvailableRelations,
  validateKitsudenQuery,
  debugQuery,
  BatchProcessor,
  BatchProcessorError,
  resolveExecutor,
  isUuid,
} from "@kitsuden/engine";
import { accessToDataset } from "@kitsuden/shared";
import { eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

// Deep import, as in transactional-rls: the engine facade does not export the
// relations map, and it is needed to know WHICH table an `expand` leads to.
import { getRelationsMap } from "../../../../packages/engine/src/translator";
import { db, mergedSchema } from "../db";
import { dataSets, dataEntries } from "../db/schema-core";
import { inProduction } from "../lib/environment";
import {
  isForbiddenNativeTable,
  isSecretColumn,
  withoutSecretColumns,
} from "../lib/explorable-tables";
import {
  buildDrizzleWhere,
  publishedOrOwnQl,
  type PolicyJson,
  type RLSUser,
} from "../lib/rls-builder";
import { requireAuth } from "../middleware/auth";
import { checkDatasetReadAccess, checkDatasetWriteAccess } from "../middleware/permissions";
import type { AppVariables } from "../types/hono";

// Import core engines from the engine

// datasetsQueryRoutes is defined at the END of the file as a chained expression (Hono RPC).

// Apply authentication to all routes
// requireAuth lives in the chain at the end of the file.

// ═══════════════════════════════════════════════════════════════════════════════
// ZOD SCHEMAS FOR VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

/** Schema for filter operators */
const FieldFilterSchema = z
  .object({
    eq: z.any().optional(),
    neq: z.any().optional(),
    gt: z.any().optional(),
    gte: z.any().optional(),
    lt: z.any().optional(),
    lte: z.any().optional(),
    in: z.array(z.any()).optional(),
    contains: z.string().optional(),
    startsWith: z.string().optional(),
    endsWith: z.string().optional(),
  })
  .strict()
  .optional();

/**
 * Recursive schema for where (supports AND/OR/NOT). Any other key is a
 * field and must be a filter (`catchall`). No `.strict()`: in zod 4
 * it replaces the catchall with `never` and would reject every field.
 */
const WhereFilterSchema: z.ZodType<any> = z.lazy(() =>
  z
    .object({
      AND: z.array(z.lazy(() => WhereFilterSchema)).optional(),
      OR: z.array(z.lazy(() => WhereFilterSchema)).optional(),
      NOT: z.lazy(() => WhereFilterSchema).optional(),
    })
    .catchall(FieldFilterSchema)
);

/** Schema for a dataset query */
const DatasetQuerySchema = z
  .object({
    where: WhereFilterSchema.optional(),
    expand: z.array(z.string()).optional(),
    select: z.array(z.string()).optional(),
    limit: z.number().min(1).max(1000).default(50).optional(),
    offset: z.number().min(0).default(0).optional(),
    orderBy: z
      .array(
        z.object({
          field: z.string(),
          direction: z.enum(["asc", "desc"]).default("asc").optional(),
        })
      )
      .optional(),
  })
  .strict();

/** Schema for a single batch operation */
const BatchOperationSchema = z
  .object({
    op: z.enum(["create", "update", "delete", "upsert"]),
    table: z.string().min(1), // dataEntries or dataSets (see BATCH_TABLES)
    data: z.record(z.string(), z.any()).optional(),
    id: z.string().optional(),
    alias: z.string().optional(),
    where: z.record(z.string(), z.any()).optional(),
  })
  .strict();

/** Schema for a batch of operations */
const BatchRequestSchema = z
  .object({
    operations: z.array(BatchOperationSchema).min(1).max(100),
    datasetId: z.string().optional(), // To validate permissions
  })
  .strict();

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Get a Drizzle table by name from mergedSchema
// ═══════════════════════════════════════════════════════════════════════════════

/** SQL name of a drizzle table. */
function sqlNameOf(table: unknown): string | undefined {
  const name = (table as Record<symbol, unknown> | null | undefined)?.[Symbol.for("drizzle:Name")];
  return typeof name === "string" ? name : undefined;
}

/**
 * Credentials, sessions and keys are never queried here, not even by an admin
 * (the explorer's rule, lib/explorable-tables.ts). Security review 2026-11-03;
 * every `auth_*` table except `auth_users` too, as in MCP (2026-11-04).
 */
function getTableByName(name: string): PgTable | undefined {
  const table = findTableByName(name);
  if (!table) return undefined;
  return isForbiddenNativeTable(sqlNameOf(table) ?? "") ? undefined : table;
}

/**
 * What does this query ask for that cannot be asked of a native table? `null`
 * if nothing. A `where`, an `orderBy` or a `select` on a secret column is an
 * oracle (or a direct leak), and an `expand` to a forbidden table reads it
 * sideways (`agentIdentities.apiKeys` -> `agent_api_keys`).
 * Security review 2026-11-04 (F71).
 */
export function nativeQueryProblem(table: PgTable, body: unknown): string | null {
  const query = (body ?? {}) as {
    where?: unknown;
    orderBy?: unknown;
    select?: unknown;
    expand?: unknown;
  };
  const secretField = (where: unknown): string | null => {
    if (!where || typeof where !== "object") return null;
    if (Array.isArray(where)) {
      for (const w of where) {
        const found = secretField(w);
        if (found) return found;
      }
      return null;
    }
    for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
      if (key === "AND" || key === "OR" || key === "NOT") {
        const found = secretField(value);
        if (found) return found;
      } else if (isSecretColumn(key)) {
        return key;
      }
    }
    return null;
  };
  const inWhere = secretField(query.where);
  if (inWhere) return `Column "${inWhere}" cannot be filtered`;
  for (const o of Array.isArray(query.orderBy) ? (query.orderBy as { field?: unknown }[]) : []) {
    if (typeof o?.field === "string" && isSecretColumn(o.field)) {
      return `Column "${o.field}" cannot be sorted`;
    }
  }
  for (const col of Array.isArray(query.select) ? (query.select as unknown[]) : []) {
    if (typeof col === "string" && isSecretColumn(col)) return `Column "${col}" cannot be selected`;
  }
  const relations = getRelationsMap().get(sqlNameOf(table) ?? "");
  for (const rel of Array.isArray(query.expand) ? (query.expand as unknown[]) : []) {
    if (typeof rel !== "string") continue;
    const target = relations?.get(rel)?.table;
    if (target && isForbiddenNativeTable(sqlNameOf(target) ?? "")) {
      return `Relation "${rel}" cannot be expanded`;
    }
  }
  return null;
}

/** The names offered back when a table is not found: without the forbidden ones. */
function availableTables(): string[] {
  return Object.keys(mergedSchema as Record<string, unknown>).filter(
    (key) => getTableByName(key) !== undefined
  );
}

function findTableByName(name: string): PgTable | undefined {
  // Look in mergedSchema (core + active kons)
  const table = (mergedSchema as Record<string, unknown>)[name];
  // drizzle's internal marker is a Symbol: indexing `unknown` with it does not
  // compile, so the minimal shape being checked is declared.
  if (
    table &&
    typeof table === "object" &&
    (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name")]
  ) {
    return table as PgTable;
  }
  // Fallback: case-insensitive lookup
  for (const key of Object.keys(mergedSchema)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      const t = (mergedSchema as Record<string, unknown>)[key];
      if (
        t &&
        typeof t === "object" &&
        (t as Record<symbol, unknown>)[Symbol.for("drizzle:Name")]
      ) {
        return t as PgTable;
      }
    }
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: the agent's per-dataset scopes (security review 2026-11-04, F70)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The `datasets:<slug>:<action>` scopes and their denials `!datasets:<slug>:*`
 * decide BEFORE the policy, as in `crud.ts`, kon-datasets and MCP. This route
 * only looked at `policyJson`: a key with `["admin", "!datasets:secret:*"]`
 * read here what `/api/data-sets/:id/entries` denies it.
 *
 * `null`: the scopes say nothing about this dataset; the policy decides.
 */
export function agentScopeAccess(
  c: { get: unknown },
  slug: string | null | undefined,
  action: "read" | "write"
): "denied" | "granted" | null {
  const get = (c.get as (k: string) => unknown).bind(c);
  const agent = get("agent") as { scopes?: string[] } | undefined;
  const user = get("user") as { scopes?: unknown } | null | undefined;
  const userScopes = user?.scopes;
  const scopes =
    agent?.scopes ?? (Array.isArray(userScopes) ? (userScopes as string[]) : undefined);
  return accessToDataset(scopes, slug ?? null, action);
}

/** Can it read this dataset? The agent's scopes first; if they say nothing, the policy. */
async function canReadDataset(
  c: Context,
  dataset: { id: string; slug: string | null }
): Promise<boolean> {
  const access = agentScopeAccess(c, dataset.slug, "read");
  if (access) return access === "granted";
  return checkDatasetReadAccess(c, dataset.id);
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /:id/query - Run a Kitsuden QL query
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Runs a Kitsuden QL query on a dataset.
 *
 * @example Request:
 * POST /api/datasets/characters/query
 * {
 *   "where": { "element": "pyro", "level": { "gte": 50 } },
 *   "expand": ["weapon", "skills"],
 *   "limit": 10,
 *   "orderBy": [{ "field": "name", "direction": "asc" }]
 * }
 *
 * @example Response:
 * {
 *   "data": [...],
 *   "meta": {
 *     "total": 25,
 *     "limit": 10,
 *     "offset": 0,
 *     "hasMore": true,
 *     "executedAt": "2024-01-15T10:30:00Z",
 *     "queryTimeMs": 12.45
 *   }
 * }
 */
export async function queryDatasetHandler(c: Context) {
  const datasetId = c.req.param("id")!;
  const body = await c.req.json();

  try {
    // 1. Check that the dataset exists
    const [dataset] = await db.select().from(dataSets).where(eq(dataSets.id, datasetId)).limit(1);

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    // 2. Check read permissions: the agent's per-dataset scopes, then the policy
    const hasAccess = await canReadDataset(c, dataset);
    if (!hasAccess) {
      return c.json({ error: "Forbidden: No read access to this dataset" }, 403);
    }

    // 2b. Row-level isolation. The query engine receives a Kitsuden QL `where`
    // and does not know how to apply the policy's `rlsRules` (which
    // `/entries` does apply with `buildDatasetWhere`): with a per-owner dataset,
    // ANY account with read access saw every owner's rows here.
    // Until the translator understands them, those datasets can only be queried
    // by an admin through this route (earlier audit).
    if (queryWouldSkipIsolation(dataset.policyJson as PolicyJson | null, c.get("user"))) {
      return c.json(
        {
          error:
            "This dataset isolates rows per user: query it with GET /api/data-sets/:id/entries",
        },
        403
      );
    }

    // Outside the team: the published or their own, whatever `where` asks for.
    const user = c.get("user") as { id?: string; role?: string | null } | null | undefined;
    const ofTheTeam = user?.role === "admin" || user?.role === "editor";

    // 3. Run the query using the Kitsuden QL engine
    const result = await parseKitsudenQuery(dataEntries, {
      ...body,
      where: {
        AND: ofTheTeam ? [body.where ?? {}] : [body.where ?? {}, publishedOrOwnQl(user?.id)],
        dataSetId: { eq: datasetId }, // Filter by dataset
      },
    } as any);

    return c.json(result, 200);
  } catch (error) {
    console.error("[QueryEngine] Error:", error);

    // Handle semantic errors from the translator
    if (error instanceof KitsudenQLError) {
      return c.json(
        {
          error: error.message,
          code: error.code,
          details: error.details,
        },
        400
      );
    }

    // Generic error
    return c.json(
      {
        error: "Query execution failed",
        message: (error as Error).message,
      },
      500
    );
  }
}

/**
 * Would this query bypass the dataset's row-level isolation?
 *
 * Yes when the policy has `rlsRules` that produce a filter for this user,
 * and the caller is not an admin. Exported so it can be tested without a database.
 */
export function queryWouldSkipIsolation(
  policy: PolicyJson | null,
  user: { id?: string; role?: string | null } | null | undefined
): boolean {
  if (user?.role === "admin") return false;
  const rules = policy?.rlsRules;
  if (!rules || rules.length === 0) return false;
  return buildDrizzleWhere(rules, (user ?? null) as RLSUser) !== undefined;
}

// (registered in the final chain)

// ═══════════════════════════════════════════════════════════════════════════════
// POST /query/:tableName - Direct query on a table (admin only)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Direct query on any table in the schema (administrators only).
 * Useful for administrative or cross-dataset queries.
 */
export async function queryTableHandler(c: Context) {
  const tableName = c.req.param("tableName")!;
  const body = await c.req.json();
  const user = c.get("user");

  // Only admins can run direct queries
  if (user?.role !== "admin") {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }

  const table = getTableByName(tableName);
  if (!table) {
    return c.json(
      {
        error: `Table "${tableName}" not found`,
        availableTables: availableTables(),
      },
      400
    );
  }

  const problem = nativeQueryProblem(table, body);
  if (problem) return c.json({ error: problem, code: "FIELD_NOT_ALLOWED" }, 400);

  try {
    const result = await parseKitsudenQuery(table, body as any);
    // Columns holding a live secret (also in expanded relations) never leave.
    return c.json(withoutSecretColumns(result) as Record<string, unknown>, 200);
  } catch (error) {
    console.error("[QueryEngine] Error:", error);

    if (error instanceof KitsudenQLError) {
      return c.json(
        {
          error: error.message,
          code: error.code,
          details: error.details,
        },
        400
      );
    }

    return c.json(
      {
        error: "Query execution failed",
        message: (error as Error).message,
      },
      500
    );
  }
}

// (registered in the final chain)

// ═══════════════════════════════════════════════════════════════════════════════
// GET /:id/relations - List available relations
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Lists the relations available for expansion in a dataset.
 * Useful so clients know what they can expand.
 */
export async function listRelationsHandler(c: Context) {
  const datasetId = c.req.param("id")!;

  // The same gates as the query: a dataset it cannot read does not exist for it
  // (the list is static, but it would confirm that the id exists).
  const [dataset] = isUuid(datasetId)
    ? await db
        .select({ id: dataSets.id, slug: dataSets.slug })
        .from(dataSets)
        .where(eq(dataSets.id, datasetId))
        .limit(1)
    : [];
  if (!dataset || !(await canReadDataset(c, dataset))) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  // The relations available for dataEntries are defined in the translator
  const availableRels = getAvailableRelations(dataEntries);

  return c.json(
    {
      datasetId,
      availableRelations: availableRels,
      description: "Use these relation names in the 'expand' parameter of your queries",
    },
    200
  );
}

// (registered in the final chain)

// ═══════════════════════════════════════════════════════════════════════════════
// POST /batch - Run transactional batch operations
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Runs multiple operations in an ACID transaction.
 *
 * If any operation fails, EVERYTHING is rolled back.
 * Supports references between operations through @ref:alias.
 *
 * @example Request:
 * POST /api/datasets/batch
 * {
 *   "operations": [
 *     {
 *       "op": "create",
 *       "table": "dataEntries",
 *       "data": { "dataSetId": "characters", "data": { "name": "Hero" } },
 *       "alias": "hero"
 *     },
 *     {
 *       "op": "create",
 *       "table": "dataEntries",
 *       "data": { "dataSetId": "skills", "data": { "name": "Fireball", "characterId": "@ref:hero.id" } }
 *     }
 *   ]
 * }
 *
 * @example Response (success):
 * {
 *   "success": true,
 *   "results": [...],
 *   "meta": { "durationMs": 45.2, "totalOperations": 2 }
 * }
 *
 * @example Response (failure with rollback):
 * {
 *   "success": false,
 *   "rolledBack": true,
 *   "error": { "operationIndex": 1, "message": "...", "code": "VALIDATION_FAILED" },
 *   "results": [...]
 * }
 */
/**
 * The tables the batch processor writes. Only the dataset tables: this route had
 * no deny-list, and with the global pool an `admin`-scope agent could rewrite
 * `approval_settings`, `auth_accounts` or `agent_api_keys`.
 * Exact names, on purpose: no case-insensitive lookup in the merged schema.
 */
const BATCH_TABLES: Readonly<Record<string, PgTable>> = { dataEntries, dataSets };

export function batchTable(name: unknown): PgTable | undefined {
  return typeof name === "string" && Object.hasOwn(BATCH_TABLES, name)
    ? BATCH_TABLES[name]
    : undefined;
}

/**
 * Can this identity use the batch processor? Admin only (or an agent with the
 * `admin` scope). It used to depend only on the `ADMIN_ONLY_ROUTES` prefix
 * rule; it is now authorized here too, so the route does not end up
 * open if that rule is removed.
 */
export function canUseBatch(
  user: { role?: string | null } | null | undefined,
  agent: { scopes?: string[] } | null | undefined
): boolean {
  if (agent) return agent.scopes?.includes("admin") === true;
  return user?.role === "admin";
}

export async function batchOperationsHandler(c: Context) {
  if (!canUseBatch(c.get("user"), c.get("agent"))) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const body = await c.req.json();

  const refused = body.operations.findIndex((op: { table?: unknown }) => !batchTable(op.table));
  if (refused >= 0) {
    return c.json(
      {
        success: false,
        error: {
          message: "Batch operations only write dataset tables: dataEntries and dataSets",
          code: "TABLE_NOT_ALLOWED",
          operationIndex: refused,
        },
      },
      403
    );
  }

  try {
    // 1. Validate permissions for each operation
    // Extract the datasetIds from the operations
    const datasetIds = new Set<string>();
    for (const op of body.operations) {
      if (op.table === "dataEntries" && op.data?.dataSetId) {
        datasetIds.add(op.data.dataSetId);
      } else if (op.table === "dataSets" && op.id) {
        datasetIds.add(op.id);
      }
    }

    // Check write access to all the datasets involved: an agent's
    // `!datasets:<slug>:*` denial beats its `admin` scope.
    for (const dsId of datasetIds) {
      const [ds] = isUuid(dsId)
        ? await db
            .select({ slug: dataSets.slug })
            .from(dataSets)
            .where(eq(dataSets.id, dsId))
            .limit(1)
        : [];
      const access = agentScopeAccess(c, ds?.slug, "write");
      const hasAccess = access ? access === "granted" : await checkDatasetWriteAccess(c, dsId);
      if (!hasAccess) {
        return c.json(
          {
            error: `Forbidden: No write access to dataset "${dsId}"`,
          },
          403
        );
      }
    }

    // 2. Transform the operations into the BatchProcessor format
    const batchOps = body.operations.map((op: any) => {
      return {
        op: op.op,
        table: batchTable(op.table)!,
        data: op.data,
        id: op.id,
        alias: op.alias,
        where: op.where,
      };
    });

    // 3. Run the batch using the BatchProcessor, on the request's RLS
    // transaction (a savepoint of it), so that the policies see who is asking.
    const batchProcessor = new BatchProcessor(resolveExecutor(db));
    const result = await batchProcessor.execute(batchOps);

    // 4. Return the result
    const statusCode = result.success ? 200 : 400;
    return c.json(result, statusCode);
  } catch (error) {
    console.error("[BatchEngine] Error:", error);

    // Handle BatchProcessor-specific errors
    if (error instanceof BatchProcessorError) {
      return c.json(
        {
          success: false,
          error: {
            message: error.message,
            code: error.code,
            operationIndex: error.operationIndex,
            details: error.details,
          },
        },
        400
      );
    }

    // Unexpected error
    return c.json(
      {
        success: false,
        error: {
          message: (error as Error).message,
          code: "INTERNAL_ERROR",
        },
      },
      500
    );
  }
}

// (registered in the final chain)

// ═══════════════════════════════════════════════════════════════════════════════
// POST /validate-query - Validate a query without running it
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validates a Kitsuden QL query without running it.
 * Useful for debugging and validation in the frontend.
 */
export async function validateQueryHandler(c: Context) {
  // It validates against ANY table and, if it does not exist, returns the whole
  // schema list: with anyone's session it was an index of the database. Admin only,
  // like `POST /query/:tableName`.
  if (!canUseBatch(c.get("user"), c.get("agent"))) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const tableName = c.req.param("tableName")!;
  const body = await c.req.json();

  const table = getTableByName(tableName);
  if (!table) {
    return c.json(
      {
        valid: false,
        errors: [`Table "${tableName}" not found`],
        availableTables: availableTables(),
      },
      400
    );
  }

  const validation = validateKitsudenQuery(table, body as any);

  return c.json(validation, validation.valid ? 200 : 400);
}

// (registered in the final chain)

// ═══════════════════════════════════════════════════════════════════════════════
// DEBUG: GET /query-debug/:tableName - See the generated SQL (without running it)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Debug: Shows the SQL that would be generated for a query (without running it).
 * Only available in development mode.
 */
export async function debugQueryHandler(c: Context) {
  const tableName = c.req.param("tableName")!;
  const body = await c.req.json();
  const user = c.get("user");

  // Admins only, in development
  if (inProduction()) {
    return c.json({ error: "Debug endpoint not available in production" }, 403);
  }

  if (user?.role !== "admin") {
    return c.json({ error: "Admin access required" }, 403);
  }

  const table = getTableByName(tableName);
  if (!table) {
    return c.json({ error: `Table "${tableName}" not found` }, 400);
  }

  const debug = debugQuery(table, body as any);

  return c.json(
    {
      table: tableName,
      query: body,
      generatedSql: debug.sql,
      params: debug.params,
    },
    200
  );
}

// (registered in the final chain)

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTER (chained — Hono RPC, KITSUDEN architecture §7)
// Same registration order as the statement-style version.
// ═══════════════════════════════════════════════════════════════════════════════

export const datasetsQueryRoutes = new Hono<{ Variables: AppVariables }>()
  .use("/*", requireAuth)
  .post("/:id/query", zValidator("json", DatasetQuerySchema), queryDatasetHandler)
  .post("/query/:tableName", zValidator("json", DatasetQuerySchema), queryTableHandler)
  .get("/:id/relations", listRelationsHandler)
  .post("/batch", zValidator("json", BatchRequestSchema), batchOperationsHandler)
  .post("/validate-query/:tableName", zValidator("json", DatasetQuerySchema), validateQueryHandler)
  .post("/query-debug/:tableName", zValidator("json", DatasetQuerySchema), debugQueryHandler);

/** Accumulated router type — consumed by src/rpc.ts */
export type DatasetsQueryRoutesType = typeof datasetsQueryRoutes;
