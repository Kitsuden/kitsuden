/**
 * @file agent-memory.ts
 * @description Agent Memory API Routes
 *
 * Endpoints for agents to manage their own cognitive memory:
 * - GET /api/agent/memory - List the agent's memories
 * - POST /api/agent/memory - Create a new memory
 * - GET /api/agent/memory/:id - Get a specific memory
 * - PUT /api/agent/memory/:id - Update a memory
 * - DELETE /api/agent/memory/:id - Delete a memory
 * - POST /api/agent/memory/search - Filtered text search over the agent's memories
 *
 * @author Kitsuden Security Team
 * @version 1.0.0
 */

import { eqEnum } from "@kitsuden/engine";
import { eq, and, desc, sql, lt, gt, gte, lte, inArray, isNull, or } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "@/db";
import { agentMemory } from "@/db/schema";
import { logger } from "@/lib/logger";
import { memoryTextMatch } from "@/lib/memory-text-match";
import { agentAuthWithRBAC, requireScope } from "@/middleware/agent-rbac";
import type { AgentAuthContext } from "@/services/agent-auth";
import type { AppVariables } from "@/types/hono";

const agentMemoryRouter = new Hono<{ Variables: AppVariables }>();

// ═══════════════════════════════════════════════════════════════════════════
// MIDDLEWARE: All endpoints require agent authentication
// ═══════════════════════════════════════════════════════════════════════════

agentMemoryRouter.use(
  "*",
  agentAuthWithRBAC({
    scopes: ["memory:read"],
    optional: false,
  })
);

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface MemoryCreateRequest {
  key?: string;
  content: Record<string, unknown>;
  summary?: string;
  memoryType?: "short_term" | "long_term" | "episodic" | "semantic";
  category?:
    "general" | "conversation" | "task" | "insight" | "preference" | "context" | "knowledge";
  importance?: number;
  confidence?: number;
  source?: "agent" | "user" | "system" | "inference" | "external";
  validUntil?: string;
  relatedMemoryIds?: string[];
  tags?: string[];
}

interface MemoryUpdateRequest {
  content?: Record<string, unknown>;
  summary?: string;
  importance?: number;
  confidence?: number;
  validUntil?: string | null;
  tags?: string[];
}

