/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * UNIFIED ITEMS API — /api/items/{collection}
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Provides a standard REST interface for ANY collection:
 *   - Datasets (JSONB in data_entries)
 *   - Kon tables (native PostgreSQL tables)
 *
 * Endpoints:
 *   GET    /api/items/:collection         → list
 *   GET    /api/items/:collection/:id     → get one
 *   POST   /api/items/:collection         → create
 *   PATCH  /api/items/:collection/:id     → update
 *   DELETE /api/items/:collection/:id     → remove
 *
 * Query params:
 *   ?limit=50&offset=0&sort=-createdAt
 *   ?where={"status":"published"}
 *   ?expand=author,media
 *
 * Security:
 *   - Reads: public (RLS context injected, policies may restrict)
 *   - Mutations: requireAuth + transactional RLS
 */

import {
  parseKitsudenQuery,
  KitsudenQLError,
  messageOf,
  recordChanges,
  tableChanges,
  DATASET_ENTRY_DIFF,
  DATASET_ENTRY_ENTITY,
  type RecordAction,
} from "@kitsuden/engine";
import { agentSignature } from "@kitsuden/shared";
import { eq, sql, desc, asc, and, ilike, gt, gte, lt, lte, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";

import { db as rawDb, mergedSchema } from "../db";
import { dataSets, dataEntries } from "../db/schema-core";
import {
  TABLES_ONLY_VIA_THEIR_ROUTE,
  tableProblemOnlyByItsRoute,
  respondProblem,
} from "../lib/actions-code";
import {
  addSchemaVersionToData,
  buildDatasetSearchCondition,
  buildDatasetWhereConditions,
  validateDatasetEntry,
} from "../lib/dataset-optimizations";
import { isForbiddenNativeTable } from "../lib/explorable-tables";
import { logger } from "../lib/logger";
import { applyProvenanceInRest } from "../lib/provenance";
import { broadcastMutation } from "../lib/realtime";
import { requireAuth } from "../middleware/auth";
import { withTransactionalRLS } from "../middleware/transactional-rls";
import type { AppVariables } from "../types/hono";

import { invalidateGraphQLCache } from "./graphql";

// itemsRoutes is defined at the END of the file as a chained expression
// (Hono RPC: chaining accumulates the types of each endpoint).

// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════════

// The transactional RLS middleware lives in the chain at the end of the file.

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Get the transaction-aware db instance (tx if inside RLS middleware, else rawDb) */
function getDb(c: any) {
  return c.get("tx") || rawDb;
}

/** Irregular plural → singular map */
const IRREGULAR_PLURALS: Record<string, string> = {
  children: "child",
  people: "person",
  men: "man",
  women: "woman",
  teeth: "tooth",
  feet: "foot",
  mice: "mouse",
  geese: "goose",
};

/** Try to find a dataset by slug */
async function findDatasetBySlug(db: any, slug: string) {
  const [ds] = await db.select().from(dataSets).where(eq(dataSets.slug, slug)).limit(1);
  return ds || null;
}

/** Get a native table from the merged schema by name (robust plural/singular resolution) */
function getNativeTable(name: string): any {
  const table = searchNativeTable(name);
  // Not even an admin reads or writes sessions, credentials or secrets through
  // the generic route: `/api/items/authSessions` used to return the session tokens.
  const sqlName = table?.[Symbol.for("drizzle:Name")] as string | undefined;
  // The same rule as MCP and GraphQL: the deny-list plus every auth_* table except auth_users.
  if (sqlName && isForbiddenNativeTable(sqlName)) return null;
  return table;
}

function searchNativeTable(name: string): any {
  const clean = name.trim();
  const lower = clean.toLowerCase();

  // Direct match (case-insensitive key search)
  for (const key of Object.keys(mergedSchema)) {
    if (key.toLowerCase() === lower) {
      const table = (mergedSchema as any)[key];
      if (table && typeof table === "object" && table[Symbol.for("drizzle:Name")]) {
        return table;
      }
    }
  }

  // Build candidate names
  const candidates = new Set<string>();

  // plural → singular
  if (IRREGULAR_PLURALS[lower]) {
    candidates.add(IRREGULAR_PLURALS[lower]);
  } else if (lower.endsWith("ies")) {
    candidates.add(lower.slice(0, -3) + "y");
  } else if (
    lower.endsWith("es") &&
    (lower.endsWith("ches") ||
      lower.endsWith("shes") ||
      lower.endsWith("xes") ||
      lower.endsWith("zes"))
  ) {
    candidates.add(lower.slice(0, -2));
  } else if (lower.endsWith("s") && !lower.endsWith("ss")) {
    candidates.add(lower.slice(0, -1));
  }

  // singular → plural
  if (lower.endsWith("y") && !/[aeiou]y$/.test(lower)) {
    candidates.add(lower.slice(0, -1) + "ies");
  } else if (/[sxz]$/.test(lower) || /(ch|sh)$/.test(lower)) {
    candidates.add(lower + "es");
  } else {
    candidates.add(lower + "s");
  }

  // Also try the original casing variants
  candidates.add(clean);
  candidates.add(lower);

  for (const key of candidates) {
    for (const schemaKey of Object.keys(mergedSchema)) {
      if (schemaKey.toLowerCase() === key) {
        const table = (mergedSchema as any)[schemaKey];
        if (table && typeof table === "object" && table[Symbol.for("drizzle:Name")]) {
          return table;
        }
      }
    }
  }

  return null;
}

/** Determine if collection is a dataset or a native table */
async function resolveCollection(
  db: any,
  collection: string
): Promise<
  | { type: "dataset"; dataset: typeof dataSets.$inferSelect }
  | { type: "native"; table: any }
  | { type: "unknown" }
> {
  const ds = await findDatasetBySlug(db, collection);
  if (ds) return { type: "dataset", dataset: ds };

  const table = getNativeTable(collection);
  if (table) return { type: "native", table };

  return { type: "unknown" };
}

/**
 * Tables that have their own route (the actions' code and
 * its history, their executions, the approvals configuration) are not
 * written through here, by any role. Returns the response, or `null`.
 */
function writeWithOwnRoute(
  c: Context,
  resolved: { type: string; table?: unknown }
): Response | null {
  if (resolved.type !== "native") return null;
  const name = (resolved.table as Record<symbol, unknown>)[Symbol.for("drizzle:Name")] as
    string | undefined;
  if (!name || !TABLES_ONLY_VIA_THEIR_ROUTE.has(name)) return null;
  const requestId = ((c.get as (k: string) => unknown)("requestId") as string | undefined) ?? null;
  return respondProblem(c as never, tableProblemOnlyByItsRoute(name, c.req.path, requestId));
}

/** Parse ?where JSON into Drizzle filters for native tables */
function buildWhereFilters(table: any, whereJson: string | undefined): any[] {
  if (!whereJson) return [];
  try {
    const filters = JSON.parse(whereJson);
    const conditions: any[] = [];

    for (const [key, val] of Object.entries(filters)) {
      const col = table[key];
      if (!col) continue;

      if (typeof val === "string") {
        conditions.push(eq(col, val));
      } else if (typeof val === "number" || typeof val === "boolean") {
        conditions.push(eq(col, val));
      } else if (val && typeof val === "object") {
        const op = val as any;
        if (op.$gt !== undefined) conditions.push(gt(col, op.$gt));
        if (op.$gte !== undefined) conditions.push(gte(col, op.$gte));
        if (op.$lt !== undefined) conditions.push(lt(col, op.$lt));
        if (op.$lte !== undefined) conditions.push(lte(col, op.$lte));
        if (op.$ne !== undefined) conditions.push(sql`${col} <> ${op.$ne}`);
        if (op.$in !== undefined) conditions.push(inArray(col, op.$in));
        if (op.$contains !== undefined) conditions.push(ilike(col, `%${op.$contains}%`));
      }
    }
    return conditions;
  } catch {
    return [];
  }
}

/** Parse ?sort into Drizzle orderBy */
function buildOrderBy(table: any, sort: string | undefined) {
  if (!sort) return [desc(table.createdAt || table.id)];
  const fields = sort.split(",");
  return fields.map((f) => {
    const descFlag = f.startsWith("-");
    const name = descFlag ? f.slice(1) : f;
    const col = table[name];
    if (!col) return desc(table.id);
    return descFlag ? desc(col) : asc(col);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUERY (Kitsuden QL) — Unified for datasets and native tables
// ═══════════════════════════════════════════════════════════════════════════════

export async function queryItemsHandler(c: Context) {
  const db = getDb(c);
  const collection = c.req.param("collection")!;
  const body = await c.req.json().catch(() => ({}));

  const resolved = await resolveCollection(db, collection);
  if (resolved.type === "unknown") {
    return c.json({ error: "Collection not found", collection }, 404);
  }

  try {
    if (resolved.type === "dataset") {
      const ds = resolved.dataset;
      const result = await parseKitsudenQuery(dataEntries, {
        ...body,
        where: {
          ...(body.where || {}),
          dataSetId: { eq: ds.id },
        },
      });
      return c.json(result);
    }

    const table = resolved.table;
    const result = await parseKitsudenQuery(table, body);
    return c.json(result);
  } catch (err: unknown) {
    if (err instanceof KitsudenQLError) {
      return c.json({ error: messageOf(err), code: err.code, details: err.details }, 400);
    }
    logger.error({ collection, error: messageOf(err) }, "Failed to query items");
    return c.json({ error: "Query failed", details: messageOf(err) }, 500);
  }
}
// (registered in the final chain)

// ═══════════════════════════════════════════════════════════════════════════════
// LIST
// ═══════════════════════════════════════════════════════════════════════════════

export async function listItemsHandler(c: Context) {
  const db = getDb(c);
  const collection = c.req.param("collection")!;
  const limit = Math.min(Number(c.req.query("limit")) || 50, 1000);
  const offset = Number(c.req.query("offset")) || 0;
  const sort = c.req.query("sort");
  const whereJson = c.req.query("where");

  const resolved = await resolveCollection(db, collection);

  if (resolved.type === "unknown") {
    return c.json({ error: "Collection not found", collection }, 404);
  }

  try {
    if (resolved.type === "dataset") {
      const ds = resolved.dataset;
      const searchTerm = c.req.query("search");
      const conditions: (ReturnType<typeof eq> | ReturnType<typeof sql>)[] = [
        eq(dataEntries.dataSetId, ds.id),
      ];

      if (whereJson) {
        try {
          const filters = JSON.parse(whereJson);
          conditions.push(...buildDatasetWhereConditions(filters));
        } catch {
          /* ignore invalid JSON */
        }
      }

      if (searchTerm) {
        const searchCondition = buildDatasetSearchCondition(ds.schema ?? [], searchTerm);
        if (searchCondition) {
          conditions.push(searchCondition);
        }
      }

      const [docs, [total]] = await Promise.all([
        db
          .select()
          .from(dataEntries)
          .where(and(...conditions))
          .orderBy(sort ? asc(sql`data->>${sort.replace(/^-/, "")}`) : desc(dataEntries.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ value: sql<number>`count(*)` })
          .from(dataEntries)
          .where(and(...conditions)),
      ]);

      // Optional (X-Kitsuden-Provenance: 1): who wrote each row. If not requested, same as always.
      const views = await applyProvenanceInRest(
        c,
        docs.map((d: typeof dataEntries.$inferSelect) => ({
          id: d.id,
          ...d.data,
          _meta: { datasetId: d.dataSetId, createdAt: d.createdAt },
        })),
        db,
        docs,
        "dataset_entry"
      );
      return c.json({
        docs: views,
        totalDocs: total?.value || 0,
        limit,
        offset,
        collection,
      });
    }

    const table = resolved.table;
    const conditions = buildWhereFilters(table, whereJson);
    const orderBy = buildOrderBy(table, sort);

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [docs, [total]] = await Promise.all([
      db
        .select()
        .from(table)
        .where(where)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset),
      db
        .select({ value: sql<number>`count(*)` })
        .from(table)
        .where(where),
    ]);

    return c.json({
      docs: await applyProvenanceInRest(
        c,
        docs as object[],
        db,
        docs as object[],
        `table:${collection}`
      ),
      totalDocs: total?.value || 0,
      limit,
      offset,
      collection,
    });
  } catch (err: unknown) {
    logger.error({ collection, error: messageOf(err) }, "Failed to list items");
    return c.json({ error: "Query failed", details: messageOf(err) }, 500);
  }
}
// (registered in the final chain)

// ═══════════════════════════════════════════════════════════════════════════════
// GET ONE
// ═══════════════════════════════════════════════════════════════════════════════

export async function getItemHandler(c: Context) {
  const db = getDb(c);
  const collection = c.req.param("collection")!;
  const id = c.req.param("id")!;

  const resolved = await resolveCollection(db, collection);
  if (resolved.type === "unknown") {
    return c.json({ error: "Collection not found", collection }, 404);
  }

  try {
    if (resolved.type === "dataset") {
      const [doc] = await db
        .select()
        .from(dataEntries)
        .where(and(eq(dataEntries.dataSetId, resolved.dataset.id), eq(dataEntries.id, id)))
        .limit(1);
      if (!doc) return c.json({ error: "Not found" }, 404);
      const [view] = await applyProvenanceInRest(
        c,
        [
          {
            id: doc.id,
            ...doc.data,
            _meta: { datasetId: doc.dataSetId, createdAt: doc.createdAt },
          },
        ],
        db,
        [doc],
        "dataset_entry"
      );
      return c.json(view);
    }

    const table = resolved.table;
    const [doc] = await db.select().from(table).where(eq(table.id, id)).limit(1);
    if (!doc) return c.json({ error: "Not found" }, 404);
    const [view] = await applyProvenanceInRest(
      c,
      [doc as object],
      db,
      [doc as object],
      `table:${collection}`
    );
    return c.json(view);
  } catch (err: unknown) {
    logger.error({ collection, id, error: messageOf(err) }, "Failed to get item");
    return c.json({ error: "Query failed", details: messageOf(err) }, 500);
  }
}
// (registered in the final chain)

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE
// ═══════════════════════════════════════════════════════════════════════════════

export async function createItemHandler(c: Context) {
  const db = getDb(c);
  const collection = c.req.param("collection")!;
  const body = await c.req.json();

  const resolved = await resolveCollection(db, collection);
  if (resolved.type === "unknown") {
    return c.json({ error: "Collection not found", collection }, 404);
  }
  const withRoute = writeWithOwnRoute(c, resolved);
  if (withRoute) return withRoute;

  try {
    if (resolved.type === "dataset") {
      const ds = resolved.dataset;
      const schema = ds.schema ?? [];
      const validation = validateDatasetEntry(schema, body);
      if (!validation.success) {
        return c.json({ error: "Validation failed", details: validation.error.format() }, 400);
      }
      const validated = validation.data;
      const versioned = addSchemaVersionToData(ds.schema ?? [], validated);
      const title = (versioned.title as string) || (versioned.name as string) || "Untitled";
      // What an AGENT creates is signed by its responsible human (an
      // agent is not an account: its id in owner_id broke the FK to auth_users).
      const who = c.get("user") as { id?: string; role?: string } | null;
      let ownerId: string | null;
      if (who?.role === "agent") {
        const signature = agentSignature(
          who as never,
          versioned.ownerId as string | undefined,
          "nobody"
        );
        if (!signature.ok)
          return c.json(
            { error: "Forbidden", message: signature.message, code: signature.code },
            403
          );
        ownerId = signature.author;
      } else {
        ownerId = (versioned.ownerId as string | undefined) ?? who?.id ?? null;
      }
      const [doc] = await db
        .insert(dataEntries)
        .values({
          dataSetId: ds.id,
          title,
          data: { ...versioned, ownerId },
          ownerId,
          createdById: who?.id ?? null,
        })
        .returning();
      await rememberItem(c, db, { dataset: true }, "create", null, doc);

      broadcastMutation(ds.id, "insert", { datasetSlug: collection, entryId: doc.id });
      await invalidateGraphQLCache();
      return c.json({ id: doc.id, ...doc.data, _meta: { datasetId: doc.dataSetId } }, 201);
    }

    const table = resolved.table;
    const [doc] = await db.insert(table).values(body).returning();
    await rememberItem(c, db, { table }, "create", null, doc);
    broadcastMutation(collection, "insert", { id: doc.id });
    await invalidateGraphQLCache();
    return c.json(doc, 201);
  } catch (err: unknown) {
    logger.error({ collection, error: messageOf(err) }, "Failed to create item");
    return c.json({ error: "Insert failed", details: messageOf(err) }, 500);
  }
}
// (registered in the final chain)

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// RECORD HISTORY (core migration 0076)
// ═══════════════════════════════════════════════════════════════════════════════

type HistoryRow = Record<string, unknown>;

/**
 * A write through /api/items in the record history, as the other paths record
 * it: a dataset entry as `dataset_entry`, a table row as `table:<name>` with
 * column names. Never fails the request.
 */
async function rememberItem(
  c: Context,
  db: Parameters<typeof recordChanges>[0],
  target: { dataset: true } | { table: unknown },
  action: RecordAction,
  before: HistoryRow | null | undefined,
  after: HistoryRow | null | undefined
): Promise<void> {
  const user = c.get("user");
  const inputs =
    "dataset" in target
      ? [
          {
            entity: DATASET_ENTRY_ENTITY,
            rowId: (after ?? before)?.id,
            action,
            before: before ?? null,
            after: after ?? null,
            user,
            diff: DATASET_ENTRY_DIFF,
          },
        ]
      : tableChanges(target.table, [{ action, before, after }], user);
  await recordChanges(db, inputs, (err) =>
    logger.warn({ error: messageOf(err) }, "[items] could not record the history")
  );
}

export async function updateItemHandler(c: Context) {
  const db = getDb(c);
  const collection = c.req.param("collection")!;
  const id = c.req.param("id")!;
  const body = await c.req.json();

  const resolved = await resolveCollection(db, collection);
  if (resolved.type === "unknown") {
    return c.json({ error: "Collection not found", collection }, 404);
  }
  const withRoute = writeWithOwnRoute(c, resolved);
  if (withRoute) return withRoute;

  try {
    if (resolved.type === "dataset") {
      const ds = resolved.dataset;
      const [existing] = await db
        .select()
        .from(dataEntries)
        .where(and(eq(dataEntries.dataSetId, ds.id), eq(dataEntries.id, id)))
        .limit(1);
      if (!existing) return c.json({ error: "Not found" }, 404);

      const schema = ds.schema ?? [];
      const mergedInput = { ...(existing.data as any), ...body };
      const validation = validateDatasetEntry(schema, mergedInput);
      if (!validation.success) {
        return c.json({ error: "Validation failed", details: validation.error.format() }, 400);
      }
      const versioned = addSchemaVersionToData(schema, validation.data);
      const [doc] = await db
        .update(dataEntries)
        .set({
          data: versioned,
          title: (versioned.title as string) || (versioned.name as string) || existing.title,
        })
        .where(eq(dataEntries.id, id))
        .returning();
      await rememberItem(c, db, { dataset: true }, "update", existing, doc);

      broadcastMutation(ds.id, "update", { datasetSlug: collection, entryId: doc.id });
      await invalidateGraphQLCache();
      return c.json({ id: doc.id, ...doc.data, _meta: { datasetId: doc.dataSetId } });
    }

    const table = resolved.table;
    const [existing] = await db.select().from(table).where(eq(table.id, id)).limit(1);
    if (!existing) return c.json({ error: "Not found" }, 404);

    const [doc] = await db.update(table).set(body).where(eq(table.id, id)).returning();
    await rememberItem(c, db, { table }, "update", existing, doc);
    broadcastMutation(collection, "update", { id: doc.id });
    await invalidateGraphQLCache();
    return c.json(doc);
  } catch (err: unknown) {
    logger.error({ collection, id, error: messageOf(err) }, "Failed to update item");
    return c.json({ error: "Update failed", details: messageOf(err) }, 500);
  }
}
// (registered in the final chain)

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE
// ═══════════════════════════════════════════════════════════════════════════════

export async function deleteItemHandler(c: Context) {
  const db = getDb(c);
  const collection = c.req.param("collection")!;
  const id = c.req.param("id")!;

  const resolved = await resolveCollection(db, collection);
  if (resolved.type === "unknown") {
    return c.json({ error: "Collection not found", collection }, 404);
  }
  const withRoute = writeWithOwnRoute(c, resolved);
  if (withRoute) return withRoute;

  try {
    if (resolved.type === "dataset") {
      const ds = resolved.dataset;
      const [existing] = await db
        .select()
        .from(dataEntries)
        .where(and(eq(dataEntries.dataSetId, ds.id), eq(dataEntries.id, id)))
        .limit(1);
      if (!existing) return c.json({ error: "Not found" }, 404);

      await db.delete(dataEntries).where(eq(dataEntries.id, id));
      await rememberItem(c, db, { dataset: true }, "delete", existing, null);
      broadcastMutation(ds.id, "delete", { datasetSlug: collection, entryId: id });
      await invalidateGraphQLCache();
      return c.json({ success: true, id });
    }

    const table = resolved.table;
    const [existing] = await db.select().from(table).where(eq(table.id, id)).limit(1);
    if (!existing) return c.json({ error: "Not found" }, 404);

    await db.delete(table).where(eq(table.id, id));
    await rememberItem(c, db, { table }, "delete", existing, null);
    broadcastMutation(collection, "delete", { id });
    await invalidateGraphQLCache();
    return c.json({ success: true, id });
  } catch (err: unknown) {
    logger.error({ collection, id, error: messageOf(err) }, "Failed to delete item");
    return c.json({ error: "Delete failed", details: messageOf(err) }, 500);
  }
}
// (registered in the final chain)

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTER (chained — Hono RPC, KITSUDEN architecture §7)
// Same registration order as the statement-style version. The middleware applies
// transactional RLS to everything; mutations additionally require requireAuth.
// ═══════════════════════════════════════════════════════════════════════════════

export const itemsRoutes = new Hono<{ Variables: AppVariables }>()
  .use("/*", async (c, next) => {
    if (["POST", "PATCH", "DELETE"].includes(c.req.method)) {
      return requireAuth(c, async () => {
        await withTransactionalRLS()(c, next);
      });
    }
    // For reads, also use transactional RLS so policies are enforced consistently
    await withTransactionalRLS()(c, next);
  })
  .post("/:collection/query", queryItemsHandler)
  .get("/:collection", listItemsHandler)
  .get("/:collection/:id", getItemHandler)
  .post("/:collection", createItemHandler)
  .patch("/:collection/:id", updateItemHandler)
  .delete("/:collection/:id", deleteItemHandler);

/** Accumulated router type — consumed by src/rpc.ts */
export type ItemsRoutesType = typeof itemsRoutes;
