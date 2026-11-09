/**
 * @file agents.ts
 * @description Admin routes for managing AI Agent Identities (NHI)
 *
 * REST API endpoints for:
 * - Creating/updating/deleting agent identities
 * - Managing API keys
 * - Viewing audit logs
 * - Statistics and monitoring
 */

import { normalizeScopes } from "@kitsuden/shared";
import { eq, desc, count, and, gte, inArray } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "@/db";
import {
  agentIdentities,
  agentApiKeys,
  agentAuditLogs,
  agentTraces,
  agentTraceSteps,
} from "@/db/schema";
import { snapshotAgent } from "@/lib/agent-versions";
import { logger } from "@/lib/logger";
import { agentKeyExpiresAt, generateAgentApiKey } from "@/services/agent-auth";

import { requireAuth } from "../middleware/auth";
import { noAgentsInAgentManagement } from "../middleware/auth-guard";
import type { AppVariables } from "../types/hono";

const agentsRouter = new Hono<{ Variables: AppVariables }>();

// Apply authentication middleware to all routes
agentsRouter.use("*", requireAuth);
// Creating, editing, deleting agents and minting their keys: people only.
agentsRouter.use("*", noAgentsInAgentManagement);

/** The person making the request (agents cannot write agents: index.ts). */
function sessionUserId(c: { get(key: "user"): unknown }): string | null {
  const u = c.get("user") as { id?: string } | null | undefined;
  return typeof u?.id === "string" ? u.id : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// AGENT CRUD
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/admin/agents
 * Create a new agent identity with Persona configuration
 */
agentsRouter.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const {
      name,
      description,
      type,
      capabilities,
      systemPrompt,
      allowedTools,
      scopes,
      rateLimit,
      expiresInDays,
      isActive,
    } = body;

    if (!name) {
      return c.json({ success: false, error: "Name is required" }, 400);
    }

    // Validate type
    const agentType = type || "custom";
    const validTypes = [
      "claude-desktop",
      "claude-web",
      "scraper",
      "worker",
      "webhook",
      "mcp-server",
      "custom",
    ];
    if (!validTypes.includes(agentType)) {
      return c.json(
        {
          success: false,
          error: `Invalid type. Must be one of: ${validTypes.join(", ")}`,
        },
        400
      );
    }

    // Validate scopes: broad, fine-grained (`kon:<kon>:<op>`, `datasets:<slug>:<action>`)
    // and denials (`!pattern`). Before, a `^[a-z]+:[a-z*]+$` filter SILENTLY
    // dropped everything fine-grained: a scope that is not valid is a 400, not a gap.
    let validScopes: string[];
    try {
      validScopes = normalizeScopes(scopes ?? ["mcp:connect"]);
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 400);
    }

    // Validate capabilities (if provided)
    const validCapabilities = (capabilities || []).filter(
      (c: string) => typeof c === "string" && c.length > 0
    );

    // Validate allowedTools (if provided)
    const validAllowedTools = (allowedTools || []).filter(
      (t: string) => typeof t === "string" && t.length > 0
    );

    // Generate first API key WITH TYPE
    const { plainKey, keyHash, keyPrefix, keyId, algorithm } = await generateAgentApiKey(agentType);

    // Create agent identity with new Persona fields
    const [agent] = await db
      .insert(agentIdentities)
      .values({
        name,
        description: description || null,
        type: agentType,
        capabilities: validCapabilities,
        systemPrompt: systemPrompt || null,
        allowedTools: validAllowedTools,
        scopes: validScopes,
        rateLimit: rateLimit || 60,
        isActive: isActive !== false,
      })
      .returning();
    await snapshotAgent(agent.id, { createdBy: sessionUserId(c), source: "create" });

    // Omitted: the default expiry (90 days); `null` or `0`: never, on purpose.
    const expiresAt = agentKeyExpiresAt(expiresInDays);

    // `keyId` and `algorithm` are what `authenticateAgent` uses to find
    // and verify the key. Without them (as it was stored here) the key came out
    // of the panel and NEVER authenticated (2026-10-15). Same as createAgent().
    await db.insert(agentApiKeys).values({
      agentId: agent.id,
      keyId,
      keyHash,
      keyPrefix,
      algorithm,
      expiresAt,
    });

    logger.info(
      {
        agentId: agent.id,
        name,
        type: agentType,
        capabilitiesCount: validCapabilities.length,
      },
      "Agent created with Persona"
    );

    return c.json(
      {
        success: true,
        data: {
          agent: {
            id: agent.id,
            name: agent.name,
            type: agent.type,
            description: agent.description,
            capabilities: agent.capabilities,
            systemPrompt: agent.systemPrompt,
            allowedTools: agent.allowedTools,
            scopes: agent.scopes,
            rateLimit: agent.rateLimit,
            isActive: agent.isActive,
            createdAt: agent.createdAt,
          },
          apiKey: plainKey, // Only shown once!
        },
      },
      201
    );
  } catch (error) {
    logger.error({ error }, "Failed to create agent");
    return c.json({ success: false, error: "Failed to create agent" }, 500);
  }
});

