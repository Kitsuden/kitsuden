/**
 * Actions API Routes
 *
 * Unified API for managing and executing actions.
 * Replaces /functions and /webhooks endpoints.
 */

import { messageOf, eqEnum } from "@kitsuden/engine";
import { eq, desc, and, count } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";

import { db } from "../db";
import { actions, actionExecutions } from "../db/schema";
import {
  listActions,
  getAction,
  createAction,
  updateAction,
  deleteAction,
  executeActionById,
} from "../lib/actions";
import {
  changesCode,
  changesSchedule,
  changesCustomerDataPolicy,
  codeOutsidePromotionProblem,
  customerDataPolicyProblem,
  respondProblem,
  bringsCode,
  scheduleOutsidePromotionProblem,
  SCHEDULE_KEYS,
} from "../lib/actions-code";
import { requestCreator, requestExecutor } from "../lib/sandbox/identity";
import { protectRoute } from "../middleware/auth-guard";

/**
 * The `manual` version of a human edit (lib/promotion.ts). Deferred import:
 * promotion drags in the whole action engine, and this file is tested
 * with the mocked engine (tests-unit/actions-handlers.test.ts).
 */
async function registerManualEdit(
  ...args: Parameters<typeof import("../lib/promotion").registerManualEdit>
) {
  const { registerManualEdit: register } = await import("../lib/promotion");
  return register(...args);
}

/**
 * `config.url` of a `webhook_out` action, checked when it is saved (and again
 * when it is sent): no internal target unless KITSUDEN_WEBHOOK_ALLOW_INTERNAL
 * covers it. Deferred import, like `registerManualEdit`.
 */
async function webhookUrlProblem(config: unknown): Promise<string | null> {
  const { webhookConfigUrlProblem } = await import("../lib/actions/handlers/webhook-out-handler");
  return webhookConfigUrlProblem((config as { url?: unknown } | null | undefined)?.url);
}

/**
 * May this AGENT define an action that makes the agent `agentId` act (with
 * THAT agent's scopes)? Only if its scopes cover the target's. Deferred
 * import, like `registerManualEdit`: the agent handler drags in the whole
 * agent engine.
 */
async function reasonNotToDefineAgent(
  agentId: unknown,
  scopes: readonly string[]
): Promise<string | null> {
  const { reasonNotToDefine } = await import("../lib/actions/handlers/agent-handler");
  return reasonNotToDefine(agentId, scopes);
}

function requestIdOf(c: Context): string | null {
  return ((c.get as (k: string) => unknown)("requestId") as string | undefined) ?? null;
}

export const actionsRoutes = new Hono();

// All routes require auth
actionsRoutes.use("/*", protectRoute);

// ═══════════════════════════════════════════════════════════════════════════
// List Actions
// ═══════════════════════════════════════════════════════════════════════════

export async function listActionsHandler(c: Context) {
  const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
  const type = c.req.query("type") as any;
  const trigger = c.req.query("trigger") as any;
  const status = c.req.query("status") as any;

  const docs = await listActions({ type, trigger, status, limit });

  return c.json({ docs, totalDocs: docs.length });
}
actionsRoutes.get("/", listActionsHandler);

// ═══════════════════════════════════════════════════════════════════════════
// Create Action
// ═══════════════════════════════════════════════════════════════════════════

