/**
 * Kitsuden — Kitsuden Workers API Routes
 *
 * CRUD for cloud functions + manual execution + execution logs.
 *
 * Endpoints:
 *   GET    /api/functions           — List all functions
 *   POST   /api/functions           — Create function
 *   GET    /api/functions/:id       — Get function detail
 *   PATCH  /api/functions/:id       — Update function
 *   DELETE /api/functions/:id       — Delete function
 *   POST   /api/functions/:id/execute — Execute manually
 *   GET    /api/functions/:id/executions — Get execution logs
 *   GET    /api/functions/cron/status — Get cron job status
 */

import { messageOf, eqEnum } from "@kitsuden/engine";
import { eq, desc, and } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";

import { db } from "../db";
import { kitsudenFunctions, functionExecutions, dataSets } from "../db/schema";
import {
  codeOutsidePromotionProblem,
  respondProblem,
  scheduleOutsidePromotionProblem,
} from "../lib/actions-code";
import { refreshCronJob, removeCronJob, getCronJobStatus } from "../lib/cron-scheduler";
import { executeManually } from "../lib/function-dispatcher";
import { requestCreator, requestExecutor } from "../lib/sandbox/identity";

/** An agent does not write function code; it uses promotion. */
function agentCode(c: Context, body: { code?: unknown }): Response | null {
  if (body?.code === undefined || requestExecutor(c)?.type !== "agent") return null;
  const requestId = ((c.get as (k: string) => unknown)("requestId") as string | undefined) ?? null;
  return respondProblem(c as never, codeOutsidePromotionProblem(c.req.path, requestId));
}

/** Nor when it runs: the same rule as a code action's trigger (lib/actions-code.ts). */
const FUNCTION_SCHEDULE_KEYS = ["trigger", "cronExpression", "watchDatasetId", "status"] as const;
function agentSchedule(c: Context, body: Record<string, unknown>): Response | null {
  if (requestExecutor(c)?.type !== "agent") return null;
  if (!FUNCTION_SCHEDULE_KEYS.some((k) => body?.[k] !== undefined)) return null;
  const requestId = ((c.get as (k: string) => unknown)("requestId") as string | undefined) ?? null;
  return respondProblem(c as never, scheduleOutsidePromotionProblem(c.req.path, requestId));
}
import { protectRoute } from "../middleware/auth-guard";

export const functionsRoutes = new Hono();

// ── All routes require auth ──
functionsRoutes.use("/*", protectRoute);

// ═══════════════════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════════════════

// ── List functions ──
export async function listFunctionsHandler(c: Context) {
  const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
  const trigger = c.req.query("trigger");
  const status = c.req.query("status");

  // Drizzle doesn't allow dynamic chaining well, so build conditions
  const conditions = [];
  // `eqEnum` returns undefined if the value does not belong to the enum.
  const filter44 = eqEnum(kitsudenFunctions.trigger, trigger);
  if (filter44) conditions.push(filter44);
  // `eqEnum` returns undefined if the value does not belong to the enum.
  const filter45 = eqEnum(kitsudenFunctions.status, status);
  if (filter45) conditions.push(filter45);

  const docs =
    conditions.length > 0
      ? await db
          .select()
          .from(kitsudenFunctions)
          .where(and(...conditions))
          .orderBy(desc(kitsudenFunctions.updatedAt))
          .limit(limit)
      : await db
          .select()
          .from(kitsudenFunctions)
          .orderBy(desc(kitsudenFunctions.updatedAt))
          .limit(limit);

  return c.json({ docs, totalDocs: docs.length });
}
functionsRoutes.get("/", listFunctionsHandler);

// ── Get single function ──
export async function getCronStatusHandler(c: Context) {
  return c.json({ jobs: getCronJobStatus() });
}
functionsRoutes.get("/cron/status", getCronStatusHandler);

export async function getFunctionHandler(c: Context) {
  const [fn] = await db
    .select()
    .from(kitsudenFunctions)
    .where(eq(kitsudenFunctions.id, c.req.param("id")!))
    .limit(1);

  if (!fn) return c.json({ error: "Function not found" }, 404);

  // Also fetch dataset name if watching one
  let watchDataset = null;
  if (fn.watchDatasetId) {
    const [ds] = await db
      .select({ id: dataSets.id, name: dataSets.name, slug: dataSets.slug })
      .from(dataSets)
      .where(eq(dataSets.id, fn.watchDatasetId))
      .limit(1);
    watchDataset = ds || null;
  }

  return c.json({ ...fn, watchDataset });
}
functionsRoutes.get("/:id", getFunctionHandler);

