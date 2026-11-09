/**
 * API Keys Routes
 *
 * DEPRECATED LEGACY BEHAVIOR: Previously created machine auth keys with prefix kitsuden_sk_.
 * NEW BEHAVIOR: Creates Agent NHI (Non-Human Identity) tokens with prefix kitsuden_agent_.
 *
 * This route is maintained for backward compatibility at /api/keys.
 * All newly created keys are Agent NHI tokens. Legacy kitsuden_sk_* keys are still
 * listed (marked deprecated) and can be revoked, but new keys use the kitsuden_agent_* format.
 */

import { zValidator } from "@hono/zod-validator";
import { eq, desc } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db";
import { apiKeys, agentIdentities, agentApiKeys } from "../db/schema";
import { createAgent } from "../services/agent-auth";

export const apiKeysRoutes = new Hono<{
  Variables: {
    user: { id: string; role: string } | null;
  };
}>();

// Ensure only admins can manage keys
apiKeysRoutes.use("*", async (c, next) => {
  const _user = c.get("user");
  if (!_user || _user.role !== "admin") {
    return c.json({ error: "Unauthorized. Admin role required." }, 403);
  }
  await next();
});

// ── GET /api/keys — List all API keys (modern Agent NHI + legacy) ──
apiKeysRoutes.get("/", async (c) => {
  void c.get("user"); // User available for future auth checks

  // Modern Agent NHI keys (type = "machine")
  const modernKeys = await db
    .select({
      id: agentIdentities.id,
      name: agentIdentities.name,
      hint: agentApiKeys.keyPrefix,
      lastUsedAt: agentApiKeys.lastUsedAt,
      expiresAt: agentApiKeys.expiresAt,
      createdAt: agentApiKeys.createdAt,
    })
    .from(agentIdentities)
    .innerJoin(agentApiKeys, eq(agentIdentities.id, agentApiKeys.agentId))
    .where(eq(agentIdentities.type, "machine"))
    .orderBy(desc(agentApiKeys.createdAt));

  // Legacy API keys
  const legacyKeys = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      hint: apiKeys.hint,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .orderBy(desc(apiKeys.createdAt));

  const combined = [
    ...modernKeys.map((k) => ({ ...k, deprecated: false, format: "kitsuden_agent" })),
    ...legacyKeys.map((k) => ({ ...k, deprecated: true, format: "kitsuden_sk" })),
  ].sort((a, b) => {
    const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return dateB - dateA;
  });

  c.header("Deprecation", "kitsuden_sk_*; kitsuden_agent_*");
  return c.json(combined);
});

// ── POST /api/keys — Create a new API key (Agent NHI) ──
const createKeySchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  expiresInDays: z.number().optional().nullable(),
});

apiKeysRoutes.post("/", zValidator("json", createKeySchema), async (c) => {
  const body = c.req.valid("json");

  // Create an Agent NHI of type "machine" with admin scope
  const { agent, plainApiKey } = await createAgent({
    name: body.name,
    type: "machine",
    description: "Machine API key created via /api/keys",
    scopes: ["admin"],
    rateLimit: 1000,
    // An `admin` key with no expiry is the perfect backdoor: unless
    // something else is requested, it expires after 90 days. An explicit
    // `null` still requests one with no expiry.
    expiresInDays: body.expiresInDays === undefined ? 90 : (body.expiresInDays ?? undefined),
  });

  c.header("Deprecation", "kitsuden_sk_*; kitsuden_agent_*");
  return c.json(
    {
      id: agent.id,
      name: agent.name,
      token: plainApiKey, // ONLY SHOWN ONCE
      format: "kitsuden_agent",
      expiresAt: agent.createdAt, // agent itself doesn't have expiresAt; key does
      createdAt: agent.createdAt,
      message:
        "This is an Agent NHI token (kitsuden_agent_*). Legacy kitsuden_sk_* keys are deprecated.",
    },
    201
  );
});

// ── DELETE /api/keys/:id — Revoke an API key (Agent or Legacy) ──
apiKeysRoutes.delete("/:id", async (c) => {
  const { id } = c.req.param();

  // Try to delete as modern Agent identity first
  const [agent] = await db.delete(agentIdentities).where(eq(agentIdentities.id, id)).returning();

  if (agent) {
    c.header("Deprecation", "kitsuden_sk_*; kitsuden_agent_*");
    return c.json({
      success: true,
      message: "Agent NHI revoked successfully",
      format: "kitsuden_agent",
    });
  }

  // Fallback: delete as legacy API key
  const result = await db.delete(apiKeys).where(eq(apiKeys.id, id)).returning();

  if (!result.length) {
    return c.json({ error: "API Key not found" }, 404);
  }

  c.header("Deprecation", "kitsuden_sk_*; kitsuden_agent_*");
  return c.json({
    success: true,
    message: "Legacy API Key revoked successfully",
    format: "kitsuden_sk",
  });
});
