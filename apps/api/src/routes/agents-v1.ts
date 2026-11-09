/**
 * @file agents-v1.ts
 * @description API v1 routes for Agents (frontend compatibility)
 *
 * Routes:
 * - GET /api/v1/agents -> delegates to agents router
 * - GET /api/v1/traces -> list all traces
 * - GET /api/v1/identities -> alias for agents list
 * - GET /api/v1/agents/:id/versions -> history of the agent's definition
 * - GET /api/v1/agents/:id/versions/:version -> one version, complete
 * - POST /api/v1/agents/:id/versions/:version/restore -> back to that definition
 *   (lib/agent-versions.ts; a person only, like every agent write)
 */

import { normalizeScopes } from "@kitsuden/shared";
import { desc, eq, sql, and } from "drizzle-orm";
import { Hono, type Context } from "hono";

import { db } from "../db";
import { agentIdentities, agentApiKeys, agentTraces, agentTraceSteps } from "../db/schema";
import {
  agentVersion,
  listAgentVersions,
  restoreAgentVersion,
  snapshotAgent,
} from "../lib/agent-versions";
import { logger } from "../lib/logger";
import { requireAuth } from "../middleware/auth";
import { noAgentsInAgentManagement } from "../middleware/auth-guard";
import type { AppVariables } from "../types/hono";