/**
 * GET /api/admin/agents
 * List all agent identities with their keys
 */
agentsRouter.get("/", async (c) => {
  try {
    const page = parseInt(c.req.query("page") || "1");
    const limit = parseInt(c.req.query("limit") || "20");
    const offset = (page - 1) * limit;

    // Get agents with pagination
    const agentsList = await db
      .select()
      .from(agentIdentities)
      .orderBy(desc(agentIdentities.createdAt))
      .limit(limit)
      .offset(offset);

    // Get keys for all agents
    const agentIds = agentsList.map((a: (typeof agentsList)[0]) => a.id);
    const keysList = agentIds.length
      ? await db
          .select()
          .from(agentApiKeys)
          // `inArray`, not `IN (${ids.join(",")})`: that sent ONE parameter
          // with all the ids glued together and the query matched none of them
          .where(inArray(agentApiKeys.agentId, agentIds))
      : [];

    // Group keys by agent
    const keysByAgent = keysList.reduce(
      (acc: Record<string, typeof keysList>, key: (typeof keysList)[0]) => {
        if (!acc[key.agentId]) acc[key.agentId] = [];
        acc[key.agentId].push(key);
        return acc;
      },
      {} as Record<string, typeof keysList>
    );

    const agentsWithKeys = agentsList.map((agent: (typeof agentsList)[0]) => ({
      ...agent,
      keys: keysByAgent[agent.id] || [],
    }));

    // Get total count
    const [{ count: total }] = await db.select({ count: count() }).from(agentIdentities);

    return c.json({
      success: true,
      data: agentsWithKeys,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error({ error }, "Failed to list agents");
    return c.json({ success: false, error: "Failed to list agents" }, 500);
  }
});

/**
 * GET /api/admin/agents/logs
 * Get all audit logs (for admin dashboard)
 */
agentsRouter.get("/logs", async (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "50");

    const logs = await db
      .select({
        id: agentAuditLogs.id,
        agentId: agentAuditLogs.agentId,
        action: agentAuditLogs.action,
        resource: agentAuditLogs.resource,
        success: agentAuditLogs.success,
        errorMessage: agentAuditLogs.errorMessage,
        ipAddress: agentAuditLogs.ipAddress,
        userAgent: agentAuditLogs.userAgent,
        createdAt: agentAuditLogs.createdAt,
      })
      .from(agentAuditLogs)
      .orderBy(desc(agentAuditLogs.createdAt))
      .limit(limit);

    return c.json(logs);
  } catch (error) {
    logger.error({ error }, "Failed to get agent logs");
    return c.json({ success: false, error: "Failed to get logs" }, 500);
  }
});

