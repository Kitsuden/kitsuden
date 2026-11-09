/**
 * An agent's own decisions: what it chose NOT to do, and why
 * ============================================================================
 *
 *   POST /api/agent/decisions   { action, reason, alternatives?, context?, traceId? }
 *   GET  /api/agent/decisions   its own, newest first (?limit, ?offset, ?days)
 *
 * Agents only (with their key; any scope): the session decides whose row it
 * is. A person reads them all in the panel (GET /api/v1/agent-decisions,
 * routes/agent-permissions.ts). Never held for approval and no write quota
 * (lib/approvals.ts, lib/agent-quotas.ts). See lib/agent-decisions.ts.
 */

import { Hono, type Context } from "hono";

import {
  InvalidDecision,
  decisionView,
  listDecisions,
  parseDecision,
  recordDecision,
} from "../lib/agent-decisions";
import { logger } from "../lib/logger";
import type { AgentAuthContext } from "../services/agent-auth";
import type { AppVariables } from "../types/hono";

export const agentDecisionsRoutes = new Hono<{ Variables: AppVariables }>();

/** The NHI agent of the request, or `null` (a person, a legacy key, nobody). */
function sessionAgent(c: Context): AgentAuthContext | null {
  const agent = (c.get as (k: string) => unknown)("agent") as AgentAuthContext | undefined;
  if (!agent?.agentId || agent.agentId.startsWith("machine-")) return null;
  // The synthetic identity of an action's sandbox (`action:<id>`) has no row.
  if (agent.agentId.startsWith("action:")) return null;
  return agent;
}

agentDecisionsRoutes.use("*", async (c, next) => {
  if (sessionAgent(c)) return next();
  const user = (c.get as (k: string) => unknown)("user");
  return c.json(
    {
      error: user ? "Forbidden" : "Unauthorized",
      message:
        "Only an agent records its own decisions. People read them in the panel (GET /api/v1/agent-decisions).",
    },
    user ? 403 : 401
  );
});

agentDecisionsRoutes.post("/", async (c) => {
  const agent = sessionAgent(c)!;
  const body = await c.req.json().catch(() => undefined);
  let input;
  try {
    input = parseDecision(body);
  } catch (err) {
    if (err instanceof InvalidDecision) {
      return c.json({ error: "Validation failed", message: err.message }, 422);
    }
    throw err;
  }
  try {
    const row = await recordDecision(agent.agentId, input, "rest");
    return c.json(decisionView(row), 201);
  } catch (err) {
    logger.error({ err, agentId: agent.agentId }, "[decisions] could not record");
    return c.json({ error: "Could not record the decision" }, 500);
  }
});

agentDecisionsRoutes.get("/", async (c) => {
  const agent = sessionAgent(c)!;
  const n = (k: string) => {
    const v = Number(c.req.query(k));
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
  };
  const days = n("days");
  const { total, decisions } = await listDecisions({
    agentId: agent.agentId,
    days: days && days <= 365 ? days : undefined,
    limit: n("limit"),
    offset: n("offset"),
  });
  return c.json({
    total,
    decisions: decisions.map(({ agentId: _a, agentName: _n, ...d }) => d),
  });
});