interface MemorySearchRequest {
  query?: string;
  memoryType?: string;
  category?: string;
  tags?: string[];
  minImportance?: number;
  validOnly?: boolean;
  limit?: number;
  offset?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verifies that the agent only accesses its own memories
 */
function enforceOwnership(agent: AgentAuthContext, memoryAgentId: string): boolean {
  return agent.agentId === memoryAgentId;
}

/**
 * Builds search filters for memories
 */
function buildMemoryFilters(agentId: string, filters: MemorySearchRequest) {
  const conditions: any[] = [eq(agentMemory.agentId, agentId)];

  if (filters.memoryType) {
    conditions.push(eqEnum(agentMemory.memoryType, filters.memoryType));
  }

  if (filters.category) {
    conditions.push(eqEnum(agentMemory.category, filters.category));
  }

  if (filters.tags && filters.tags.length > 0) {
    // Look for memories that have ANY of the tags (OR)
    // Use PostgreSQL array format manually
    // @ts-ignore - tagArray is used for SQL generation
    const tagArray = filters.tags.map((t: string) => `"${t.replace(/"/g, '\\"')}"`).join(",");
    conditions.push(
      sql`${agentMemory.tags} ?| ARRAY[${sql.raw(filters.tags.map((_: string, i: number) => `$${i + 1}`).join(","))}]`
    );
  }

  if (filters.minImportance !== undefined) {
    conditions.push(gte(agentMemory.importance, filters.minImportance));
  }

  if (filters.validOnly) {
    // Valid memory: validFrom <= NOW() AND (validUntil IS NULL OR validUntil > NOW())
    conditions.push(lte(agentMemory.validFrom, sql`NOW()`));
    conditions.push(or(isNull(agentMemory.validUntil), gt(agentMemory.validUntil, sql`NOW()`))!);
  }

  return and(...conditions);
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/agent/memory
 * List the authenticated agent's memories
 *
 * Query params:
 * - type: short_term | long_term | episodic | semantic
 * - category: general | conversation | task | insight | preference | context | knowledge
 * - limit: number of results (default: 20)
 * - offset: pagination (default: 0)
 * - valid_only: only current memories (default: true)
 * - min_importance: filter by minimum importance
 */
agentMemoryRouter.get("/", async (c) => {
  const agent = c.get("agent")!;
  const requestId = c.get("requestId");

  try {
    const query = c.req.query();

    const filters: MemorySearchRequest = {
      memoryType: query.type,
      category: query.category,
      tags: query.tags?.split(","),
      minImportance: query.min_importance ? parseInt(query.min_importance) : undefined,
      validOnly: query.valid_only !== "false",
      limit: parseInt(query.limit || "20"),
      offset: parseInt(query.offset || "0"),
    };

    // Build conditions
    const whereClause = buildMemoryFilters(agent.agentId, filters);

    // Run query
    const memories = await db
      .select({
        id: agentMemory.id,
        key: agentMemory.key,
        memoryType: agentMemory.memoryType,
        category: agentMemory.category,
        summary: agentMemory.summary,
        importance: agentMemory.importance,
        confidence: agentMemory.confidence,
        source: agentMemory.source,
        tags: agentMemory.tags,
        validFrom: agentMemory.validFrom,
        validUntil: agentMemory.validUntil,
        accessCount: agentMemory.accessCount,
        lastAccessedAt: agentMemory.lastAccessedAt,
        createdAt: agentMemory.createdAt,
        updatedAt: agentMemory.updatedAt,
      })
      .from(agentMemory)
      .where(whereClause)
      .orderBy(desc(agentMemory.importance), desc(agentMemory.createdAt))
      .limit(filters.limit!)
      .offset(filters.offset!);

    // Count total
    const [{ count: total }] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(agentMemory)
      .where(whereClause);

    logger.debug(
      {
        agentId: agent.agentId,
        requestId,
        count: memories.length,
        total,
      },
      "Agent memory listed"
    );

    // Update last_accessed for these memories (fire and forget)
    if (memories.length > 0) {
      const memoryIds = memories.map((m: (typeof memories)[0]) => m.id);
      db.update(agentMemory)
        .set({
          accessCount: sql`${agentMemory.accessCount} + 1`,
          lastAccessedAt: new Date(),
        })
        .where(inArray(agentMemory.id, memoryIds))
        .execute()
        .catch(() => {}); // Silence errors
    }

    return c.json({
      success: true,
      data: memories,
      pagination: {
        total: Number(total),
        limit: filters.limit,
        offset: filters.offset,
        hasMore: (filters.offset || 0) + memories.length < Number(total),
      },
    });
  } catch (error) {
    logger.error({ error, agentId: agent.agentId, requestId }, "Failed to list agent memories");
    return c.json(
      {
        success: false,
        error: "Failed to retrieve memories",
        code: "MEMORY_LIST_ERROR",
      },
      500
    );
  }
});

/**
 * POST /api/agent/memory
 * Create a new memory
 *
 * Requires scope: memory:write
 */
agentMemoryRouter.post(
  "/",
  requireScope("memory:write", "create memory", "memory system"),
  async (c) => {
    const agent = c.get("agent")!;
    const requestId = c.get("requestId");

    try {
      const body: MemoryCreateRequest = await c.req.json();

      // Validations
      if (!body.content || typeof body.content !== "object") {
        return c.json(
          {
            success: false,
            error: "Content is required and must be an object",
            code: "INVALID_CONTENT",
          },
          400
        );
      }

      if (body.importance !== undefined && (body.importance < 0 || body.importance > 100)) {
        return c.json(
          {
            success: false,
            error: "Importance must be between 0 and 100",
            code: "INVALID_IMPORTANCE",
          },
          400
        );
      }

      if (body.confidence !== undefined && (body.confidence < 0 || body.confidence > 100)) {
        return c.json(
          {
            success: false,
            error: "Confidence must be between 0 and 100",
            code: "INVALID_CONFIDENCE",
          },
          400
        );
      }

      // Create memory
      const [memory] = await db
        .insert(agentMemory)
        .values({
          agentId: agent.agentId,
          key: body.key,
          content: body.content,
          summary: body.summary,
          memoryType: body.memoryType || "short_term",
          category: body.category || "general",
          importance: body.importance ?? 50,
          confidence: body.confidence ?? 80,
          source: body.source || "agent",
          validUntil: body.validUntil ? new Date(body.validUntil) : null,
          relatedMemoryIds: body.relatedMemoryIds || [],
          tags: body.tags || [],
        })
        .returning();

      logger.info(
        {
          agentId: agent.agentId,
          memoryId: memory.id,
          requestId,
          memoryType: memory.memoryType,
          category: memory.category,
        },
        "Agent memory created"
      );

      return c.json(
        {
          success: true,
          data: {
            id: memory.id,
            key: memory.key,
            memoryType: memory.memoryType,
            category: memory.category,
            summary: memory.summary,
            importance: memory.importance,
            confidence: memory.confidence,
            source: memory.source,
            tags: memory.tags,
            validFrom: memory.validFrom,
            validUntil: memory.validUntil,
            createdAt: memory.createdAt,
          },
        },
        201
      );
    } catch (error) {
      logger.error({ error, agentId: agent.agentId, requestId }, "Failed to create agent memory");
      return c.json(
        {
          success: false,
          error: "Failed to create memory",
          code: "MEMORY_CREATE_ERROR",
        },
        500
      );
    }
  }
);

// `/stats` goes before `/:id`: registered after it, Hono resolved it through the
// wildcard with id="stats" and the query looked for a memory with that UUID.
// Guarded by tests/unit/shadowed-routes.test.ts.
/**
 * GET /api/agent/memory/stats
 * Agent memory usage statistics
 */
agentMemoryRouter.get("/stats", async (c) => {
  const agent = c.get("agent")!;
  const requestId = c.get("requestId");

  try {
    // Count by type
    const typeStats = await db
      .select({
        memoryType: agentMemory.memoryType,
        count: sql<number>`COUNT(*)`,
        avgImportance: sql<number>`AVG(${agentMemory.importance})`,
        totalAccessCount: sql<number>`SUM(${agentMemory.accessCount})`,
      })
      .from(agentMemory)
      .where(eq(agentMemory.agentId, agent.agentId))
      .groupBy(agentMemory.memoryType);

    // Count by category
    const categoryStats = await db
      .select({
        category: agentMemory.category,
        count: sql<number>`COUNT(*)`,
      })
      .from(agentMemory)
      .where(eq(agentMemory.agentId, agent.agentId))
      .groupBy(agentMemory.category);

    // Totals
    const [{ totalMemories, expiredMemories }] = await db
      .select({
        totalMemories: sql<number>`COUNT(*)`,
        expiredMemories: sql<number>`COUNT(CASE WHEN ${agentMemory.validUntil} < NOW() THEN 1 END)`,
      })
      .from(agentMemory)
      .where(eq(agentMemory.agentId, agent.agentId));

    // Most accessed memory
    const [mostAccessed] = await db
      .select({
        id: agentMemory.id,
        key: agentMemory.key,
        accessCount: agentMemory.accessCount,
      })
      .from(agentMemory)
      .where(eq(agentMemory.agentId, agent.agentId))
      .orderBy(desc(agentMemory.accessCount))
      .limit(1);

    logger.debug(
      {
        agentId: agent.agentId,
        requestId,
      },
      "Agent memory stats retrieved"
    );

    return c.json({
      success: true,
      data: {
        total: Number(totalMemories),
        expired: Number(expiredMemories),
        byType: typeStats,
        byCategory: categoryStats,
        mostAccessed: mostAccessed || null,
      },
    });
  } catch (error) {
    logger.error({ error, agentId: agent.agentId, requestId }, "Failed to get agent memory stats");
    return c.json(
      {
        success: false,
        error: "Failed to get memory stats",
        code: "MEMORY_STATS_ERROR",
      },
      500
    );
  }
});

/**
 * GET /api/agent/memory/:id
 * Get a specific memory
 */
agentMemoryRouter.get("/:id", async (c) => {
  const agent = c.get("agent")!;
  const requestId = c.get("requestId");
  const memoryId = c.req.param("id");

  try {
    const [memory] = await db
      .select()
      .from(agentMemory)
      .where(and(eq(agentMemory.id, memoryId), eq(agentMemory.agentId, agent.agentId)))
      .limit(1);

    if (!memory) {
      return c.json(
        {
          success: false,
          error: "Memory not found",
          code: "MEMORY_NOT_FOUND",
        },
        404
      );
    }

    // Update access counter (fire and forget)
    db.update(agentMemory)
      .set({
        accessCount: sql`${agentMemory.accessCount} + 1`,
        lastAccessedAt: new Date(),
      })
      .where(eq(agentMemory.id, memoryId))
      .execute()
      .catch(() => {});

    logger.debug(
      {
        agentId: agent.agentId,
        memoryId,
        requestId,
      },
      "Agent memory retrieved"
    );

    return c.json({
      success: true,
      data: memory,
    });
  } catch (error) {
    logger.error(
      { error, agentId: agent.agentId, memoryId, requestId },
      "Failed to get agent memory"
    );
    return c.json(
      {
        success: false,
        error: "Failed to retrieve memory",
        code: "MEMORY_GET_ERROR",
      },
      500
    );
  }
});

/**
 * GET /api/agent/memory/key/:key
 * Get memory by key
 */
agentMemoryRouter.get("/key/:key", async (c) => {
  const agent = c.get("agent")!;
  const requestId = c.get("requestId");
  const key = c.req.param("key");

  try {
    const [memory] = await db
      .select()
      .from(agentMemory)
      .where(and(eq(agentMemory.agentId, agent.agentId), eq(agentMemory.key, key)))
      .limit(1);

    if (!memory) {
      return c.json(
        {
          success: false,
          error: "Memory not found",
          code: "MEMORY_NOT_FOUND",
        },
        404
      );
    }

    // Update access counter
    db.update(agentMemory)
      .set({
        accessCount: sql`${agentMemory.accessCount} + 1`,
        lastAccessedAt: new Date(),
      })
      .where(eq(agentMemory.id, memory.id))
      .execute()
      .catch(() => {});

    return c.json({
      success: true,
      data: memory,
    });
  } catch (error) {
    logger.error({ error, agentId: agent.agentId, key, requestId }, "Failed to get memory by key");
    return c.json(
      {
        success: false,
        error: "Failed to retrieve memory",
        code: "MEMORY_GET_ERROR",
      },
      500
    );
  }
});

/**
 * PUT /api/agent/memory/:id
 * Update memory
 *
 * Requires scope: memory:write
 */
agentMemoryRouter.put(
  "/:id",
  requireScope("memory:write", "update memory", "memory system"),
  async (c) => {
    const agent = c.get("agent")!;
    const requestId = c.get("requestId");
    const memoryId = c.req.param("id");

    try {
      // Verify that the memory exists and belongs to the agent
      const [existing] = await db
        .select({ id: agentMemory.id, agentId: agentMemory.agentId })
        .from(agentMemory)
        .where(eq(agentMemory.id, memoryId))
        .limit(1);

      if (!existing) {
        return c.json(
          {
            success: false,
            error: "Memory not found",
            code: "MEMORY_NOT_FOUND",
          },
          404
        );
      }

      if (!enforceOwnership(agent, existing.agentId)) {
        logger.warn(
          {
            agentId: agent.agentId,
            targetMemoryId: memoryId,
            memoryOwner: existing.agentId,
            requestId,
          },
          "Agent tried to update memory belonging to another agent"
        );

        return c.json(
          {
            success: false,
            error: "You can only update your own memories",
            code: "MEMORY_ACCESS_DENIED",
          },
          403
        );
      }

      const body: MemoryUpdateRequest = await c.req.json();

      // Validations
      if (body.importance !== undefined && (body.importance < 0 || body.importance > 100)) {
        return c.json(
          {
            success: false,
            error: "Importance must be between 0 and 100",
            code: "INVALID_IMPORTANCE",
          },
          400
        );
      }

      if (body.confidence !== undefined && (body.confidence < 0 || body.confidence > 100)) {
        return c.json(
          {
            success: false,
            error: "Confidence must be between 0 and 100",
            code: "INVALID_CONFIDENCE",
          },
          400
        );
      }

      // Update
      const [updated] = await db
        .update(agentMemory)
        .set({
          content: body.content !== undefined ? body.content : undefined,
          summary: body.summary !== undefined ? body.summary : undefined,
          importance: body.importance !== undefined ? body.importance : undefined,
          confidence: body.confidence !== undefined ? body.confidence : undefined,
          validUntil:
            body.validUntil !== undefined
              ? body.validUntil
                ? new Date(body.validUntil)
                : null
              : undefined,
          tags: body.tags !== undefined ? body.tags : undefined,
          updatedAt: new Date(),
        })
        .where(eq(agentMemory.id, memoryId))
        .returning();

      logger.info(
        {
          agentId: agent.agentId,
          memoryId,
          requestId,
        },
        "Agent memory updated"
      );

      return c.json({
        success: true,
        data: updated,
      });
    } catch (error) {
      logger.error(
        { error, agentId: agent.agentId, memoryId, requestId },
        "Failed to update agent memory"
      );
      return c.json(
        {
          success: false,
          error: "Failed to update memory",
          code: "MEMORY_UPDATE_ERROR",
        },
        500
      );
    }
  }
);

/**
 * DELETE /api/agent/memory/:id
 * Delete memory
 *
 * Requires scope: memory:delete
 */
agentMemoryRouter.delete(
  "/:id",
  requireScope("memory:delete", "delete memory", "memory system"),
  async (c) => {
    const agent = c.get("agent")!;
    const requestId = c.get("requestId");
    const memoryId = c.req.param("id");

    try {
      // Verify that the memory exists and belongs to the agent
      const [existing] = await db
        .select({ id: agentMemory.id, agentId: agentMemory.agentId })
        .from(agentMemory)
        .where(eq(agentMemory.id, memoryId))
        .limit(1);

      if (!existing) {
        return c.json(
          {
            success: false,
            error: "Memory not found",
            code: "MEMORY_NOT_FOUND",
          },
          404
        );
      }

      if (!enforceOwnership(agent, existing.agentId)) {
        logger.warn(
          {
            agentId: agent.agentId,
            targetMemoryId: memoryId,
            memoryOwner: existing.agentId,
            requestId,
          },
          "Agent tried to delete memory belonging to another agent"
        );

        return c.json(
          {
            success: false,
            error: "You can only delete your own memories",
            code: "MEMORY_ACCESS_DENIED",
          },
          403
        );
      }

      await db.delete(agentMemory).where(eq(agentMemory.id, memoryId));

      logger.info(
        {
          agentId: agent.agentId,
          memoryId,
          requestId,
        },
        "Agent memory deleted"
      );

      return c.json({
        success: true,
        message: "Memory deleted successfully",
      });
    } catch (error) {
      logger.error(
        { error, agentId: agent.agentId, memoryId, requestId },
        "Failed to delete agent memory"
      );
      return c.json(
        {
          success: false,
          error: "Failed to delete memory",
          code: "MEMORY_DELETE_ERROR",
        },
        500
      );
    }
  }
);

/**
 * POST /api/agent/memory/search
 * Filters plus a text `query` (key, summary, content), paginated over the matches.
 */
agentMemoryRouter.post("/search", async (c) => {
  const agent = c.get("agent")!;
  const requestId = c.get("requestId");

  try {
    const body: MemorySearchRequest = await c.req.json();

    const filters: MemorySearchRequest = {
      memoryType: body.memoryType,
      category: body.category,
      tags: body.tags,
      minImportance: body.minImportance,
      validOnly: body.validOnly !== false,
      limit: body.limit || 20,
      offset: body.offset || 0,
    };

    // Text search, in SQL so the page (limit/offset) is taken from the matches and a
    // match outside the first page is still found. Semantic search by embedding is not
    // wired here; pgvector similarity lives in the `vector-search` core battery.
    const textQuery = typeof body.query === "string" ? body.query.trim() : "";
    const whereClause = textQuery
      ? and(buildMemoryFilters(agent.agentId, filters), memoryTextMatch(textQuery))
      : buildMemoryFilters(agent.agentId, filters);

    const results = await db
      .select({
        id: agentMemory.id,
        key: agentMemory.key,
        memoryType: agentMemory.memoryType,
        category: agentMemory.category,
        summary: agentMemory.summary,
        content: agentMemory.content,
        importance: agentMemory.importance,
        confidence: agentMemory.confidence,
        tags: agentMemory.tags,
        validFrom: agentMemory.validFrom,
        validUntil: agentMemory.validUntil,
        createdAt: agentMemory.createdAt,
        updatedAt: agentMemory.updatedAt,
      })
      .from(agentMemory)
      .where(whereClause)
      .orderBy(desc(agentMemory.importance), desc(agentMemory.createdAt))
      .limit(filters.limit!)
      .offset(filters.offset!);

    logger.debug(
      {
        agentId: agent.agentId,
        requestId,
        query: body.query,
        resultsCount: results.length,
      },
      "Agent memory search completed"
    );

    return c.json({
      success: true,
      data: results,
      search: {
        query: body.query,
        filters: {
          memoryType: body.memoryType,
          category: body.category,
          tags: body.tags,
        },
      },
      pagination: {
        limit: filters.limit,
        offset: filters.offset,
        total: results.length,
      },
    });
  } catch (error) {
    logger.error({ error, agentId: agent.agentId, requestId }, "Failed to search agent memories");
    return c.json(
      {
        success: false,
        error: "Failed to search memories",
        code: "MEMORY_SEARCH_ERROR",
      },
      500
    );
  }
});

/**
 * POST /api/agent/memory/cleanup
 * Clean up old short-term memories
 *
 * Requires scope: memory:admin
 */
agentMemoryRouter.post(
  "/cleanup",
  requireScope("memory:admin", "clean up memories", "memory system"),
  async (c) => {
    const agent = c.get("agent")!;
    const requestId = c.get("requestId");

    try {
      const body = await c.req.json().catch(() => ({}));
      const maxAgeHours = body.maxAgeHours || 24;
      const minImportance = body.minImportance || 10;

      // Delete old short-term memories with low importance
      const result = await db
        .delete(agentMemory)
        .where(
          and(
            eq(agentMemory.agentId, agent.agentId),
            eq(agentMemory.memoryType, "short_term"),
            lte(agentMemory.importance, minImportance),
            lt(agentMemory.createdAt, sql`NOW() - INTERVAL '1 hour' * ${maxAgeHours}`),
            or(isNull(agentMemory.validUntil), lt(agentMemory.validUntil, sql`NOW()`))!
          )
        )
        .returning({ id: agentMemory.id });

      logger.info(
        {
          agentId: agent.agentId,
          requestId,
          deletedCount: result.length,
          maxAgeHours,
          minImportance,
        },
        "Agent memory cleanup completed"
      );

      return c.json({
        success: true,
        data: {
          deletedCount: result.length,
          criteria: {
            maxAgeHours,
            minImportance,
            memoryType: "short_term",
          },
        },
      });
    } catch (error) {
      logger.error(
        { error, agentId: agent.agentId, requestId },
        "Failed to cleanup agent memories"
      );
      return c.json(
        {
          success: false,
          error: "Failed to cleanup memories",
          code: "MEMORY_CLEANUP_ERROR",
        },
        500
      );
    }
  }
);

export default agentMemoryRouter;