/**
 * GET /api/admin/agents/:id
 * Get agent details
 */
agentsRouter.get("/:id", async (c) => {
  try {
    const id = c.req.param("id");

    const [agent] = await db
      .select()
      .from(agentIdentities)
      .where(eq(agentIdentities.id, id))
      .limit(1);

    if (!agent) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    const keys = await db
      .select({
        id: agentApiKeys.id,
        keyPrefix: agentApiKeys.keyPrefix,
        createdAt: agentApiKeys.createdAt,
        lastUsedAt: agentApiKeys.lastUsedAt,
        expiresAt: agentApiKeys.expiresAt,
      })
      .from(agentApiKeys)
      .where(eq(agentApiKeys.agentId, id));

    return c.json({
      success: true,
      data: {
        ...agent,
        keys,
      },
    });
  } catch (error) {
    logger.error({ error, agentId: c.req.param("id") }, "Failed to get agent");
    return c.json({ success: false, error: "Failed to get agent" }, 500);
  }
});

/**
 * PUT /api/admin/agents/:id
 * Update agent identity (including Persona fields)
 */
agentsRouter.put("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json();
    const {
      name,
      description,
      type,
      capabilities,
      systemPrompt,
      allowedTools,
      scopes,
      rateLimit,
      isActive,
    } = body;

    const [agent] = await db
      .select()
      .from(agentIdentities)
      .where(eq(agentIdentities.id, id))
      .limit(1);

    if (!agent) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    // Validate scopes (see the creation): 400 instead of silently dropping the fine-grained ones.
    let validScopes: string[] | undefined;
    try {
      validScopes = scopes === undefined ? undefined : normalizeScopes(scopes);
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 400);
    }

    // Validate capabilities if provided
    const validCapabilities = capabilities?.filter(
      (c: string) => typeof c === "string" && c.length > 0
    );

    // Validate allowedTools if provided
    const validAllowedTools = allowedTools?.filter(
      (t: string) => typeof t === "string" && t.length > 0
    );

    // Validate type if provided
    const validTypes = [
      "claude-desktop",
      "claude-web",
      "scraper",
      "worker",
      "webhook",
      "mcp-server",
      "custom",
    ];
    const validType = type && validTypes.includes(type) ? type : undefined;

    const [updated] = await db
      .update(agentIdentities)
      .set({
        name: name ?? agent.name,
        description: description !== undefined ? description : agent.description,
        type: validType ?? agent.type,
        capabilities: validCapabilities ?? agent.capabilities,
        systemPrompt: systemPrompt !== undefined ? systemPrompt : agent.systemPrompt,
        allowedTools: validAllowedTools ?? agent.allowedTools,
        scopes: validScopes ?? agent.scopes,
        rateLimit: rateLimit ?? agent.rateLimit,
        isActive: isActive !== undefined ? isActive : agent.isActive,
        updatedAt: new Date(),
      })
      .where(eq(agentIdentities.id, id))
      .returning();
    // A new version only if the definition changed (lib/agent-versions.ts).
    await snapshotAgent(id, { createdBy: sessionUserId(c), source: "update" });

    logger.info({ agentId: id }, "Agent updated with Persona fields");

    return c.json({ success: true, data: updated });
  } catch (error) {
    logger.error({ error, agentId: c.req.param("id") }, "Failed to update agent");
    return c.json({ success: false, error: "Failed to update agent" }, 500);
  }
});

/**
 * DELETE /api/admin/agents/:id
 * Delete agent identity and all associated keys/logs
 */
