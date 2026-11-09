/**
 * Graphify Engine — Routes (KITSUDEN architecture §3)
 *
 * Automatic relational endpoints mounted at /api/graph.
 * They run under withTransactionalRLS (mounted in index.ts), so
 * PostgreSQL applies the RLS policies on every query via c.get("tx").
 *
 * CHAINED SYNTAX (Hono RPC): routes are registered chained so that
 * `typeof graphifyRoutes` accumulates the types of each endpoint. The client
 * gets end-to-end autocompletion without codegen:
 *
 *   import { hc } from "hono/client";
 *   import type { GraphifyAppType } from "@kitsuden/api"; // or a relative path
 *   const graph = hc<GraphifyAppType>(`${baseUrl}/api/graph`);
 *   const res = await graph[":table"].$get({ param: { table: "games" } });
 */

import { Hono } from "hono";

import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import {
  buildGraphFor,
  listRows,
  getRow,
  getRelatedRows,
  invalidateGraphifyCache,
  GraphifyError,
} from "../services/graphify";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getExecutor(c: any) {
  // Prefer the RLS transaction of the Titanium Wall; fall back to db
  return c.get("tx") ?? db;
}

/**
 * Admin? Decides which tables it sees (see `canViewTable` in services/graphify).
 * An agent counts as admin only with the `admin` scope, the same as at the
 * gates in `auth-guard.ts`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function accessOf(c: any): { isAdmin: boolean } {
  const agent = c.get("agent") as { scopes?: string[] } | undefined;
  if (agent) return { isAdmin: agent.scopes?.includes("admin") === true };
  const user = c.get("user") as { role?: string } | null | undefined;
  return { isAdmin: user?.role === "admin" };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleError(c: any, err: unknown) {
  if (err instanceof GraphifyError) {
    return c.json({ success: false, error: err.message }, err.status);
  }
  console.error("[Graphify] Unexpected error:", err);
  return c.json({ success: false, error: "Graphify internal error" }, 500);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseListOptions(c: any) {
  const reserved = new Set(["limit", "offset", "orderBy", "order", "format"]);
  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(c.req.query() as Record<string, string>)) {
    if (!reserved.has(key)) filters[key] = value;
  }
  return {
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    offset: c.req.query("offset") ? Number(c.req.query("offset")) : undefined,
    orderBy: c.req.query("orderBy") || undefined,
    order: c.req.query("order") === "desc" ? ("desc" as const) : ("asc" as const),
    filters,
  };
}

export const graphifyRoutes = new Hono()
  .use("/*", requireAuth)

  /**
   * GET /api/graph
   * Full graph: exposed tables + edges (FK relations).
   */
  .get("/", async (c) => {
    try {
      const graph = await buildGraphFor(accessOf(c));
      return c.json({ success: true, ...graph, edgeCount: graph.edges.length });
    } catch (err) {
      return handleError(c, err);
    }
  })

  /**
   * POST /api/graph/refresh
   * Invalidates the graph cache (useful after activating a new kon).
   */
  .post("/refresh", async (c) => {
    // Clearing the cache forces the database to be re-introspected: it is not for just anyone
    if (!accessOf(c).isAdmin) return c.json({ success: false, error: "Forbidden" }, 403);
    invalidateGraphifyCache();
    return c.json({ success: true, message: "Graphify cache invalidated" });
  })

  /**
   * GET /api/graph/:table
   * Paginated list with equality filters (?column=value).
   */
  .get("/:table", async (c) => {
    try {
      const result = await listRows(
        getExecutor(c),
        c.req.param("table"),
        parseListOptions(c),
        accessOf(c)
      );
      return c.json({ success: true, table: c.req.param("table"), ...result });
    } catch (err) {
      return handleError(c, err);
    }
  })

  /**
   * GET /api/graph/:table/:id
   * A single record by primary key.
   */
  .get("/:table/:id", async (c) => {
    try {
      const row = await getRow(
        getExecutor(c),
        c.req.param("table"),
        c.req.param("id"),
        accessOf(c)
      );
      if (!row) return c.json({ success: false, error: "Record not found" }, 404);
      return c.json({ success: true, table: c.req.param("table"), row });
    } catch (err) {
      return handleError(c, err);
    }
  })

  /**
   * GET /api/graph/:table/:id/:relation
   * Related rows — JOINs resolved automatically (N:1, 1:N and N:M).
   * KITSUDEN example: /api/graph/users/1/projects
   */
  .get("/:table/:id/:relation", async (c) => {
    try {
      const result = await getRelatedRows(
        getExecutor(c),
        c.req.param("table"),
        c.req.param("id"),
        c.req.param("relation"),
        parseListOptions(c),
        accessOf(c)
      );
      return c.json({
        success: true,
        table: c.req.param("table"),
        relation: c.req.param("relation"),
        ...result,
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

/** Hono RPC: accumulated type of all the Graphify endpoints */
export type GraphifyAppType = typeof graphifyRoutes;