export async function createActionHandler(c: Context) {
  const body = await c.req.json();

  // Validate required fields
  if (!body.name || !body.type || !body.trigger) {
    return c.json(
      {
        error: "name, type, and trigger are required",
        details: {
          name: body.name ? "provided" : "missing",
          type: body.type ? "provided" : "missing",
          trigger: body.trigger ? "provided" : "missing",
        },
      },
      400
    );
  }

  // Validate type
  const validTypes = ["code", "webhook_out", "webhook_in", "agent"];
  if (!validTypes.includes(body.type)) {
    return c.json(
      {
        error: `Invalid type. Must be one of: ${validTypes.join(", ")}`,
      },
      400
    );
  }

  // Validate trigger
  const validTriggers = ["manual", "cron", "event", "http"];
  if (!validTriggers.includes(body.trigger)) {
    return c.json(
      {
        error: `Invalid trigger. Must be one of: ${validTriggers.join(", ")}`,
      },
      400
    );
  }

  // Validate trigger config
  if (body.trigger === "cron" && !body.triggerConfig?.cronExpression) {
    return c.json({ error: "triggerConfig.cronExpression required for cron trigger" }, 400);
  }

  // An agent does not create code here, only through promotion.
  const executor = requestExecutor(c);
  if (executor?.type === "agent" && (body.type === "code" || bringsCode(body.config))) {
    return respondProblem(c as never, codeOutsidePromotionProblem(c.req.path, requestIdOf(c)));
  }
  // Where customer data may go is a person's decision (docs/agents/egress.md).
  if (executor?.type !== "human" && changesCustomerDataPolicy({}, body.config)) {
    return respondProblem(c as never, customerDataPolicyProblem(c.req.path, requestIdOf(c)));
  }
  if (body.type === "webhook_out") {
    const problem = await webhookUrlProblem(body.config);
    if (problem) return c.json({ error: problem }, 400);
  }
  // An agent does not define an `agent` action against an agent with more permissions.
  if (executor?.type === "agent" && (body.type === "agent" || body.config?.agentId !== undefined)) {
    const reason = await reasonNotToDefineAgent(body.config?.agentId, executor.agent.scopes ?? []);
    if (reason) return c.json({ error: reason, code: "FORBIDDEN" }, 403);
  }

  try {
    const action = await createAction({
      name: body.name,
      slug: body.slug,
      description: body.description,
      type: body.type,
      trigger: body.trigger,
      triggerConfig: body.triggerConfig,
      config: body.config,
      status: body.status || "active",
      // From the session: accountable for the action when it fires from cron or an event.
      createdById: requestCreator(c),
    });

    // A person: their code becomes the first `manual` version (lib/promotion.ts).
    if (action.type === "code" && bringsCode(action.config)) {
      await registerManualEdit(null, action, executor?.type === "human" ? executor.userId : null);
    }
    return c.json(action, 201);
  } catch (err: unknown) {
    return c.json({ error: messageOf(err) || "Failed to create action" }, 500);
  }
}
actionsRoutes.post("/", createActionHandler);

// ═══════════════════════════════════════════════════════════════════════════
// Get Single Action
// ═══════════════════════════════════════════════════════════════════════════

export async function getActionHandler(c: Context) {
  const action = await getAction(c.req.param("id")!);

  if (!action) {
    return c.json({ error: "Action not found" }, 404);
  }

  return c.json(action);
}
actionsRoutes.get("/:id", getActionHandler);

// ═══════════════════════════════════════════════════════════════════════════
// Update Action
// ═══════════════════════════════════════════════════════════════════════════

export async function updateActionHandler(c: Context) {
  const body = await c.req.json();

  // The code (and what it declares) only changes through promotion if the
  // requester is an agent, and when a code action runs (trigger, its config,
  // status) only a human decides; everything else (name, envVars…), as before.
  const needsBefore = body.config !== undefined || SCHEDULE_KEYS.some((k) => body[k] !== undefined);
  const before = needsBefore ? await getAction(c.req.param("id")!) : null;
  const isCode = !!before && before.type === "code";
  const touchesCode =
    isCode && body.config !== undefined && changesCode(before.config, body.config);
  const executor = requestExecutor(c);
  if (touchesCode && executor?.type !== "human") {
    return respondProblem(c as never, codeOutsidePromotionProblem(c.req.path, requestIdOf(c)));
  }
  if (
    isCode &&
    executor?.type !== "human" &&
    changesSchedule(before as unknown as Record<string, unknown>, body)
  ) {
    return respondProblem(c as never, scheduleOutsidePromotionProblem(c.req.path, requestIdOf(c)));
  }
  if (
    before &&
    executor?.type !== "human" &&
    changesCustomerDataPolicy(before.config, body.config)
  ) {
    return respondProblem(c as never, customerDataPolicyProblem(c.req.path, requestIdOf(c)));
  }
  // A new config for a webhook_out passes the same target check as at creation.
  if (before?.type === "webhook_out" && body.config !== undefined) {
    const problem = await webhookUrlProblem(body.config);
    if (problem) return c.json({ error: problem }, 400);
  }
  // An agent editing an `agent` action (its prompt, its trigger, its agent…)
  // must be able to act as the agent the action ends up with.
  if (executor?.type === "agent") {
    const previous = before ?? (await getAction(c.req.param("id")!));
    const config = (body.config ?? previous?.config) as { agentId?: unknown } | null | undefined;
    if (previous?.type === "agent" || config?.agentId !== undefined) {
      const reason = await reasonNotToDefineAgent(config?.agentId, executor.agent.scopes ?? []);
      if (reason) return c.json({ error: reason, code: "FORBIDDEN" }, 403);
    }
  }

  try {
    const updated = await updateAction(c.req.param("id")!, {
      name: body.name,
      slug: body.slug,
      description: body.description,
      trigger: body.trigger,
      triggerConfig: body.triggerConfig,
      config: body.config,
      status: body.status,
    });

    if (!updated) {
      return c.json({ error: "Action not found" }, 404);
    }

    if (touchesCode && executor?.type === "human") {
      await registerManualEdit(before, updated, executor.userId);
    }
    return c.json(updated);
  } catch (err: unknown) {
    return c.json({ error: messageOf(err) || "Failed to update action" }, 500);
  }
}
actionsRoutes.patch("/:id", updateActionHandler);

