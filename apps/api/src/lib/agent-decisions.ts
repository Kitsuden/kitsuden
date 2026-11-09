/**
 * What an agent chose NOT to do, and why
 * ============================================================================
 *
 * The panel showed what a human rejected (proposals) and where an agent got
 * stuck (friction), but not the agent's own choices: an action it considered
 * and discarded left no trace. The agent records them itself:
 *
 *   MCP   `kitsuden_record_decision` { action, reason, alternatives?, context? }
 *   REST  POST /api/agent/decisions  (same body); GET lists its own
 *
 * Rules:
 *   · the row belongs to the agent of the SESSION, never to one named in the
 *     body; an agent reads only its own (another's does not exist for it);
 *   · admins read all of them (`GET /api/v1/agent-decisions`, the panel's
 *     "Discarded" tab next to the approvals inbox); editors read those of
 *     the agents whose proposals they may decide, so not the ones they sponsor;
 *   · nobody edits a decision: it is a record, like the audit log;
 *   · it is never held for approval and costs no write quota: recording that
 *     you did NOT act must always be possible, it is what an unattended run is
 *     told to do instead of a held write (DEFAULT_UNATTENDED_ALTERNATIVE).
 *
 * The version of the agent that decided (migration 0066) is stored with it.
 * Table: migration 0067. Guide: docs/agents/decisions.md.
 */

import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm";

import { db } from "../db";
import { agentDecisions, agentIdentities, agentTraces } from "../db/schema";

import { snapshotAgent } from "./agent-versions";
import { containsSecret } from "./idempotency";

export type AgentDecision = typeof agentDecisions.$inferSelect;
export type DecisionChannel = "rest" | "mcp" | "engine";

export const DECISION_LIMITS = {
  action: 500,
  reason: 4000,
  alternatives: 10,
  alternative: 500,
  contextBytes: 16 * 1024,
} as const;

export interface DecisionInput {
  action: string;
  reason: string;
  alternatives: string[];
  context: Record<string, unknown>;
  traceId: string | null;
}

/** Thrown with the reason a body is not a decision (the routes answer 422). */
export class InvalidDecision extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(v: unknown, field: string, max: number): string {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new InvalidDecision(`${field} is required (a non-empty text)`);
  }
  const t = v.trim();
  if (t.length > max) throw new InvalidDecision(`${field} is at most ${max} characters`);
  return t;
}

/** Validates and normalizes a decision body (REST and MCP share it). */
export function parseDecision(body: unknown): DecisionInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new InvalidDecision("the body is an object { action, reason, alternatives?, context? }");
  }
  const b = body as Record<string, unknown>;
  const known = new Set(["action", "reason", "alternatives", "context", "traceId", "trace_id"]);
  const unknown = Object.keys(b).filter((k) => !known.has(k));
  if (unknown.length) throw new InvalidDecision(`unknown fields: ${unknown.join(", ")}`);

  const action = text(b.action, "action", DECISION_LIMITS.action);
  const reason = text(b.reason, "reason", DECISION_LIMITS.reason);

  let alternatives: string[] = [];
  if (b.alternatives !== undefined && b.alternatives !== null) {
    if (!Array.isArray(b.alternatives))
      throw new InvalidDecision("alternatives is a list of texts");
    if (b.alternatives.length > DECISION_LIMITS.alternatives) {
      throw new InvalidDecision(`at most ${DECISION_LIMITS.alternatives} alternatives`);
    }
    alternatives = b.alternatives.map((a, i) =>
      text(a, `alternatives[${i}]`, DECISION_LIMITS.alternative)
    );
  }

  let context: Record<string, unknown> = {};
  if (b.context !== undefined && b.context !== null) {
    if (typeof b.context !== "object" || Array.isArray(b.context)) {
      throw new InvalidDecision("context is an object");
    }
    context = b.context as Record<string, unknown>;
    if (JSON.stringify(context).length > DECISION_LIMITS.contextBytes) {
      throw new InvalidDecision(`context is at most ${DECISION_LIMITS.contextBytes} bytes of JSON`);
    }
  }

  // A decision is read by people: it must never become a place to leave a key.
  if (containsSecret({ action, reason, alternatives, context })) {
    throw new InvalidDecision("a decision cannot carry a secret (a token, password or key)");
  }

  const rawTrace = b.traceId ?? b.trace_id;
  let traceId: string | null = null;
  if (rawTrace !== undefined && rawTrace !== null) {
    if (typeof rawTrace !== "string" || !UUID.test(rawTrace)) {
      throw new InvalidDecision("traceId is a uuid");
    }
    traceId = rawTrace;
  }
  return { action, reason, alternatives, context, traceId };
}