// CHAINED (Hono RPC): a single expression so that typeof agentsV1Router
// accumulates the types of the 15 endpoints.
const agentsV1Router = new Hono<{ Variables: AppVariables }>()

  // Apply authentication middleware to all routes
  .use("*", requireAuth)

  // Managing agents (create, edit, delete, tokens, playground) and identities:
  // people only, whatever scopes the agent carries.
  .use("/agents", noAgentsInAgentManagement)
  .use("/agents/*", noAgentsInAgentManagement)
  .use("/identities", noAgentsInAgentManagement)
  .use("/identities/*", noAgentsInAgentManagement)

  // ═══════════════════════════════════════════════════════════════════════════
  // AGENTS CRUD (for /api/v1/agents)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/v1/agents
   * List all agents
   */
  .get("/agents", async (c) => {
    try {
      const agents = await db
        .select({
          id: agentIdentities.id,
          name: agentIdentities.name,
          description: agentIdentities.description,
          type: agentIdentities.type,
          capabilities: agentIdentities.capabilities,
          systemPrompt: agentIdentities.systemPrompt,
          allowedTools: agentIdentities.allowedTools,
          scopes: agentIdentities.scopes,
          rateLimit: agentIdentities.rateLimit,
          isActive: agentIdentities.isActive,
          createdAt: agentIdentities.createdAt,
          updatedAt: agentIdentities.updatedAt,
        })
        .from(agentIdentities)
        .orderBy(desc(agentIdentities.createdAt));

      return c.json(agents);
    } catch (error) {
      logger.error({ error }, "Failed to list agents");
      return c.json({ error: "Failed to list agents" }, 500);
    }
  })

  /**
   * POST /api/v1/agents
   * Create a new agent
   */
  .post("/agents", async (c) => {
    try {
      const body = await c.req.json();
      const { name, description, model, enabled, scopes } = body;

      if (!name) {
        return c.json({ error: "Name is required" }, 400);
      }

      // Without scopes, only connecting: the panel's agent could not use any tool.
      // Same validation as POST /api/admin/agents.
      let validScopes: string[];
      try {
        validScopes = normalizeScopes(scopes ?? ["mcp:connect"]);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }

      // Import generateAgentApiKey
      const { agentKeyExpiresAt, generateAgentApiKey } = await import("../services/agent-auth");
      const { plainKey, keyHash, keyPrefix, keyId, algorithm } =
        await generateAgentApiKey("custom");

      const [agent] = await db
        .insert(agentIdentities)
        .values({
          name,
          description: description || null,
          systemPrompt: `Model: ${model || "gpt-4"}`,
          type: "custom",
          scopes: validScopes,
          rateLimit: 60,
          isActive: enabled !== false,
        })
        .returning();
      await snapshotAgent(agent.id, { createdBy: userId(c), source: "create" });

      // Create API key
      // keyId and algorithm: without them authenticateAgent (which looks up by keyId) never
      // found the key and the returned token always gave 401
      await db.insert(agentApiKeys).values({
        agentId: agent.id,
        keyId,
        keyHash,
        keyPrefix,
        algorithm,
        // The default expiry (AGENT_KEY_DEFAULT_EXPIRY_DAYS, 90 days)
        expiresAt: agentKeyExpiresAt(undefined),
      });

      return c.json({ agent, token: plainKey }, 201);
    } catch (error) {
      logger.error({ error }, "Failed to create agent");
      return c.json({ error: "Failed to create agent" }, 500);
    }
  })

  /**
   * GET /api/v1/agents/:id
   * Get a specific agent
   */
  .get("/agents/:id", async (c) => {
    try {
      const id = c.req.param("id");

      const [agent] = await db
        .select()
        .from(agentIdentities)
        .where(eq(agentIdentities.id, id))
        .limit(1);

      if (!agent) {
        return c.json({ error: "Agent not found" }, 404);
      }

      return c.json(agent);
    } catch (error) {
      logger.error({ error, agentId: c.req.param("id") }, "Failed to get agent");
      return c.json({ error: "Failed to get agent" }, 500);
    }
  })

  /**
   * PATCH /api/v1/agents/:id
   * Update an agent
   */
  .patch("/agents/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const body = await c.req.json();

      const [existing] = await db
        .select()
        .from(agentIdentities)
        .where(eq(agentIdentities.id, id))
        .limit(1);

      if (!existing) {
        return c.json({ error: "Agent not found" }, 404);
      }

      let changes: Record<string, unknown>;
      try {
        changes = agentChanges(body);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }

      const [updated] = await db
        .update(agentIdentities)
        .set({
          ...changes,
          updatedAt: new Date(),
        })
        .where(eq(agentIdentities.id, id))
        .returning();
      // A new version only if the definition changed (lib/agent-versions.ts).
      await snapshotAgent(id, { createdBy: userId(c), source: "update" });

      return c.json(updated);
    } catch (error) {
      logger.error({ error, agentId: c.req.param("id") }, "Failed to update agent");
      return c.json({ error: "Failed to update agent" }, 500);
    }
  })

  /**
   * DELETE /api/v1/agents/:id
   * Delete an agent
   */
  .delete("/agents/:id", async (c) => {
    try {
      const id = c.req.param("id");

      const [existing] = await db
        .select()
        .from(agentIdentities)
        .where(eq(agentIdentities.id, id))
        .limit(1);

      if (!existing) {
        return c.json({ error: "Agent not found" }, 404);
      }

      await db.delete(agentIdentities).where(eq(agentIdentities.id, id));

      return c.json({ success: true });
    } catch (error) {
      logger.error({ error, agentId: c.req.param("id") }, "Failed to delete agent");
      return c.json({ error: "Failed to delete agent" }, 500);
    }
  })

  /**
   * POST /api/v1/agents/:id/token
   * Regenerate token for an agent
   */
  .post("/agents/:id/token", async (c) => {
    try {
      const id = c.req.param("id");

      const [agent] = await db
        .select()
        .from(agentIdentities)
        .where(eq(agentIdentities.id, id))
        .limit(1);

      if (!agent) {
        return c.json({ error: "Agent not found" }, 404);
      }

      const { agentKeyExpiresAt, generateAgentApiKey } = await import("../services/agent-auth");
      const { plainKey, keyHash, keyPrefix, keyId, algorithm } = await generateAgentApiKey(
        agent.type || "custom"
      );

      await db.insert(agentApiKeys).values({
        agentId: id,
        keyId,
        keyHash,
        keyPrefix,
        algorithm,
        expiresAt: agentKeyExpiresAt(undefined),
      });

      return c.json({ token: plainKey });
    } catch (error) {
      logger.error({ error, agentId: c.req.param("id") }, "Failed to regenerate token");
      return c.json({ error: "Failed to regenerate token" }, 500);
    }
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // TRACES (for /api/v1/traces)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/v1/traces
   * List all traces with optional filtering
   */
  .get("/traces", async (c) => {
    try {
      const agentId = c.req.query("agentId");
      const sessionId = c.req.query("sessionId");
      const limit = parseInt(c.req.query("limit") || "50");
      const offset = parseInt(c.req.query("offset") || "0");

      // Build query with filters applied before order/limit
      const conditions = [];
      if (agentId) {
        conditions.push(eq(agentTraces.agentId, agentId));
      }
      if (sessionId) {
        conditions.push(eq(agentTraces.sessionId, sessionId));
      }
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const traces = await db
        .select({
          id: agentTraces.id,
          agentId: agentTraces.agentId,
          sessionId: agentTraces.sessionId,
          input: agentTraces.input,
          output: agentTraces.output,
          totalDurationMs: agentTraces.totalDurationMs,
          tokensIn: agentTraces.tokensIn,
          tokensOut: agentTraces.tokensOut,
          status: agentTraces.status,
          createdAt: agentTraces.createdAt,
        })
        .from(agentTraces)
        .where(whereClause)
        .orderBy(desc(agentTraces.createdAt))
        .limit(limit)
        .offset(offset);

      // Get total count
      const countResult = await db
        .select({ value: sql<number>`count(*)` })
        .from(agentTraces)
        .where(whereClause);
      const total = countResult[0]?.value ?? 0;

      return c.json({
        traces,
        total,
      });
    } catch (error) {
      logger.error({ error }, "Failed to list traces");
      return c.json({ error: "Failed to list traces" }, 500);
    }
  })

  /**
   * GET /api/v1/traces/:id
   * Get a specific trace with steps
   */
  .get("/traces/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const expand = c.req.query("expand");

      const [trace] = await db.select().from(agentTraces).where(eq(agentTraces.id, id)).limit(1);

      if (!trace) {
        return c.json({ error: "Trace not found" }, 404);
      }

      const result: any = { ...trace };

      // Include steps if requested
      if (expand === "steps") {
        const steps = await db
          .select()
          .from(agentTraceSteps)
          .where(eq(agentTraceSteps.traceId, id))
          .orderBy(agentTraceSteps.stepOrder);
        result.steps = steps;
      }

      return c.json(result);
    } catch (error) {
      logger.error({ error, traceId: c.req.param("id") }, "Failed to get trace");
      return c.json({ error: "Failed to get trace" }, 500);
    }
  })

  /**
   * GET /api/v1/traces/:id/steps
   * Get steps for a specific trace
   */
  .get("/traces/:id/steps", async (c) => {
    try {
      const traceId = c.req.param("id");

      const steps = await db
        .select()
        .from(agentTraceSteps)
        .where(eq(agentTraceSteps.traceId, traceId))
        .orderBy(agentTraceSteps.stepOrder);

      return c.json(steps);
    } catch (error) {
      logger.error({ error, traceId: c.req.param("id") }, "Failed to get trace steps");
      return c.json({ error: "Failed to get trace steps" }, 500);
    }
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // IDENTITIES (alias for agents)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/v1/identities
   * List all agent identities
   */
  .get("/identities", async (c) => {
    try {
      const identities = await db
        .select({
          id: agentIdentities.id,
          name: agentIdentities.name,
          description: agentIdentities.description,
          type: agentIdentities.type,
          capabilities: agentIdentities.capabilities,
          systemPrompt: agentIdentities.systemPrompt,
          allowedTools: agentIdentities.allowedTools,
          scopes: agentIdentities.scopes,
          rateLimit: agentIdentities.rateLimit,
          isActive: agentIdentities.isActive,
          createdAt: agentIdentities.createdAt,
          updatedAt: agentIdentities.updatedAt,
        })
        .from(agentIdentities)
        .orderBy(desc(agentIdentities.createdAt));

      return c.json(identities);
    } catch (error) {
      logger.error({ error }, "Failed to list identities");
      return c.json({ error: "Failed to list identities" }, 500);
    }
  })

  /**
   * POST /api/v1/identities
   * Create a new identity
   */
  .post("/identities", async (c) => {
    try {
      const body = await c.req.json();
      const { name, description, systemPrompt } = body;

      if (!name) {
        return c.json({ error: "Name is required" }, 400);
      }

      const [identity] = await db
        .insert(agentIdentities)
        .values({
          name,
          description: description || null,
          systemPrompt: systemPrompt || null,
          type: "custom",
          scopes: ["mcp:connect"],
          rateLimit: 60,
          isActive: true,
        })
        .returning();
      await snapshotAgent(identity.id, { createdBy: userId(c), source: "create" });

      return c.json(identity, 201);
    } catch (error) {
      logger.error({ error }, "Failed to create identity");
      return c.json({ error: "Failed to create identity" }, 500);
    }
  })

  /**
   * GET /api/v1/identities/:id
   * Get a specific identity
   */
  .get("/identities/:id", async (c) => {
    try {
      const id = c.req.param("id");

      const [identity] = await db
        .select()
        .from(agentIdentities)
        .where(eq(agentIdentities.id, id))
        .limit(1);

      if (!identity) {
        return c.json({ error: "Identity not found" }, 404);
      }

      return c.json(identity);
    } catch (error) {
      logger.error({ error, identityId: c.req.param("id") }, "Failed to get identity");
      return c.json({ error: "Failed to get identity" }, 500);
    }
  })

  /**
   * PATCH /api/v1/identities/:id
   * Update an identity
   */
  .patch("/identities/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const body = await c.req.json();

      const [existing] = await db
        .select()
        .from(agentIdentities)
        .where(eq(agentIdentities.id, id))
        .limit(1);

      if (!existing) {
        return c.json({ error: "Identity not found" }, 404);
      }

      let changes: Record<string, unknown>;
      try {
        changes = agentChanges(body);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }

      const [updated] = await db
        .update(agentIdentities)
        .set({
          ...changes,
          updatedAt: new Date(),
        })
        .where(eq(agentIdentities.id, id))
        .returning();
      await snapshotAgent(id, { createdBy: userId(c), source: "update" });

      return c.json(updated);
    } catch (error) {
      logger.error({ error, identityId: c.req.param("id") }, "Failed to update identity");
      return c.json({ error: "Failed to update identity" }, 500);
    }
  })

  /**
   * DELETE /api/v1/identities/:id
   * Delete an identity
   */
  .delete("/identities/:id", async (c) => {
    try {
      const id = c.req.param("id");

      const [existing] = await db
        .select()
        .from(agentIdentities)
        .where(eq(agentIdentities.id, id))
        .limit(1);

      if (!existing) {
        return c.json({ error: "Identity not found" }, 404);
      }

      await db.delete(agentIdentities).where(eq(agentIdentities.id, id));

      return c.json({ success: true });
    } catch (error) {
      logger.error({ error, identityId: c.req.param("id") }, "Failed to delete identity");
      return c.json({ error: "Failed to delete identity" }, 500);
    }
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AGENT PLAYGROUND (POST /api/v1/agents/:id/playground)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/v1/agents/:id/playground
   * Send a message to an agent in playground mode
   * Maps to the internal /api/admin/agents/:id/chat implementation
   */
  .post("/agents/:id/playground", async (c) => {
    try {
      const agentId = c.req.param("id");
      const body = await c.req.json();
      const { messages } = body;

      // Check if agent exists
      const [agent] = await db
        .select()
        .from(agentIdentities)
        .where(eq(agentIdentities.id, agentId))
        .limit(1);

      if (!agent) {
        return c.json({ error: "Agent not found" }, 404);
      }

      if (!agent.isActive) {
        return c.json({ error: "Agent is inactive" }, 400);
      }

      // Get the last user message
      const lastMessage = messages?.[messages.length - 1];
      const message = lastMessage?.content || "";
      const history = messages?.slice(0, -1) || [];

      // Create trace for this conversation
      const [trace] = await db
        .insert(agentTraces)
        .values({
          agentId,
          sessionId: crypto.randomUUID(),
          name: `Playground: ${message.slice(0, 50)}...`,
          input: { message, history },
          status: "running",
        })
        .returning({ id: agentTraces.id });

      // Add user_input step
      await db.insert(agentTraceSteps).values({
        traceId: trace.id,
        stepOrder: 0,
        stepType: "user_input",
        content: message,
      });

      // Process with agent (simulated for now)
      const startTime = Date.now();
      const response = await processWithAgent(agent, message, history, trace.id);
      const durationMs = Date.now() - startTime;

      // Add response step
      await db.insert(agentTraceSteps).values({
        traceId: trace.id,
        stepOrder: 1,
        stepType: "llm_call",
        content: response,
        durationMs,
      });

      // Complete trace
      await db
        .update(agentTraces)
        .set({
          output: { response },
          status: "success",
          totalDurationMs: durationMs,
          tokensIn: message.length / 4, // Approximate
          tokensOut: response.length / 4, // Approximate
        })
        .where(eq(agentTraces.id, trace.id));

      logger.info({ agentId, traceId: trace.id, durationMs }, "Agent playground completed");

      return c.json({
        message: response,
        traceId: trace.id,
        metadata: {
          tokensIn: Math.ceil(message.length / 4),
          tokensOut: Math.ceil(response.length / 4),
          duration: durationMs,
          toolCalls: [],
        },
      });
    } catch (error) {
      logger.error({ error, agentId: c.req.param("id") }, "Failed to execute playground");
      return c.json({ error: "Failed to execute playground" }, 500);
    }
  });

/**
 * Process a message with the agent
 * Simulated response for now
 */
async function processWithAgent(
  agent: typeof agentIdentities.$inferSelect,
  message: string,
  _history: Array<{ role: string; content: string }>,
  _traceId: string
): Promise<string> {
  const lowerMsg = message.toLowerCase();

  if (lowerMsg.includes("hi") || lowerMsg.includes("hello")) {
    return `Hello! I am ${agent.name}, your virtual assistant.${agent.description || "I am here to help you."}`;
  }

  if (lowerMsg.includes("help")) {
    return `I can help you with various tasks.${agent.systemPrompt || "I am a general-purpose agent."}`;
  }

  if (lowerMsg.includes("capabilities") || lowerMsg.includes("what can you do")) {
    const capabilities = agent.capabilities as string[] | undefined;
    return capabilities?.length
      ? `My capabilities include: ${capabilities.join(", ")}.`
      : "I have general assistance capabilities.";
  }

  return `I understand: "${message}". As ${agent.name}, I am processing your request. (This is a simulated response - in production it would connect to a real LLM)`;
}

export const agentsV1Routes = agentsV1Router;

/** Accumulated type of the router - consumed by src/rpc.ts */
export type AgentsV1RoutesType = typeof agentsV1Router;

export default agentsV1Router;

/** Who is making the request (a person: agents cannot write agents, see index.ts). */
function userId(c: { get(key: "user"): unknown }): string | null {
  const u = c.get("user") as { id?: string } | null | undefined;
  return typeof u?.id === "string" ? u.id : null;
}

/**
 * What an agent PATCH can change. It used to be `.set({ ...body })`: any column could be
 * written (id, dates) and scopes could be slipped in unvalidated.
 * Scopes, keys and quotas have their routes in routes/agent-permissions.ts;
 * here scopes are accepted only validated.
 */
function agentChanges(body: unknown): Record<string, unknown> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const changes: Record<string, unknown> = {};
  for (const k of [
    "name",
    "description",
    "systemPrompt",
    "type",
    "isActive",
    "capabilities",
    "allowedTools",
  ]) {
    if (b[k] !== undefined) changes[k] = b[k];
  }
  if (b.enabled !== undefined && b.isActive === undefined) changes.isActive = b.enabled !== false;
  if (b.scopes !== undefined) changes.scopes = normalizeScopes(b.scopes);
  return changes;
}

// ── Versions (lib/agent-versions.ts) ──────────────────────────────────────────
// Declared as SDK operations in routes/agent-permissions.ts (kon-agents); the
// handlers live here, next to the rest of the agent routes.

/** GET /api/v1/agents/:id/versions: the agent's definitions, newest first (without the prompt text). */
export async function listAgentVersionsHandler(c: Context): Promise<Response> {
  try {
    const id = c.req.param("id") ?? "";
    const [agent] = await db
      .select({ id: agentIdentities.id })
      .from(agentIdentities)
      .where(eq(agentIdentities.id, id))
      .limit(1);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    // An agent created before migration 0066 ran, or by a path that did not
    // snapshot it, gets its first version now.
    await snapshotAgent(id, { createdBy: null, source: "detected" });
    const limit = Number(c.req.query("limit") ?? 100);
    const versions = await listAgentVersions(id, Number.isFinite(limit) ? limit : 100);
    return c.json({ agentId: id, current: versions[0]?.version ?? null, versions });
  } catch (error) {
    logger.error({ error, agentId: c.req.param("id") ?? "" }, "Failed to list agent versions");
    return c.json({ error: "Failed to list agent versions" }, 500);
  }
}

/** GET /api/v1/agents/:id/versions/:version: one version with its system prompt and configuration. */
export async function getAgentVersionHandler(c: Context): Promise<Response> {
  try {
    const v = await agentVersion(c.req.param("id") ?? "", Number(c.req.param("version") ?? ""));
    if (!v) return c.json({ error: "Version not found" }, 404);
    return c.json(v);
  } catch (error) {
    logger.error({ error, agentId: c.req.param("id") ?? "" }, "Failed to get agent version");
    return c.json({ error: "Failed to get agent version" }, 500);
  }
}

/** POST /api/v1/agents/:id/versions/:version/restore: writes that version's definition back, as a new version. */
export async function restoreAgentVersionHandler(c: Context): Promise<Response> {
  try {
    const who = userId(c);
    if (!who) return c.json({ error: "Unauthorized" }, 401);
    const r = await restoreAgentVersion(
      c.req.param("id") ?? "",
      Number(c.req.param("version") ?? ""),
      who
    );
    if (!r) return c.json({ error: "Version not found" }, 404);
    return c.json({ restored: r.restored.version, current: r.current });
  } catch (error) {
    logger.error({ error, agentId: c.req.param("id") ?? "" }, "Failed to restore agent version");
    return c.json({ error: "Failed to restore agent version" }, 500);
  }
}