// ═══════════════════════════════════════════════════════════════════════════
// Delete Action
// ═══════════════════════════════════════════════════════════════════════════

export async function deleteActionHandler(c: Context) {
  const deleted = await deleteAction(c.req.param("id")!);

  if (!deleted) {
    return c.json({ error: "Action not found" }, 404);
  }

  return c.json({ success: true });
}
actionsRoutes.delete("/:id", deleteActionHandler);

// ═══════════════════════════════════════════════════════════════════════════
// Execute Action
// ═══════════════════════════════════════════════════════════════════════════

export async function executeActionHandler(c: Context) {
  const body = await c.req.json().catch(() => ({}));
  const actionId = c.req.param("id")!;

  // Check if action exists
  const action = await getAction(actionId);
  if (!action) {
    return c.json({ error: "Action not found" }, 404);
  }

  // Execute
  const result = await executeActionById(actionId, {
    trigger: body.trigger || "manual",
    triggerEvent: body.event,
    event: body.event
      ? {
          name: body.event,
          data: body.payload || {},
          timestamp: new Date().toISOString(),
        }
      : undefined,
    request: body.request,
    env: body.env,
    executor: requestExecutor(c),
  });

  return c.json({
    success: result.success,
    result: result.result,
    logs: result.logs,
    error: result.error,
    durationMs: result.durationMs,
    httpResponse: result.httpResponse,
  });
}
actionsRoutes.post("/:id/execute", executeActionHandler);

// ═══════════════════════════════════════════════════════════════════════════
// Get Action Executions
// ═══════════════════════════════════════════════════════════════════════════

export async function listActionExecutionsHandler(c: Context) {
  const actionId = c.req.param("id")!;
  const limit = Math.min(Number(c.req.query("limit")) || 25, 100);
  const status = c.req.query("status");

  // Verify action exists
  const action = await getAction(actionId);
  if (!action) {
    return c.json({ error: "Action not found" }, 404);
  }

  const conditions = [eq(actionExecutions.actionId, actionId)];
  // `eqEnum` returns undefined if the value does not belong to the enum.
  const filter228 = eqEnum(actionExecutions.status, status);
  if (filter228) conditions.push(filter228);

  const docs = await db
    .select()
    .from(actionExecutions)
    .where(and(...conditions))
    .orderBy(desc(actionExecutions.createdAt))
    .limit(limit);

  return c.json({ docs, totalDocs: docs.length });
}
actionsRoutes.get("/:id/executions", listActionExecutionsHandler);

// ═══════════════════════════════════════════════════════════════════════════
// Stats
// ═══════════════════════════════════════════════════════════════════════════

export async function getActionStatsHandler(c: Context) {
  const [totalResult] = await db.select({ count: count() }).from(actions);

  const [activeResult] = await db
    .select({ count: count() })
    .from(actions)
    .where(eq(actions.status, "active"));

  const typeCounts = await db
    .select({
      type: actions.type,
      count: count(),
    })
    .from(actions)
    .groupBy(actions.type);

  return c.json({
    total: totalResult.count,
    active: activeResult.count,
    byType: typeCounts.reduce(
      (acc, { type, count }) => {
        acc[type] = count;
        return acc;
      },
      {} as Record<string, number>
    ),
  });
}
actionsRoutes.get("/stats/overview", getActionStatsHandler);
