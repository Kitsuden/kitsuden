/**
 * /api/admin/agents/:id/notify — an agent's notification URL
 * ============================================================================
 *
 *   GET  /api/admin/agents/:id/notify          { url, hasSecret }
 *   PUT  /api/admin/agents/:id/notify          { url: "https://…" | null }
 *        When the first URL is set, the signing secret is created and returned
 *        in `secret`: it is the ONLY time it is seen.
 *   POST /api/admin/agents/:id/notify/rotate   a new secret (once)
 *
 * Core SDK operations (`kon-agent-notifications`), outside MCP. Administrators
 * only. The URL is set by a human, never the agent: that way an agent cannot
 * point notifications at an internal address. See
 * lib/proposal-notifications.ts.
 */

import { defineOperation } from "@kitsuden/shared";
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { operationsRouter, type AnyOperation } from "../../../../packages/engine/src/operations";
import { db } from "../db";
import { agentIdentities } from "../db/schema";
import {
  notificationSettings,
  saveNotificationUrl,
  invalidUrlReason,
  rotateNotificationSecret,
} from "../lib/proposal-notifications";
import { logger } from "../lib/logger";
import { registerCoreOperations } from "../lib/core-operations";
import { optionalAuth, requireAuth } from "../middleware/auth";
import { noAgentsInAgentManagement, requireAdminRole } from "../middleware/auth-guard";

const fromAdmin = {
  access: "session" as const,
  permission: { roles: ["admin"] },
  // The URL and the secret are set by a person, never by an agent
  before: [
    noAgentsInAgentManagement as unknown as MiddlewareHandler,
    requireAdminRole as unknown as MiddlewareHandler,
  ],
  mcp: {
    exclude:
      "Only a human administrator sets where an agent's notifications go (an agent could point them at an internal address).",
  },
  tags: ["agents"],
};
const ParamId = z.object({ id: z.string().min(1).max(200) });
const Settings = z.object({ url: z.string().nullable(), hasSecret: z.boolean() });
const notFound = (c: Context) =>
  c.json({ error: "Agent not found", code: "KITSUDEN_E_NOT_FOUND" }, 404);

async function exists(id: string): Promise<boolean> {
  const [a] = await db
    .select({ id: agentIdentities.id })
    .from(agentIdentities)
    .where(eq(agentIdentities.id, id))
    .limit(1);
  return Boolean(a);
}

function who(c: Context): string {
  return ((c.get("user" as never) as { id?: string } | null)?.id ?? "admin").slice(0, 200);
}

export const notificationOperations: AnyOperation[] = [
  defineOperation({
    ...fromAdmin,
    id: "agent-notification",
    method: "GET",
    route: "/:id/notify",
    summary: "Agent notify URL (admin)",
    description:
      "The agent's notify URL for proposal resolutions, and whether it has a signing secret (never the secret).",
    input: { params: ParamId },
    output: { schema: Settings },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: async ({ params }, { c }) => {
      const id = (params as { id: string }).id;
      return (await exists(id)) ? notificationSettings(id) : notFound(c);
    },
  }),
  defineOperation({
    ...fromAdmin,
    id: "set-agent-notification",
    method: "PUT",
    route: "/:id/notify",
    summary: "Set the agent notify URL (admin)",
    description:
      "Sets (or removes, with null) the https URL that receives a signed webhook when one of the agent's proposals is resolved. The first time, the signing secret is returned in `secret`: it is shown only once.",
    input: { params: ParamId, body: z.object({ url: z.string().max(2000).nullable() }) },
    output: { schema: z.object({ url: z.string().nullable(), secret: z.string().optional() }) },
    errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_BAD_REQUEST"],
    handle: async ({ params, body: body }, { c }) => {
      const id = (params as { id: string }).id;
      if (!(await exists(id))) return notFound(c);
      const url = (body as { url: string | null }).url || null;
      if (url) {
        const reason = invalidUrlReason(url);
        if (reason) return c.json({ error: reason, code: "KITSUDEN_E_BAD_REQUEST" }, 400);
      }
      const r = await saveNotificationUrl(id, url, who(c));
      logger.info(
        { agentId: id, url: r.url ? new URL(r.url).origin : null },
        "[notifications] notification URL changed"
      );
      return r;
    },
  }),
  defineOperation({
    ...fromAdmin,
    id: "rotate-notification-secret",
    method: "POST",
    route: "/:id/notify/rotate",
    summary: "Rotate the agent notify secret (admin)",
    description:
      "Issues a new signing secret (the previous one stops working at once). Shown only in this response.",
    input: { params: ParamId },
    output: { schema: z.object({ secret: z.string() }) },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: async ({ params }, { c }) => {
      const id = (params as { id: string }).id;
      if (!(await exists(id))) return notFound(c);
      const secret = await rotateNotificationSecret(id, who(c));
      logger.info({ agentId: id }, "[notifications] notification secret rotated");
      return { secret };
    },
  }),
];

export const notificationsKon = {
  id: "kon-agent-notifications",
  name: "Agent notifications",
  version: "1.0.0",
  mountPath: "/api/admin/agents",
  operations: notificationOperations,
};

registerCoreOperations({
  konId: "kon-agent-notifications",
  mountPath: "/api/admin/agents",
  description: "Where an agent is told that its proposals were resolved (administrators only).",
  operations: notificationOperations,
});

const context = { auth: { requireAuth, optionalAuth } } as never;
export const agentNotificationsRoutes = operationsRouter(
  "kon-agent-notifications",
  notificationOperations,
  context
);
