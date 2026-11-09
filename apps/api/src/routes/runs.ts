/**
 * Run Inspector — observability of executions (Workbench style)
 * ============================================================================
 *
 * The `action_executions` table already captures everything interesting about each run
 * (status, trigger, payload, logs, result, error, duration, memory), but
 * until now it could only be queried PER ACTION. An inspector needs the
 * GLOBAL feed: "what is happening in my backend right now".
 *
 *   GET  /api/runs                → global feed with filters and pagination
 *   GET  /api/runs/stats          → dashboard cards (24h)
 *   GET  /api/runs/:id            → full detail of one execution
 *
 * Requires admin: executions include payloads and logs from the whole system,
 * which may contain any user's data.
 */

import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db";
import { actions, actionExecutions } from "../db/schema";
import { protectRoute, requireAdmin } from "../middleware/auth-guard";

export const runsRoutes = new Hono();

runsRoutes.use("/*", protectRoute, requireAdmin);

/** Time window → cutoff timestamp. */
function sinceOf(window: string | undefined): Date | null {
  const map: Record<string, number> = {
    "1h": 3_600_000,
    "24h": 86_400_000,
    "7d": 604_800_000,
    "30d": 2_592_000_000,
  };
  const ms = map[window ?? ""] ?? null;
  return ms ? new Date(Date.now() - ms) : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// FEED GLOBAL
// ═══════════════════════════════════════════════════════════════════════════

runsRoutes.get("/", async (c) => {
  const limit = Math.min(Number.parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
  const offset = Math.max(Number.parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  const status = c.req.query("status");
  const actionId = c.req.query("actionId");
  const since = sinceOf(c.req.query("window"));

  const conditions = [];
  if (status) conditions.push(eq(actionExecutions.status, status as never));
  if (actionId) conditions.push(eq(actionExecutions.actionId, actionId));
  if (since) conditions.push(gte(actionExecutions.createdAt, since));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // JOIN with actions to show the name and the trigger without a second query.
  const rows = await db
    .select({
      id: actionExecutions.id,
      actionId: actionExecutions.actionId,
      actionName: actions.name,
      actionType: actions.type,
      status: actionExecutions.status,
      triggerType: actionExecutions.triggerType,
      triggerEvent: actionExecutions.triggerEvent,
      durationMs: actionExecutions.durationMs,
      memoryUsedBytes: actionExecutions.memoryUsedBytes,
      errorMessage: actionExecutions.errorMessage,
      startedAt: actionExecutions.startedAt,
      finishedAt: actionExecutions.finishedAt,
      createdAt: actionExecutions.createdAt,
    })
    .from(actionExecutions)
    .leftJoin(actions, eq(actions.id, actionExecutions.actionId))
    .where(where)
    .orderBy(desc(actionExecutions.createdAt))
    .limit(limit)
    .offset(offset);

  const [total] = await db.select({ value: count() }).from(actionExecutions).where(where);

  return c.json({
    docs: rows,
    totalDocs: total?.value ?? 0,
    limit,
    offset,
    hasMore: offset + rows.length < (total?.value ?? 0),
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// STATS — dashboard cards
// ═══════════════════════════════════════════════════════════════════════════

runsRoutes.get("/stats", async (c) => {
  const since = sinceOf(c.req.query("window") ?? "24h")!;
  const inWindow = gte(actionExecutions.createdAt, since);

  const [byStatus, timing, topFailing] = await Promise.all([
    db
      .select({ status: actionExecutions.status, value: count() })
      .from(actionExecutions)
      .where(inWindow)
      .groupBy(actionExecutions.status),

    // p50/p95 in SQL: percentile_cont is exact and avoids pulling rows into memory.
    db
      .select({
        avgMs: sql<number>`coalesce(avg(${actionExecutions.durationMs}), 0)::int`,
        p50: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${actionExecutions.durationMs}), 0)::int`,
        p95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${actionExecutions.durationMs}), 0)::int`,
        maxMs: sql<number>`coalesce(max(${actionExecutions.durationMs}), 0)::int`,
      })
      .from(actionExecutions)
      .where(inWindow),

    db
      .select({
        actionId: actionExecutions.actionId,
        actionName: actions.name,
        failures: count(),
      })
      .from(actionExecutions)
      .leftJoin(actions, eq(actions.id, actionExecutions.actionId))
      .where(and(inWindow, eq(actionExecutions.status, "failed" as never)))
      .groupBy(actionExecutions.actionId, actions.name)
      .orderBy(desc(count()))
      .limit(5),
  ]);

  const counts = Object.fromEntries(byStatus.map((r) => [r.status, r.value]));
  const total = byStatus.reduce((n, r) => n + r.value, 0);
  const failed = counts.failed ?? 0;

  return c.json({
    window: c.req.query("window") ?? "24h",
    total,
    byStatus: counts,
    // Success rate over those that finished (pending/running do not count).
    successRate: total > 0 ? Number((((total - failed) / total) * 100).toFixed(2)) : 100,
    duration: timing[0] ?? { avgMs: 0, p50: 0, p95: 0, maxMs: 0 },
    topFailing,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DETAIL — full payload, result and logs
// ═══════════════════════════════════════════════════════════════════════════

runsRoutes.get("/:id", async (c) => {
  const [run] = await db
    .select({
      execution: actionExecutions,
      actionName: actions.name,
      actionType: actions.type,
      actionTrigger: actions.trigger,
    })
    .from(actionExecutions)
    .leftJoin(actions, eq(actions.id, actionExecutions.actionId))
    .where(eq(actionExecutions.id, c.req.param("id")))
    .limit(1);

  if (!run) {
    return c.json({ error: { code: "NOT_FOUND", message: "Execution not found" } }, 404);
  }

  return c.json({
    ...run.execution,
    action: {
      name: run.actionName,
      type: run.actionType,
      trigger: run.actionTrigger,
    },
    // Logs are stored as plain text; they are returned already split into lines
    // so the UI does not have to do it.
    logLines: run.execution.logs ? run.execution.logs.split("\n") : [],
  });
});