/** Stores a decision of `agentId` (the session's agent). */
export async function recordDecision(
  agentId: string,
  input: DecisionInput,
  channel: DecisionChannel
): Promise<AgentDecision> {
  // A trace of ANOTHER agent is not linked (it would not exist for this one).
  let traceId: string | null = null;
  if (input.traceId) {
    const [t] = await db
      .select({ id: agentTraces.id })
      .from(agentTraces)
      .where(and(eq(agentTraces.id, input.traceId), eq(agentTraces.agentId, agentId)))
      .limit(1);
    traceId = t?.id ?? null;
  }
  // The version that decided: the current one (a snapshot if it changed or never had one).
  const versionId = await snapshotAgent(agentId, { createdBy: null, source: "detected" });
  const [row] = await db
    .insert(agentDecisions)
    .values({
      agentId,
      agentVersionId: versionId,
      traceId,
      channel,
      action: input.action,
      reason: input.reason,
      alternatives: input.alternatives,
      context: input.context,
    })
    .returning();
  if (!row) throw new Error("Could not store the decision");
  return row;
}

export interface DecisionFilter {
  agentId?: string | null;
  days?: number;
  limit?: number;
  offset?: number;
  /**
   * Leave out the agents this person sponsors (an editor reads what they may
   * decide: lib/approvals.ts, `own_agent`). NULL = every agent (an admin).
   */
  notSponsoredBy?: string | null;
}

/** Decisions, newest first, with the agent's name and version number. */
export async function listDecisions(f: DecisionFilter) {
  const conditions: SQL[] = [];
  if (f.agentId) conditions.push(eq(agentDecisions.agentId, f.agentId));
  if (f.notSponsoredBy)
    conditions.push(
      sql`NOT EXISTS (SELECT 1 FROM agent_identities s WHERE s.id = ${agentDecisions.agentId} AND s.sponsor_user_id = ${f.notSponsoredBy})`
    );
  if (f.days)
    conditions.push(gte(agentDecisions.createdAt, new Date(Date.now() - f.days * 86_400_000)));
  const where = conditions.length ? and(...conditions) : undefined;
  const rows = await db
    .select({
      id: agentDecisions.id,
      agentId: agentDecisions.agentId,
      agentName: agentIdentities.name,
      agentVersionId: agentDecisions.agentVersionId,
      version: sql<
        number | null
      >`(SELECT v.version FROM agent_versions v WHERE v.id = ${agentDecisions.agentVersionId})`,
      traceId: agentDecisions.traceId,
      channel: agentDecisions.channel,
      action: agentDecisions.action,
      reason: agentDecisions.reason,
      alternatives: agentDecisions.alternatives,
      context: agentDecisions.context,
      createdAt: agentDecisions.createdAt,
    })
    .from(agentDecisions)
    .leftJoin(agentIdentities, eq(agentIdentities.id, agentDecisions.agentId))
    .where(where)
    .orderBy(desc(agentDecisions.createdAt))
    .limit(Math.min(Math.max(f.limit ?? 50, 1), 200))
    .offset(Math.max(f.offset ?? 0, 0));
  const [total] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentDecisions)
    .where(where);
  return { total: total?.n ?? 0, decisions: rows };
}

/** What the agent sees of its own decision. */
export function decisionView(d: AgentDecision) {
  return {
    id: d.id,
    action: d.action,
    reason: d.reason,
    alternatives: d.alternatives,
    context: d.context,
    traceId: d.traceId,
    agentVersionId: d.agentVersionId,
    channel: d.channel,
    createdAt: d.createdAt,
  };
}

// ── MCP ─────────────────────────────────────────────────────────────────────

export const DECISION_TOOL = "kitsuden_record_decision";

export const DECISION_TOOL_DEFINITION = {
  name: DECISION_TOOL,
  description:
    "Record something you chose NOT to do, and why, so the people who oversee you can see it. Use it when you discard an action (it looked risky, it needs a person, the data was unclear) and when a request was refused with KITSUDEN_E_DENIED_UNATTENDED. It changes nothing else, is never held for approval and is visible to admins only.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "What you did not do, concretely (e.g. 'refund order 1042').",
        maxLength: DECISION_LIMITS.action,
      },
      reason: {
        type: "string",
        description: "Why you did not do it.",
        maxLength: DECISION_LIMITS.reason,
      },
      alternatives: {
        type: "array",
        items: { type: "string", maxLength: DECISION_LIMITS.alternative },
        maxItems: DECISION_LIMITS.alternatives,
        description: "What you did instead, or suggest a person does.",
      },
      context: {
        type: "object",
        description: "Ids, links or data a reviewer needs (no secrets), at most 16 KiB.",
      },
      trace_id: { type: "string", description: "Your current trace id, if you know it." },
    },
    required: ["action", "reason"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};