agentsRouter.delete("/:id", async (c) => {
  try {
    const id = c.req.param("id");

    const [agent] = await db
      .select()
      .from(agentIdentities)
      .where(eq(agentIdentities.id, id))
      .limit(1);

    if (!agent) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    // Cascade delete happens via FK constraints
    await db.delete(agentIdentities).where(eq(agentIdentities.id, id));

    logger.info({ agentId: id, name: agent.name }, "Agent deleted");

    return c.json({ success: true });
  } catch (error) {
    logger.error({ error, agentId: c.req.param("id") }, "Failed to delete agent");
    return c.json({ success: false, error: "Failed to delete agent" }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// API KEY MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/admin/agents/:id/keys
 * Create a new API key for an agent
 */
agentsRouter.post("/:id/keys", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json();
    const { expiresInDays } = body;

    const [agent] = await db
      .select()
      .from(agentIdentities)
      .where(eq(agentIdentities.id, id))
      .limit(1);

    if (!agent) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    const { plainKey, keyHash, keyPrefix, keyId, algorithm } = await generateAgentApiKey(
      agent.type ?? undefined
    );

    const expiresAt = agentKeyExpiresAt(expiresInDays);

    const [key] = await db
      .insert(agentApiKeys)
      .values({
        agentId: id,
        keyId,
        keyHash,
        keyPrefix,
        algorithm,
        expiresAt,
      })
      .returning();

    logger.info({ agentId: id, keyId: key.id }, "API key created");

    return c.json(
      {
        success: true,
        data: {
          apiKey: plainKey, // Only shown once!
          keyId: key.id,
          prefix: keyPrefix,
          expiresAt,
        },
      },
      201
    );
  } catch (error) {
    logger.error({ error, agentId: c.req.param("id") }, "Failed to create API key");
    return c.json({ success: false, error: "Failed to create API key" }, 500);
  }
});

/**
 * DELETE /api/admin/agents/:id/keys/:keyId
 * Revoke an API key
 */
agentsRouter.delete("/:id/keys/:keyId", async (c) => {
  try {
    const { id: agentId, keyId } = c.req.param();

    const [key] = await db.select().from(agentApiKeys).where(eq(agentApiKeys.id, keyId)).limit(1);

    if (!key || key.agentId !== agentId) {
      return c.json({ success: false, error: "Key not found" }, 404);
    }

    // Revoking MARKS the key (it stops being valid on the next request) instead
    // of deleting it: the row stays for the audit.
    const u = c.get("user") as { id?: string } | null;
    await db
      .update(agentApiKeys)
      .set({ revokedAt: new Date(), revokedBy: u?.id ?? null })
      .where(eq(agentApiKeys.id, keyId));

    logger.info({ agentId, keyId }, "API key revoked");

    return c.json({ success: true });
  } catch (error) {
    logger.error(
      {
        error,
        agentId: c.req.param("id"),
        keyId: c.req.param("keyId"),
      },
      "Failed to revoke API key"
    );
    return c.json({ success: false, error: "Failed to revoke API key" }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDIT LOGS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/agents/:id/logs
 * Get audit logs for an agent
 */
agentsRouter.get("/:id/logs", async (c) => {
  try {
    const id = c.req.param("id");
    const limit = parseInt(c.req.query("limit") || "50");
    const offset = parseInt(c.req.query("offset") || "0");

    const [agent] = await db
      .select()
      .from(agentIdentities)
      .where(eq(agentIdentities.id, id))
      .limit(1);

    if (!agent) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    const logs = await db
      .select({
        id: agentAuditLogs.id,
        action: agentAuditLogs.action,
        resource: agentAuditLogs.resource,
        success: agentAuditLogs.success,
        durationMs: agentAuditLogs.durationMs,
        errorMessage: agentAuditLogs.errorMessage,
        details: agentAuditLogs.details,
        ipAddress: agentAuditLogs.ipAddress,
        createdAt: agentAuditLogs.createdAt,
      })
      .from(agentAuditLogs)
      .where(eq(agentAuditLogs.agentId, id))
      .orderBy(desc(agentAuditLogs.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      success: true,
      data: logs,
    });
  } catch (error) {
    logger.error({ error, agentId: c.req.param("id") }, "Failed to get agent logs");
    return c.json({ success: false, error: "Failed to get agent logs" }, 500);
  }
});

/**
 * GET /api/admin/agents/:id/stats
 * Get usage statistics for an agent
 */
agentsRouter.get("/:id/stats", async (c) => {
  try {
    const id = c.req.param("id");
    const days = parseInt(c.req.query("days") || "7");

    const [agent] = await db
      .select()
      .from(agentIdentities)
      .where(eq(agentIdentities.id, id))
      .limit(1);

    if (!agent) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Total calls
    const [{ value: totalCalls }] = await db
      .select({ value: count() })
      .from(agentAuditLogs)
      .where(and(eq(agentAuditLogs.agentId, id), gte(agentAuditLogs.createdAt, since)));

    // Successful calls
    const [{ value: successfulCalls }] = await db
      .select({ value: count() })
      .from(agentAuditLogs)
      .where(
        and(
          eq(agentAuditLogs.agentId, id),
          eq(agentAuditLogs.success, true),
          gte(agentAuditLogs.createdAt, since)
        )
      );

    // Actions breakdown
    const actionStats = await db
      .select({
        action: agentAuditLogs.action,
        success: agentAuditLogs.success,
        count: count(),
      })
      .from(agentAuditLogs)
      .where(and(eq(agentAuditLogs.agentId, id), gte(agentAuditLogs.createdAt, since)))
      .groupBy(agentAuditLogs.action, agentAuditLogs.success);

    // Group by action
    const actionsByType = actionStats.reduce(
      (acc: Record<string, { success: number; failed: number }>, stat: (typeof actionStats)[0]) => {
        if (!acc[stat.action]) {
          acc[stat.action] = { success: 0, failed: 0 };
        }
        if (stat.success) {
          acc[stat.action].success = Number(stat.count);
        } else {
          acc[stat.action].failed = Number(stat.count);
        }
        return acc;
      },
      {} as Record<string, { success: number; failed: number }>
    );

    return c.json({
      success: true,
      data: {
        period: `${days}d`,
        totalCalls,
        successfulCalls,
        failedCalls: totalCalls - successfulCalls,
        successRate: totalCalls > 0 ? `${Math.round((successfulCalls / totalCalls) * 100)}%` : "0%",
        actionsByType,
      },
    });
  } catch (error) {
    logger.error({ error, agentId: c.req.param("id") }, "Failed to get agent stats");
    return c.json({ success: false, error: "Failed to get agent stats" }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TRACES (TELEMETRY)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/agents/:id/traces
 * Get execution traces for an agent
 */
agentsRouter.get("/:id/traces", async (c) => {
  try {
    const id = c.req.param("id");
    const limit = parseInt(c.req.query("limit") || "50");

    const [agent] = await db
      .select()
      .from(agentIdentities)
      .where(eq(agentIdentities.id, id))
      .limit(1);

    if (!agent) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    const tracesList = await db
      .select()
      .from(agentTraces)
      .where(eq(agentTraces.agentId, id))
      .orderBy(desc(agentTraces.createdAt))
      .limit(limit);

    return c.json(tracesList);
  } catch (error) {
    logger.error({ error, agentId: c.req.param("id") }, "Failed to get traces");
    return c.json({ success: false, error: "Failed to get traces" }, 500);
  }
});

/**
 * GET /api/admin/agents/traces/:traceId/steps
 * Get steps for a specific trace
 */
agentsRouter.get("/traces/:traceId/steps", async (c) => {
  try {
    const traceId = c.req.param("traceId");

    const steps = await db
      .select()
      .from(agentTraceSteps)
      .where(eq(agentTraceSteps.traceId, traceId))
      .orderBy(agentTraceSteps.stepOrder);

    return c.json(steps);
  } catch (error) {
    logger.error({ error, traceId: c.req.param("traceId") }, "Failed to get trace steps");
    return c.json({ success: false, error: "Failed to get trace steps" }, 500);
  }
});

export default agentsRouter;
