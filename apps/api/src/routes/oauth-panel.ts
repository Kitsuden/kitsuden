/**
 * OAuth for MCP — what the PANEL uses (core SDK operations)
 * ============================================================================
 *
 *   GET    /api/oauth/consent/:id   what the consent screen shows
 *   POST   /api/oauth/consent/:id   approve (agent + scopes) or deny
 *   GET    /api/oauth/grants        connected clients (admin: all; editor: their own)
 *   DELETE /api/oauth/grants/:id    revoke a connection
 *
 * Only HUMAN admins or editors, with the role as of NOW (not the cookie's). An
 * agent —static key or OAuth, whether or not it carries `admin`— never consents to or
 * manages connections. Outside MCP on purpose. The protocol endpoints
 * (metadata, registration, token…) are in routes/oauth.ts.
 * Guide: docs/agents/oauth.md.
 */

import { defineOperation, operationsRouter, type AnyOperation } from "@kitsuden/engine";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { registerCoreOperations } from "../lib/core-operations";
import {
  ErrorOAuth,
  visibleGrant,
  decideConsent,
  freshHuman,
  listConnections,
  revokeGrant,
  consentView,
  type Human,
} from "../lib/oauth/service";
import { optionalAuth, requireAuth } from "../middleware/auth";

export const OAUTH_ROUTE = "/api/oauth";

const get = (c: Context, k: string) => (c.get as (k: string) => unknown)(k);

/** Human admin/editor with a fresh role; leaves it in `oauthHuman`. */
const teamHuman: MiddlewareHandler = async (c, next) => {
  const user = get(c, "user") as { id?: string; role?: string } | null | undefined;
  if (!user?.id)
    return c.json({ error: "Authentication required", code: "KITSUDEN_E_UNAUTHENTICATED" }, 401);
  if (get(c, "agent") || user.role === "agent" || user.id.startsWith("machine-")) {
    return c.json(
      {
        error: "Only a human can consent or manage OAuth connections",
        code: "KITSUDEN_E_FORBIDDEN",
      },
      403
    );
  }
  const h = await freshHuman(user.id);
  if (!h || (h.role !== "admin" && h.role !== "editor")) {
    return c.json(
      { error: "Requires an admin or editor account", code: "KITSUDEN_E_FORBIDDEN" },
      403
    );
  }
  (c.set as (k: string, v: unknown) => void)("oauthHuman", h);
  c.header("Cache-Control", "no-store");
  await next();
};

const human = (c: Context) => get(c, "oauthHuman") as Human;

const WITHOUT_MCP = {
  exclude:
    "OAuth consent and connection management are human decisions in the admin panel; no agent may grant itself access or revoke connections.",
};
const ofTheTeam = {
  access: "session" as const,
  permission: { roles: ["admin", "editor"] },
  before: [teamHuman],
  mcp: WITHOUT_MCP,
  tags: ["oauth"],
};

const Obj = z.record(z.string(), z.unknown());
const ParamId = z.object({ id: z.guid() });
const Decision = z
  .object({
    decision: z.enum(["approve", "deny"]),
    agentId: z.string().max(200).optional(),
    newAgent: z
      .object({ name: z.string().max(100), description: z.string().max(500).optional() })
      .strict()
      .optional(),
    scopes: z.array(z.string().max(200)).max(200).optional(),
  })
  .strict();
const ConnectionsFilter = z
  .object({
    agentId: z.string().max(200).optional(),
    includeRevoked: z.enum(["true", "false"]).optional(),
  })
  .strict();

const NOT_PRESENT = {
  error: "Authorization request not found or expired",
  code: "KITSUDEN_E_NOT_FOUND",
};

export const oauthOperations: AnyOperation[] = [
  defineOperation({
    ...ofTheTeam,
    id: "view-consent",
    method: "GET",
    route: "/consent/:id",
    summary: "OAuth consent request",
    description:
      "What the consent screen shows for a pending MCP client authorization: the client, where the answer is sent (with a localhost warning), the requested scopes and the agents this human may delegate, with the scopes they may grant.",
    input: { params: ParamId },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: async (e, { c }) => {
      const view = await consentView((e.params as { id: string }).id, human(c));
      return view ? c.json(view) : c.json(NOT_PRESENT, 404);
    },
  }),
  defineOperation({
    ...ofTheTeam,
    id: "decide-consent",
    method: "POST",
    route: "/consent/:id",
    summary: "Allow or deny an MCP client",
    description:
      "Allow: the client acts as the chosen agent (or a new one, admins only) with the chosen scopes, which must be a subset of what the agent and this human already have; this human becomes the agent's signer. Deny: the client gets access_denied. Answers with the URL to send the browser to.",
    input: { params: ParamId, body: Decision },
    output: { schema: z.object({ redirectTo: z.string() }) },
    errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_FORBIDDEN", "KITSUDEN_E_VALIDATION"],
    handle: async (e, { c }) => {
      try {
        const r = await decideConsent(
          (e.params as { id: string }).id,
          human(c),
          e.body as z.infer<typeof Decision>
        );
        return r ? c.json(r) : c.json(NOT_PRESENT, 404);
      } catch (err) {
        if (err instanceof ErrorOAuth)
          return c.json({ error: err.description, code: err.error }, err.status as 400);
        throw err;
      }
    },
  }),
  defineOperation({
    ...ofTheTeam,
    id: "list-connections",
    method: "GET",
    route: "/grants",
    summary: "Connected MCP clients",
    description:
      "OAuth connections: client, agent, who allowed it, scopes, created and last used. Admins see all; editors the ones they allowed.",
    input: { query: ConnectionsFilter },
    output: { schema: z.object({ grants: z.array(Obj) }) },
    handle: async (e, { c }) => {
      const q = e.query as z.infer<typeof ConnectionsFilter>;
      return c.json({
        grants: await listConnections(human(c), {
          agentId: q.agentId,
          includeRevoked: q.includeRevoked === "true",
        }),
      });
    },
  }),
  defineOperation({
    ...ofTheTeam,
    id: "revoke-connection",
    method: "DELETE",
    route: "/grants/:id",
    summary: "Revoke an OAuth connection",
    description:
      "Revokes the connection, its tokens and its agent key row: the client stops on its next request. Someone else's connection answers 404 to an editor.",
    input: { params: ParamId },
    output: { schema: z.object({ revoked: z.boolean() }) },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: async (e, { c }) => {
      const id = (e.params as { id: string }).id;
      const h = human(c);
      if (!(await visibleGrant(h, id)))
        return c.json({ error: "Connection not found", code: "KITSUDEN_E_NOT_FOUND" }, 404);
      await revokeGrant(id, h.id);
      return c.json({ revoked: true });
    },
  }),
];

export const oauthKon = {
  id: "kon-oauth",
  name: "OAuth for MCP (panel)",
  version: "1.0.0",
  mountPath: OAUTH_ROUTE,
  operations: oauthOperations,
};

registerCoreOperations({
  konId: "kon-oauth",
  mountPath: OAUTH_ROUTE,
  description:
    "Consent and connected-client management for OAuth MCP clients (human admins and editors only).",
  operations: oauthOperations,
});

const context = { auth: { requireAuth, optionalAuth } } as never;
export const oauthPanelRoutes = operationsRouter("kon-oauth", oauthOperations, context);
