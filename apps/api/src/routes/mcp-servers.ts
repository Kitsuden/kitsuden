/**
 * /api/admin/mcp-servers — external MCP servers and the review of their tools
 * ============================================================================
 *
 *   GET    /api/admin/mcp-servers                       the registry (never the auth header)
 *   POST   /api/admin/mcp-servers                       { name, url, authHeaderName?, authHeaderValue?, enabled? }
 *   PATCH  /api/admin/mcp-servers/:id                   same fields; `authHeaderName: null` removes it
 *   DELETE /api/admin/mcp-servers/:id
 *   POST   /api/admin/mcp-servers/:id/refresh           connects, reads tools/list, flags changes
 *   GET    /api/admin/mcp-servers/:id/tools             tools with fingerprint and review status
 *   POST   /api/admin/mcp-servers/:id/tools/approve     { name, fingerprint }: a person approves what they saw
 *
 * Core SDK operations (`kon-external-mcp`), outside MCP. HUMAN administrators
 * only: `requireAdminRole` and `humansOnly` (an agent, even with `admin`, does
 * not register servers or approve their tools: approving its own tools is
 * what the review exists to prevent). See lib/external-mcp.ts.
 */

import { defineOperation } from "@kitsuden/shared";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { operationsRouter, type AnyOperation } from "../../../../packages/engine/src/operations";
import { registerCoreOperations } from "../lib/core-operations";
import {
  approveTool,
  authHeaderProblem,
  createServer,
  deleteServer,
  FingerprintMismatch,
  getServer,
  listServers,
  listTools,
  refreshServer,
  serverUrlProblem,
  updateServer,
} from "../lib/external-mcp";
import { externalNaming, loadExternalCatalog } from "../lib/external-mcp-bridge";
import { logger } from "../lib/logger";
import { optionalAuth, requireAuth } from "../middleware/auth";
import { requireAdminRole } from "../middleware/auth-guard";

import { humansOnly } from "./approvals";

export const EXTERNAL_MCP_ROUTE = "/api/admin/mcp-servers";

const fromHumanAdmin = {
  access: "session" as const,
  permission: { roles: ["admin"] },
  before: [requireAdminRole as unknown as MiddlewareHandler, humansOnly],
  mcp: {
    exclude:
      "A human administrator registers external MCP servers and approves their tools; an agent must not approve the tools it would be given.",
  },
  tags: ["mcp-servers"],
};

const ParamId = z.object({ id: z.guid() });
const Obj = z.record(z.string(), z.unknown());
const ServerBody = z.object({
  name: z.string().min(1).max(200).optional(),
  url: z.string().min(1).max(2000).optional(),
  enabled: z.boolean().optional(),
  authHeaderName: z.string().max(64).nullable().optional(),
  authHeaderValue: z.string().max(8192).nullable().optional(),
});
type ServerBodyT = z.infer<typeof ServerBody>;

const notFound = (c: Context) =>
  c.json({ error: "MCP server not found", code: "KITSUDEN_E_NOT_FOUND" }, 404);
const badRequest = (c: Context, error: string) =>
  c.json({ error, code: "KITSUDEN_E_BAD_REQUEST" }, 400);

function who(c: Context): string {
  return ((c.get("user" as never) as { id?: string } | null)?.id ?? "admin").slice(0, 200);
}

/** The auth header pair: both or neither (null on both removes it). */
function authProblem(body: ServerBodyT): string | null {
  const { authHeaderName: name, authHeaderValue: value } = body;
  if (name === null || value === null) return null;
  if (name === undefined && value === undefined) return null;
  return authHeaderProblem(name, value);
}