// ── Create function ──
export async function createFunctionHandler(c: Context) {
  const body = await c.req.json();
  const banned = agentCode(c, body);
  if (banned) return banned;

  if (!body.name || !body.code || !body.trigger) {
    return c.json({ error: "name, code, and trigger are required" }, 400);
  }

  const slug =
    body.slug ||
    body.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");

  // Validate cron expression if trigger is cron
  if (body.trigger === "cron" && !body.cronExpression) {
    return c.json({ error: "cronExpression required for cron trigger" }, 400);
  }

  const [fn] = await db
    .insert(kitsudenFunctions)
    .values({
      name: body.name,
      slug,
      description: body.description || null,
      code: body.code,
      trigger: body.trigger,
      cronExpression: body.cronExpression || null,
      watchDatasetId: body.watchDatasetId || null,
      timeoutMs: body.timeoutMs || 5000,
      memoryLimitMb: body.memoryLimitMb || 64,
      status: body.status || "active",
      envVars: body.envVars || {},
      // From the session, not the body: before, anyone could attribute it to someone else.
      createdById: requestCreator(c),
    })
    .returning();

  // If cron, schedule it (legacy)
  refreshCronJob(fn as any);

  return c.json(fn, 201);
}
functionsRoutes.post("/", createFunctionHandler);

// ── Update function ──
export async function updateFunctionHandler(c: Context) {
  const body = await c.req.json();
  const banned = agentCode(c, body) ?? agentSchedule(c, body);
  if (banned) return banned;
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  const allowedFields = [
    "name",
    "slug",
    "description",
    "code",
    "trigger",
    "cronExpression",
    "watchDatasetId",
    "timeoutMs",
    "memoryLimitMb",
    "status",
    "envVars",
  ];

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  // Validate cron
  if (updates.trigger === "cron" && !updates.cronExpression && !body.cronExpression) {
    return c.json({ error: "cronExpression required for cron trigger" }, 400);
  }

  const [updated] = await db
    .update(kitsudenFunctions)
    .set(updates)
    .where(eq(kitsudenFunctions.id, c.req.param("id")!))
    .returning();

  if (!updated) return c.json({ error: "Function not found" }, 404);

  // Refresh cron schedule (legacy)
  refreshCronJob(updated as any);

  return c.json(updated);
}
functionsRoutes.patch("/:id", updateFunctionHandler);

// ── Delete function ──
export async function deleteFunctionHandler(c: Context) {
  const id = c.req.param("id")!;

  // Remove cron job first
  removeCronJob(id);

  const [deleted] = await db
    .delete(kitsudenFunctions)
    .where(eq(kitsudenFunctions.id, id))
    .returning({ id: kitsudenFunctions.id, name: kitsudenFunctions.name });

  if (!deleted) return c.json({ error: "Function not found" }, 404);

  return c.json({ success: true, id: deleted.id, name: deleted.name });
}
functionsRoutes.delete("/:id", deleteFunctionHandler);

// ═══════════════════════════════════════════════════════════════
// Execution
// ═══════════════════════════════════════════════════════════════

// ── Manual Execute ──
export async function executeFunctionHandler(c: Context) {
  const body = await c.req.json().catch(() => ({}));

  try {
    const result = await executeManually(c.req.param("id")!, body.payload, requestExecutor(c));
    return c.json({
      success: result.success,
      result: result.result,
      logs: result.logs,
      error: result.error,
      durationMs: result.durationMs,
      exitReason: result.exitReason,
    });
  } catch (err: unknown) {
    return c.json({ error: messageOf(err) }, 404);
  }
}
functionsRoutes.post("/:id/execute", executeFunctionHandler);

// ── Execution Logs ──
export async function listExecutionsHandler(c: Context) {
  const limit = Math.min(Number(c.req.query("limit")) || 25, 100);
  const status = c.req.query("status");

  const conditions = [eq(functionExecutions.functionId, c.req.param("id")!)];
  // `eqEnum` returns undefined if the value does not belong to the enum.
  const filter233 = eqEnum(functionExecutions.status, status);
  if (filter233) conditions.push(filter233);

  const docs = await db
    .select()
    .from(functionExecutions)
    .where(and(...conditions))
    .orderBy(desc(functionExecutions.createdAt))
    .limit(limit);

  return c.json({ docs, totalDocs: docs.length });
}
functionsRoutes.get("/:id/executions", listExecutionsHandler);
