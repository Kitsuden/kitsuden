/**
 * An agent trades its long-lived key for a short-lived token
 * ============================================================================
 *
 *   POST /api/agent/token/exchange
 *   { scopes?: string[], ttlSeconds?: number, audience?: "/api/datasets" }
 *   → 201 { token: "kitsuden_ast_…", tokenType: "Bearer" | "DPoP",
 *           expiresAt, scopes, audience }
 *
 * The new token holds a SUBSET of the caller's scopes (its denials always carry
 * over), lives `ttlSeconds` (default 300, max AGENT_SHORT_TOKEN_MAX_TTL), is
 * valid only under `audience` when given, and dies with its parent key. If the
 * request came with a valid DPoP proof (lib/dpop.ts), the token is bound to
 * that key: it is useless without the private key.
 *
 * Only an agent with its own key may call it: a short token cannot be
 * exchanged again, and a person, a code action or a replayed approval has
 * nothing to exchange. Never held for approval (it creates no data) and no
 * write quota. Audited. See docs/agents/dpop-and-short-tokens.md.
 */

import { defineOperation } from "@kitsuden/shared";
import type { Context } from "hono";
import { z } from "zod";

import { operationsRouter, type AnyOperation } from "../../../../packages/engine/src/operations";
import { registerCoreOperations } from "../lib/core-operations";
import { logger } from "../lib/logger";
import { optionalAuth, requireAuth } from "../middleware/auth";
import { logAgentAction } from "../services/agent-audit";
import type { AgentAuthContext } from "../services/agent-auth";
import {
  mintShortToken,
  narrowScopes,
  normalizeAudience,
  SHORT_TOKEN_DEFAULT_TTL,
  shortTokenMaxTtl,
} from "../services/agent-short-tokens";

export const AGENT_TOKEN_ROUTE = "/api/agent/token";

/** The agent of the request with a key of its own, or null. */
function exchangingAgent(c: Context): AgentAuthContext | null {
  const agent = (c.get as (k: string) => unknown)("agent") as AgentAuthContext | undefined;
  if (!agent?.agentId || !agent.keyId) return null;
  if (agent.agentId.startsWith("machine-") || agent.agentId.startsWith("action:")) return null;
  return agent;
}

async function exchange(c: Context): Promise<Response> {
  const agent = exchangingAgent(c);
  if (!agent) {
    const user = (c.get as (k: string) => unknown)("user");
    return c.json(
      {
        error: user ? "Forbidden" : "Unauthorized",
        message: "Only an agent exchanges its own key for a short-lived token.",
      },
      user ? 403 : 401
    );
  }
  if (agent.shortToken) {
    return c.json(
      {
        error: "Forbidden",
        code: "NO_CHAINING",
        message: "A short-lived token cannot be exchanged again. Exchange the long-lived key.",
      },
      403
    );
  }

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown> | null;
  const input = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const unknownKey = Object.keys(input).find(
    (k) => !["scopes", "ttlSeconds", "audience"].includes(k)
  );
  if (unknownKey)
    return c.json({ error: "Validation failed", message: `Unknown field: ${unknownKey}` }, 422);

  let requested: string[] | null = null;
  if (input.scopes !== undefined) {
    if (
      !Array.isArray(input.scopes) ||
      input.scopes.length > 100 ||
      !input.scopes.every((s) => typeof s === "string" && s.length > 0 && s.length <= 200)
    ) {
      return c.json(
        { error: "Validation failed", message: "scopes must be a list of scope strings" },
        422
      );
    }
    requested = input.scopes as string[];
  }
  const max = shortTokenMaxTtl();
  let ttl = SHORT_TOKEN_DEFAULT_TTL;
  if (input.ttlSeconds !== undefined) {
    if (
      typeof input.ttlSeconds !== "number" ||
      !Number.isInteger(input.ttlSeconds) ||
      input.ttlSeconds < 30
    ) {
      return c.json(
        { error: "Validation failed", message: "ttlSeconds must be an integer of at least 30" },
        422
      );
    }
    if (input.ttlSeconds > max) {
      return c.json(
        { error: "Validation failed", message: `ttlSeconds may not exceed ${max}` },
        422
      );
    }
    ttl = input.ttlSeconds;
  }
  let audience: string | null = null;
  if (input.audience !== undefined) {
    audience = typeof input.audience === "string" ? normalizeAudience(input.audience) : null;
    if (!audience) {
      return c.json(
        {
          error: "Validation failed",
          message: "audience must be a path prefix such as /api/datasets",
        },
        422
      );
    }
  }

  const narrowed = narrowScopes(agent.scopes, requested);
  if (!narrowed.ok) {
    return c.json(
      {
        error: "Forbidden",
        code: "SCOPE_NOT_HELD",
        message: `The caller does not hold these scopes: ${narrowed.outside.join(", ")}`,
      },
      403
    );
  }

  try {
    const minted = await mintShortToken({
      agentId: agent.agentId,
      parentKeyId: agent.keyId,
      scopes: narrowed.scopes,
      ttlSeconds: ttl,
      audience,
      dpopJkt: agent.dpopJkt ?? null,
    });
    logAgentAction({
      agentId: agent.agentId,
      keyId: agent.keyId,
      action: "short_token_issued",
      resource: "agent_short_tokens",
      resourceId: minted.id,
      details: { scopes: narrowed.scopes, ttlSeconds: ttl, audience, dpopBound: !!agent.dpopJkt },
      success: true,
    });
    return c.json(
      {
        token: minted.token,
        tokenType: agent.dpopJkt ? "DPoP" : "Bearer",
        expiresAt: minted.expiresAt.toISOString(),
        scopes: narrowed.scopes,
        audience,
      },
      201
    );
  } catch (error) {
    logger.error({ error, agentId: agent.agentId }, "Failed to issue a short-lived token");
    return c.json({ error: "Failed to issue a short-lived token" }, 500);
  }
}

export const agentTokenOperations: AnyOperation[] = [
  defineOperation({
    access: "session",
    id: "exchange-agent-token",
    method: "POST",
    route: "/exchange",
    summary: "Exchange an agent key for a short-lived token",
    description:
      "An agent trades its own long-lived key for a kitsuden_ast_ token of minutes: scopes a subset of its own (denials carry over), ttlSeconds (default 300, max AGENT_SHORT_TOKEN_MAX_TTL), and an optional audience path prefix. With a DPoP proof the new token is bound to that key. It cannot be exchanged again and dies with its parent key. Agents only. See docs/agents/dpop-and-short-tokens.md.",
    input: {
      body: z
        .object({
          scopes: z.array(z.string().min(1).max(200)).max(100).optional(),
          ttlSeconds: z.number().int().min(30).optional(),
          audience: z.string().min(1).max(300).optional(),
        })
        .strict(),
      validatesHandler: true,
    },
    output: { status: 201, schema: z.record(z.string(), z.unknown()) },
    errors: ["KITSUDEN_E_FORBIDDEN", "KITSUDEN_E_VALIDATION"],
    mcp: {
      exclude:
        "An agent exchanges its key over REST; an MCP session already has its own credential.",
    },
    tags: ["agents"],
    handle: (_e, { c }) => exchange(c as Context),
  }),
];

registerCoreOperations({
  konId: "kon-agent-token",
  mountPath: AGENT_TOKEN_ROUTE,
  description: "An agent exchanges its key for a short-lived token.",
  operations: agentTokenOperations,
});

const context = { auth: { requireAuth, optionalAuth } } as never;
export const agentTokenRoutes = operationsRouter("kon-agent-token", agentTokenOperations, context);