export const externalMcpOperations: AnyOperation[] = [
  defineOperation({
    ...fromHumanAdmin,
    id: "list-mcp-servers",
    method: "GET",
    route: "/",
    summary: "External MCP servers (admin)",
    description:
      "The registered external MCP servers, with how many of their tools need review. Never the auth header.",
    output: { schema: z.object({ docs: z.array(Obj) }) },
    handle: async () => ({ docs: await listServers() }),
  }),
  defineOperation({
    ...fromHumanAdmin,
    id: "create-mcp-server",
    method: "POST",
    route: "/",
    summary: "Register an external MCP server (admin)",
    description:
      "Registers a Streamable HTTP MCP server. The URL must be https and resolve to public addresses. The auth header is stored encrypted and never returned. Nothing is connected until a refresh.",
    input: { body: ServerBody },
    output: { schema: Obj, status: 201 },
    errors: ["KITSUDEN_E_BAD_REQUEST"],
    handle: async ({ body }, { c }) => {
      const b = (body ?? {}) as ServerBodyT;
      if (!b.name?.trim() || !b.url) return badRequest(c, "name and url are required");
      const problem = serverUrlProblem(b.url) ?? authProblem(b);
      if (problem) return badRequest(c, problem);
      const server = await createServer({ ...b, name: b.name.trim(), url: b.url }, who(c));
      logger.info(
        { serverId: server.id, origin: new URL(server.url).origin },
        "[external-mcp] server registered"
      );
      return c.json(server, 201);
    },
  }),
  defineOperation({
    ...fromHumanAdmin,
    id: "update-mcp-server",
    method: "PATCH",
    route: "/:id",
    summary: "Change an external MCP server (admin)",
    description:
      "Changes name, URL, enabled flag or auth header (`authHeaderName: null` removes it). A new URL sends every tool back to review.",
    input: { params: ParamId, body: ServerBody },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_BAD_REQUEST"],
    handle: async ({ params, body }, { c }) => {
      const b = (body ?? {}) as ServerBodyT;
      if (b.name !== undefined && !b.name.trim()) return badRequest(c, "name cannot be empty");
      const problem = (b.url !== undefined ? serverUrlProblem(b.url) : null) ?? authProblem(b);
      if (problem) return badRequest(c, problem);
      const server = await updateServer((params as { id: string }).id, b, who(c));
      return server ?? notFound(c);
    },
  }),
  defineOperation({
    ...fromHumanAdmin,
    id: "delete-mcp-server",
    method: "DELETE",
    route: "/:id",
    summary: "Remove an external MCP server (admin)",
    description: "Removes the server, its tools and their approvals.",
    input: { params: ParamId },
    output: { schema: z.object({ success: z.boolean() }) },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: async ({ params }, { c }) =>
      (await deleteServer((params as { id: string }).id)) ? { success: true } : notFound(c),
  }),
  defineOperation({
    ...fromHumanAdmin,
    id: "refresh-mcp-server",
    method: "POST",
    route: "/:id/refresh",
    summary: "Read an external MCP server's tools (admin)",
    description:
      "Connects to the server, reads tools/list and stores a fingerprint of each tool (name, description, input schema). New, changed or removed tools are flagged needs_review until a person approves them.",
    input: { params: ParamId },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: async ({ params }, { c }) => {
      const r = await refreshServer((params as { id: string }).id);
      return r ?? notFound(c);
    },
  }),
  defineOperation({
    ...fromHumanAdmin,
    id: "list-mcp-server-tools",
    method: "GET",
    route: "/:id/tools",
    summary: "An external MCP server's tools (admin)",
    description:
      "Each tool with its description, input schema, current and approved fingerprint, and review status.",
    input: { params: ParamId },
    output: { schema: z.object({ docs: z.array(Obj) }) },
    errors: ["KITSUDEN_E_NOT_FOUND"],
    handle: async ({ params }, { c }) => {
      const id = (params as { id: string }).id;
      const server = await getServer(id);
      if (!server) return notFound(c);
      const offered = new Set(
        (await loadExternalCatalog()).entries
          .filter((e) => e.serverId === id)
          .map((e) => e.toolName)
      );
      // An approved tool also says how agents see it: `agentTool` = the name
      // (`ext_<server>_<tool>`), the scope they need and whether it is offered now.
      const docs = (await listTools(id)).map((t) =>
        t.status === "approved"
          ? {
              ...t,
              agentTool: { ...externalNaming(server.name, t.name), offered: offered.has(t.name) },
            }
          : { ...t, agentTool: null }
      );
      return { docs };
    },
  }),
  defineOperation({
    ...fromHumanAdmin,
    id: "approve-mcp-server-tool",
    method: "POST",
    route: "/:id/tools/approve",
    summary: "Approve an external MCP tool (admin, humans only)",
    description:
      "Approves a tool as reviewed: `fingerprint` must be the one shown (if the server changed it since, 409). Approving a removed tool forgets it.",
    input: {
      params: ParamId,
      body: z.object({ name: z.string().min(1).max(200), fingerprint: z.string().min(1).max(200) }),
    },
    output: { schema: Obj },
    errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    handle: async ({ params, body }, { c }) => {
      const id = (params as { id: string }).id;
      const { name, fingerprint } = body as { name: string; fingerprint: string };
      if (!(await getServer(id))) return notFound(c);
      try {
        const r = await approveTool(id, name, fingerprint, who(c));
        if (!r) return c.json({ error: "Tool not found", code: "KITSUDEN_E_NOT_FOUND" }, 404);
        logger.info(
          { serverId: id, tool: name, fingerprint, by: who(c) },
          "[external-mcp] tool approved"
        );
        return r as Record<string, unknown>;
      } catch (err) {
        if (err instanceof FingerprintMismatch) {
          return c.json({ error: err.message, code: "KITSUDEN_E_CONFLICT" }, 409);
        }
        throw err;
      }
    },
  }),
];

registerCoreOperations({
  konId: "kon-external-mcp",
  mountPath: EXTERNAL_MCP_ROUTE,
  description:
    "External MCP servers and the human review of their tools (human administrators only).",
  operations: externalMcpOperations,
});

const context = { auth: { requireAuth, optionalAuth } } as never;
export const externalMcpRoutes = operationsRouter(
  "kon-external-mcp",
  externalMcpOperations,
  context
);
