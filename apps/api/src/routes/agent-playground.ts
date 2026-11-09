/**
 * Agent Playground API
 *
 * Endpoint to chat with agents from the Admin UI.
 * Connects to the Agent Engine and real LLMs.
 */

import { messageOf } from "@kitsuden/engine";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "@/db";
import { agentIdentities } from "@/db/schema";
import { logger } from "@/lib/logger";
import { runAgent } from "@/services/agent-engine";

import { requireAuth } from "../middleware/auth";
import { noAgentsInAgentManagement } from "../middleware/auth-guard";
import type { AppVariables } from "../types/hono";

const playgroundRouter = new Hono<{ Variables: AppVariables }>();

// Requires an administrator session (used from the Admin UI)
playgroundRouter.use("*", requireAuth);
// An agent does not make another agent act (with THAT agent's scopes): people only.
playgroundRouter.use("*", noAgentsInAgentManagement);

/**
 * POST /api/admin/agents/:id/chat
 * Send a message to an agent and get a response
 */
playgroundRouter.post("/:id/chat", async (c) => {
  try {
    const agentId = c.req.param("id");
    const {
      message,
      sessionId = crypto.randomUUID(),
      history = [],
      enableMemory = true,
      enableBrainSearch = true,
    } = await c.req.json();

    if (!message || typeof message !== "string") {
      return c.json({ success: false, error: "Message is required" }, 400);
    }

    // Verify that the agent exists
    const [agent] = await db
      .select()
      .from(agentIdentities)
      .where(eq(agentIdentities.id, agentId))
      .limit(1);

    if (!agent) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    if (!agent.isActive) {
      return c.json({ success: false, error: "Agent is inactive" }, 400);
    }

    // Run through the Agent Engine
    const result = await runAgent({
      agentId,
      message,
      sessionId,
      history,
      enableMemory,
      enableBrainSearch,
    });

    logger.info(
      {
        agentId,
        traceId: result.traceId,
        sessionId: result.sessionId,
        provider: result.provider,
        model: result.model,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        durationMs: result.durationMs,
        cached: result.cached,
      },
      "Agent playground chat completed"
    );

    return c.json({
      success: true,
      response: result.response,
      traceId: result.traceId,
      sessionId: result.sessionId,
      provider: result.provider,
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      durationMs: result.durationMs,
      cached: result.cached,
    });
  } catch (error: unknown) {
    const agentId = c.req.param("id");
    logger.error({ error, agentId }, "Agent playground chat failed");

    // Friendly error messages
    if (messageOf(error)?.includes("No LLM provider configured")) {
      return c.json(
        {
          success: false,
          error:
            "No LLM provider configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, or OLLAMA_BASE_URL in your .env file.",
          code: "LLM_NOT_CONFIGURED",
        },
        503
      );
    }

    return c.json(
      {
        success: false,
        error: messageOf(error) || "Failed to process agent message",
        code: "AGENT_ENGINE_ERROR",
      },
      500
    );
  }
});

/**
 * GET /api/admin/agents/:id/chat/history
 * Get the chat history of a session
 */
playgroundRouter.get("/:id/chat/history", async (c) => {
  try {
    void c.req.param("id"); // agentId extracted for future validation
    const sessionId = c.req.query("sessionId");

    if (!sessionId) {
      return c.json({ success: false, error: "sessionId required" }, 400);
    }

    // Get the traces of this session
    const { agentTraces, agentTraceSteps } = await import("@/db/schema");

    const traces = await db
      .select()
      .from(agentTraces)
      .where(eq(agentTraces.sessionId, sessionId))
      .orderBy(agentTraces.createdAt);

    // For each trace, get its steps
    const history = [];
    for (const trace of traces) {
      const steps = await db
        .select()
        .from(agentTraceSteps)
        .where(eq(agentTraceSteps.traceId, trace.id))
        .orderBy(agentTraceSteps.stepOrder);

      for (const step of steps) {
        if (step.stepType === "user_input") {
          history.push({
            role: "user",
            content: step.content,
            timestamp: step.createdAt,
          });
        } else if (step.stepType === "llm_call" && step.content) {
          history.push({
            role: "assistant",
            content: step.content,
            timestamp: step.createdAt,
            traceId: trace.id,
          });
        }
      }
    }

    return c.json({
      success: true,
      history,
      sessionId,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to get chat history");
    return c.json(
      {
        success: false,
        error: messageOf(error),
        code: "HISTORY_ERROR",
      },
      500
    );
  }
});

export default playgroundRouter;
