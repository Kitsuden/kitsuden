/**
 * MCP (Model Context Protocol) Routes — Agent Gateway
 *
 * Exposes Kitsuden to AI agents (Claude, Cursor, VS Code, etc.)
 * via the standard MCP protocol over Streamable HTTP (SSE + POST).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SECURITY: All MCP connections require a valid Agent NHI token (kitsuden_agent_*)
 * or a legacy API key (kitsuden_sk_* — deprecated, sunset 2026-08-01).
 * Agents must have the 'mcp:connect' scope. MCP tools can insert, query,
 * and dispatch jobs.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Endpoints:
 *   GET  /api/mcp      - SSE connection for agents (requires Bearer token)
 *   POST /api/mcp      - JSON-RPC messages from agent (requires sessionId)
 *
 * Result format:
 *   Tool results come in the shortest LOSSLESS format for each result (compact
 *   JSON, TOON or TRON; `format: "auto"`, the default) and say which in
 *   `_meta["kitsuden/format"]`. `format: "json"` forces compact JSON. The same
 *   choice is available on REST with `Accept: application/vnd.kitsuden.auto`
 *   (lib/formats.ts, docs/agents/benchmarks.md).
 *
 * Provenance (docs/agents/untrusted-content.md):
 *   Results that carry stored records say who wrote each one in
 *   `_meta["kitsuden/provenance"]` (user | agent | system | anonymous, and
 *   `untrusted`). Text written by others can be wrapped (`untrusted_wrap`
 *   argument or the agent's setting in the panel); default `none`.
 *
 * Toolsets (lib/mcp-settings.ts):
 *   `GET /api/mcp?toolset=read,kon:blog` (or the agent's preset in the panel)
 *   narrows what `tools/list` announces and `tools/call` accepts. It is
 *   intersected with `allowedTools` and the scopes: it never grants anything.
 *
 * External MCP tools (lib/external-mcp-bridge.ts):
 *   `ext_<server>_<tool>`: tools of external MCP servers a person approved,
 *   offered only to agents with an explicit `mcp-external:<server>:<tool>`
 *   scope (`admin` does not grant them). Each call checks the fingerprint with
 *   the server again, is a write (approval and quota) and returns untrusted,
 *   wrapped text.
 *
 * Reference: https://spec.modelcontextprotocol.io/specification/2024-11-05/
 */

import { createHash } from "crypto";

import { listMCPTools, executeMCPTool, messageOf } from "@kitsuden/engine";
import { schemaFields, concedeScope } from "@kitsuden/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db";
import { dataSets, apiKeys } from "../db/schema";
import {
  DECISION_TOOL,
  DECISION_TOOL_DEFINITION,
  InvalidDecision,
  decisionView,
  parseDecision,
  recordDecision,
} from "../lib/agent-decisions";
import { summarizeCall } from "../lib/agent-friction";
import { consumeQuota, quotaProblem } from "../lib/agent-quotas";
import {
  setApprovalsMcpExecutor,
  proposalById,
  agentView,
  UNATTENDED_HEADER,
  unattendedHeader,
} from "../lib/approvals";
import { STATUS_TOOL_DEFINITION, STATUS_TOOL, holdToolIfNeeded } from "../lib/approvals-mcp";
import { clientIp } from "../lib/client-ip";
import {
  callExternalTool,
  externalToolDefinition,
  externalToolsFor,
  isExternalToolName,
  resolveExternalTool,
  type ExternalToolEntry,
} from "../lib/external-mcp-bridge";
import { measureFormat } from "../lib/format-measure";
import { registerSavings } from "../lib/format-savings";
import { META_FORMAT, autoResult, type Format } from "../lib/formats";
import { logger } from "../lib/logger";
import {
  inAll,
  parseToolset,
  toolsetText,
  type McpSettings,
  type ToolCard,
  type Toolset,
} from "../lib/mcp-settings";
import {
  runOperationTool,
  isToolRepetition,
  operationToolCard,
  operationTools,
  operationToolUsage,
  readGuide,
  guideResources,
} from "../lib/operations-mcp";
import { withProblem, errorJsonRpc, exceptionProblem, errorResult } from "../lib/problems-mcp";
import { META_PROVENANCE, type Provenance } from "../lib/provenance";
import { logAgentAction } from "../services/agent-audit";
import {
  authenticateAgent,
  requestAuthentication,
  isAgentCredential,
  hasScope,
  type AgentAuthContext,
} from "../services/agent-auth";
import {
  agentCanReadDataset,
  assertToolScope,
  writingTool,
  dataCoreTool,
  readOnlyCoreTool,
  listHardcodedMCPTools,
  executeHardcodedToolWithFormat,
} from "../services/mcp-tools";
import { KON_REGISTRY } from "../services/module-registry";

import { invalidateGraphQLCache } from "./graphql";

// ── Code Generators ──

// ── Level 1 Actions Engine ──

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface McpSession {
  /** The human who approved this call, when it replays a held proposal. */
  approvedBy?: string;
  agentId: string; // machine-{apiKeyId}
  agentName: string; // API key name (e.g. "Claude Desktop")
  apiKeyId: string; // For audit trail
  createdAt: number; // Timestamp
  lastActivity: number; // For session cleanup
  /**
   * The agent's scopes and allowed tools. They are REFRESHED on every POST with
   * that request's authentication: revoking a scope or a key takes
   * effect on the next message, not when the session expires. Before, the session
   * did not store them and tools were checked against an empty list.
   */
  scopes: string[];
  allowedTools: string[];
  /** The agent's human signer, refreshed on every POST. */
  sponsor?: AgentAuthContext["sponsor"];
  /** The agent's quotas, refreshed on every POST like the scopes. */
  rateLimit?: number | null;
  writesPerDay?: number | null;
  budgetUnitsPerDay?: number | null;
  /**
   * Toolset chosen on CONNECT (`?toolset=`); it does not change during the session.
   * `toolsets` = [the agent's preset (re-read on every POST), the one from the URL]:
   * a tool has to be in all of them (lib/mcp-settings.ts).
   */
  connectionToolset?: Toolset;
  toolsets?: Toolset[];
  /** Wrapper for the agent's untrusted content (panel), refreshed on every POST. */
  untrustedWrap?: McpSettings["untrustedWrap"];
  /** `Kitsuden-Unattended: true` on THIS POST: nobody waits (lib/approvals.ts). */
  unattended?: boolean;
}

interface AgentLogEntry {
  timestamp: string;
  agentId: string;
  agentName: string;
  method: string;
  tool?: string;
  resource?: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// Session Store
// NOTE: In-memory sessions are lost on restart. For multi-instance
// deployments, migrate to Valkey: HSET kitsuden:mcp:sessions {id} {json}
// ═══════════════════════════════════════════════════════════════

const sessions = new Map<string, McpSession>();

/**
 * Sessions open at the same time, per key and in total (security audit): the
 * map had no cap and every GET leaves an SSE open, so a valid key
 * exhausted memory and connections by opening thousands.
 */
const MAX_SESSIONS_PER_KEY = 20;
const MAX_SESSIONS = 2000;

// Periodic cleanup of stale sessions (older than 1 hour)
const SESSION_TTL_MS = 60 * 60 * 1000;
setInterval(
  () => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        sessions.delete(id);
        logger.info({ sessionId: id, agentName: session.agentName }, "MCP session expired");
      }
    }
  },
  5 * 60 * 1000
); // Check every 5 minutes

// ═══════════════════════════════════════════════════════════════
// Agent Activity Log (in-memory ring buffer, last 1000 entries)
// For production: export to OpenTelemetry / Grafana / Loki
// ═══════════════════════════════════════════════════════════════

const MAX_LOG_ENTRIES = 1000;
const agentLog: AgentLogEntry[] = [];

function logAgentActivity(entry: AgentLogEntry): void {
  agentLog.push(entry);
  if (agentLog.length > MAX_LOG_ENTRIES) {
    agentLog.shift();
  }
  logger.info(
    {
      agent: entry.agentName,
      method: entry.method,
      tool: entry.tool,
      resource: entry.resource,
      durationMs: entry.durationMs,
      success: entry.success,
    },
    `MCP ${entry.method}${entry.tool ? ` → ${entry.tool}` : ""}`
  );
}

// ═══════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════

const mcpRoutes = new Hono();

// ═══════════════════════════════════════════════════════════════
// Auth Middleware — Supports Human API Keys & Agent Identities (NHI)
// ═══════════════════════════════════════════════════════════════

interface McpAuthContext {
  type: "human" | "agent";
  agentId: string;
  agentName: string;
  apiKeyId: string;
  scopes: string[]; // For agent NHI (empty for legacy keys)
  allowedTools: string[]; // Empty = no list: each tool's scope decides
  rateLimit?: number; // For agent NHI
  sponsor?: AgentAuthContext["sponsor"];
  writesPerDay?: number | null;
  budgetUnitsPerDay?: number | null;
  mcpSettings?: McpSettings;
}

declare module "hono" {
  interface ContextVariableMap {
    mcpAuth: McpAuthContext;
  }
}

mcpRoutes.use("*", async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return c.json(
      errorJsonRpc(
        -32000,
        "Unauthorized. MCP requires a valid API key in Authorization header.",
        null,
        "KITSUDEN_E_UNAUTHENTICATED"
      ),
      401
    );
  }

  const rawToken = authHeader.replace("Bearer ", "").trim();

  // ═══════════════════════════════════════════════════════════════
  // Try to authenticate as an NHI Agent first (kitsuden_agent_xxx)
  // ═══════════════════════════════════════════════════════════════
  // Static key (kitsuden_agent_*) or OAuth token (kitsuden_oat_*, 0055):
  // both give the same agent context (services/agent-auth.ts).
  if (isAgentCredential(rawToken)) {
    // The global authentication already verified THIS token in this request: it is
    // reused (a single verification and a single audit row).
    const result =
      requestAuthentication(c.req.raw, rawToken) ??
      (await authenticateAgent(rawToken, {
        ipAddress: clientIp(c),
        userAgent: c.req.header("user-agent"),
        route: c.req.path,
      }));

    if (!result.success || !result.context) {
      // The key could not be checked (database unavailable): 503, not "invalid key"
      if (result.code === "AUTH_ERROR") {
        c.header("Retry-After", "5");
        return c.json(
          errorJsonRpc(
            -32000,
            "Authentication is temporarily unavailable.",
            null,
            "KITSUDEN_E_UNAVAILABLE"
          ),
          503
        );
      }
      return c.json(
        errorJsonRpc(
          -32000,
          result.error || "Invalid agent API key.",
          null,
          "KITSUDEN_E_UNAUTHENTICATED"
        ),
        401
      );
    }

    const agentContext = result.context;

    // Check that the agent has the scope for MCP
    if (!hasScope(agentContext, "mcp:connect")) {
      return c.json(
        errorJsonRpc(
          -32000,
          "Agent does not have MCP scope. Required: mcp:connect",
          null,
          "KITSUDEN_E_FORBIDDEN"
        ),
        403
      );
    }

    c.set("mcpAuth", {
      type: "agent",
      agentId: agentContext.agentId,
      agentName: agentContext.agentName,
      apiKeyId: agentContext.keyId,
      scopes: agentContext.scopes,
      allowedTools: agentContext.allowedTools,
      rateLimit: agentContext.rateLimit,
      sponsor: agentContext.sponsor ?? null,
      writesPerDay: agentContext.writesPerDay,
      budgetUnitsPerDay: agentContext.budgetUnitsPerDay,
      mcpSettings: agentContext.mcpSettings ?? {},
    });

    logger.info(
      {
        agentId: agentContext.agentId,
        agentName: agentContext.agentName,
        type: "agent",
      },
      "MCP agent authenticated"
    );

    await next();
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // Fallback: Legacy Human API Key (kitsuden_sk_xxx) — DEPRECATED
  // Migrate to Agent NHI tokens (kitsuden_agent_xxx) before 2026-08-01.
  // ═══════════════════════════════════════════════════════════════
  if (!rawToken.startsWith("kitsuden_sk_")) {
    return c.json(
      errorJsonRpc(
        -32000,
        "Invalid API key format. Expected: kitsuden_agent_xxx (new) or kitsuden_sk_xxx (deprecated)",
        null,
        "KITSUDEN_E_UNAUTHENTICATED"
      ),
      401
    );
  }

  const keyHash = createHash("sha256").update(rawToken).digest("hex");

  const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);

  if (!apiKey) {
    return c.json(
      errorJsonRpc(-32000, "Invalid API key.", null, "KITSUDEN_E_UNAUTHENTICATED"),
      401
    );
  }

  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return c.json(
      errorJsonRpc(-32000, "API key expired.", null, "KITSUDEN_E_UNAUTHENTICATED"),
      401
    );
  }

  // Update lastUsedAt (fire and forget)
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, apiKey.id))
    .execute()
    .catch(() => {});

  // Deprecation warnings
  logger.warn(
    { keyId: apiKey.id, type: "mcp" },
    "[DEPRECATION] Legacy API key (kitsuden_sk_*) used in MCP. Migrate to Agent NHI (kitsuden_agent_*)."
  );
  c.header("Deprecation", "kitsuden_sk_*; kitsuden_agent_*");
  c.header("Sunset", "2026-08-01");

  c.set("mcpAuth", {
    type: "human",
    agentId: `machine-${apiKey.id}`,
    agentName: apiKey.name,
    apiKeyId: apiKey.id,
    // Legacy keys have no scopes: they connect, but do not run
    // tools. That is what the migration to kitsuden_agent_* is for.
    scopes: [],
    allowedTools: [],
  });

  logger.info(
    {
      agentId: `machine-${apiKey.id}`,
      agentName: apiKey.name,
      type: "human",
    },
    "MCP legacy human user authenticated"
  );

  await next();
});

/**
 * GET /api/mcp — SSE Endpoint
 *
 * Agents connect here to establish an MCP session.
 * The server sends an `endpoint` event with the POST URL for messages.
 */
mcpRoutes.get("/", async (c) => {
  // Streamable HTTP (2025-03-26+): a client with `Mcp-Session-Id` asks here
  // for the server's notification stream, which does not exist. 405 is the response the
  // specification foresees for that (the client carries on with POST only).
  if (c.req.header("mcp-session-id")) {
    c.header("Allow", "POST");
    return c.body(null, 405);
  }
  const sessionId = crypto.randomUUID();
  const auth = c.get("mcpAuth") as McpAuthContext;

  let ofThisKey = 0;
  for (const s of sessions.values()) if (s.apiKeyId === auth.apiKeyId) ofThisKey++;
  if (ofThisKey >= MAX_SESSIONS_PER_KEY || sessions.size >= MAX_SESSIONS) {
    return c.json(
      errorJsonRpc(
        -32000,
        "Too many open MCP sessions for this key.",
        null,
        "KITSUDEN_E_RATE_LIMITED",
        {
          hint: `Close unused sessions (limit ${MAX_SESSIONS_PER_KEY} per key).`,
        }
      ),
      429
    );
  }

  // Toolset requested on connect: an unknown name is a 400 (better than
  // a whole list, or an empty one, with no idea why).
  const request = parseToolset(c.req.query("toolset"));
  if (!request.ok) {
    return c.json(errorJsonRpc(-32602, request.error, null, "KITSUDEN_E_VALIDATION"), 400);
  }

  const session: McpSession = {
    agentId: auth.agentId,
    agentName: auth.agentName,
    apiKeyId: auth.apiKeyId,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    scopes: auth.scopes,
    allowedTools: auth.allowedTools,
    connectionToolset: request.toolset,
  };
  refreshSettings(session, auth.mcpSettings);
  sessions.set(sessionId, session);

  logger.info(
    {
      sessionId,
      agentName: auth.agentName,
      type: auth.type,
      toolset: toolsetText(request.toolset),
    },
    "MCP session created"
  );

  const messageEndpoint = `/api/mcp?sessionId=${sessionId}`;

  const stream = new ReadableStream({
    start(controller) {
      // MCP spec: send endpoint event
      controller.enqueue(new TextEncoder().encode(`event: endpoint\ndata: ${messageEndpoint}\n\n`));

      // Keepalive every 30s
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(":keepalive\n\n"));
        } catch {
          clearInterval(keepAlive);
        }
      }, 30000);

      c.req.raw.signal.addEventListener("abort", () => {
        clearInterval(keepAlive);
        sessions.delete(sessionId);
        logger.info({ sessionId, agentName: auth.agentName }, "MCP session closed");
      });
    },
    cancel() {
      sessions.delete(sessionId);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-MCP-Session": sessionId,
    },
  });
});

/**
 * POST /api/mcp — JSON-RPC Message Endpoint
 *
 * Agents send MCP commands here after establishing a session via SSE.
 */
mcpRoutes.post("/", async (c) => {
  // HTTP+SSE (2024-11-05) sends `?sessionId=`; Streamable HTTP, the
  // `Mcp-Session-Id` header (the one returned on `initialize`).
  const sessionId = c.req.query("sessionId") ?? c.req.header("mcp-session-id");
  let session = sessionId ? sessions.get(sessionId) : undefined;
  if (!sessionId) {
    // Streamable HTTP: `initialize` without a session OPENS one (current
    // MCP clients —Claude Code, Inspector, SDK— do not open the SSE GET first).
    const open = await openStreamableSession(c);
    if (open instanceof Response) return open;
    if (open) {
      session = open.session;
      c.header("Mcp-Session-Id", open.id);
    }
  }

  if (!session) {
    return c.json(
      errorJsonRpc(
        -32000,
        "Invalid or expired session. Connect via GET /api/mcp first.",
        null,
        "KITSUDEN_E_BAD_REQUEST",
        { hint: "Open GET /api/mcp (SSE) and POST to the endpoint it announces." }
      ),
      400
    );
  }

  // The session belongs to the key that opened it. Another valid key that knows the
  // sessionId cannot speak for it (or inherit its scopes): it is answered
  // the same as a nonexistent session, so as not to confirm that it exists.
  const auth = c.get("mcpAuth") as McpAuthContext;
  if (auth.apiKeyId !== session.apiKeyId) {
    return c.json(
      errorJsonRpc(
        -32000,
        "Invalid or expired session. Connect via GET /api/mcp first.",
        null,
        "KITSUDEN_E_BAD_REQUEST",
        { hint: "Open GET /api/mcp (SSE) and POST to the endpoint it announces." }
      ),
      400
    );
  }

  // The scopes of the moment, not those of the connection: a revocation applies now
  session.scopes = auth.scopes;
  session.allowedTools = auth.allowedTools;
  session.sponsor = auth.sponsor ?? null;
  session.rateLimit = auth.rateLimit ?? null;
  session.writesPerDay = auth.writesPerDay ?? null;
  session.budgetUnitsPerDay = auth.budgetUnitsPerDay ?? null;
  // The toolset preset and the panel wrapper apply now, like the scopes
  refreshSettings(session, auth.mcpSettings);
  // Per message, not per session: the same client may be attended or not.
  session.unattended = unattendedHeader(c.req.header(UNATTENDED_HEADER));

  // Update last activity
  session.lastActivity = Date.now();

  // A body that is not JSON is a JSON-RPC "parse error", not a 500.
  const body = await c.req.json().catch(() => undefined);
  if (!body || typeof body !== "object") {
    return c.json(
      errorJsonRpc(-32700, "Parse error: the body must be a JSON-RPC object.", null),
      400
    );
  }
  const start = Date.now();

  try {
    // What the `auto` format saved in this call (panel → quotas).
    const { value: result, measure: measure } = await measureFormat(() =>
      handleMcpMessage(body, session)
    );
    if (isNhiAgent(session)) registerSavings(session.agentId, "mcp", measure);
    auditCall(session, body, result, Date.now() - start);

    logAgentActivity({
      timestamp: new Date().toISOString(),
      agentId: session.agentId,
      agentName: session.agentName,
      method: body.method,
      tool: body.method === "tools/call" ? body.params?.name : undefined,
      resource: body.method === "resources/read" ? body.params?.uri : undefined,
      durationMs: Date.now() - start,
      success: true,
    });

    if (result === null) {
      // Notifications (like "initialized") don't need a response
      return c.body(null, 204);
    }
    return c.json(result);
  } catch (err: unknown) {
    const response = errorJsonRpc(-32603, messageOf(err), body.id || null);
    auditCall(session, body, response, Date.now() - start);
    logAgentActivity({
      timestamp: new Date().toISOString(),
      agentId: session.agentId,
      agentName: session.agentName,
      method: body.method,
      tool: body.method === "tools/call" ? body.params?.name : undefined,
      durationMs: Date.now() - start,
      success: false,
      error: messageOf(err),
    });

    return c.json(response, 500);
  }
});

/**
 * Every `tools/call` of an agent is recorded in `agent_audit_logs` (`tool_call`).
 * Before it only went to the in-memory buffer above: it was lost on restart and the
 * friction report (`GET /api/admin/agents/friction`) had nothing to
 * feed on. The argument NAMES are stored, never their values.
 * Asynchronous: it does not delay the response.
 */
function auditCall(session: McpSession, body: any, response: unknown, durationMs: number): void {
  if (body?.method !== "tools/call" || !isNhiAgent(session)) return;
  const name = typeof body.params?.name === "string" ? body.params.name : "(no name)";
  const summary = summarizeCall(response, body.params?.arguments);
  logAgentAction({
    agentId: session.agentId,
    keyId: session.apiKeyId,
    action: "tool_call",
    resource: name,
    details: { origin: "mcp", ...summary },
    durationMs,
    success: summary.success,
    errorMessage: summary.code && !summary.success ? summary.code : undefined,
  });
}

/**
 * GET /api/mcp/logs — Agent activity log (admin only)
 */
mcpRoutes.get("/logs", async (c) => {
  // It said "admin only" and `mcp:connect` was enough: any agent read
  // the activity of all the others (security audit).
  const auth = c.get("mcpAuth") as McpAuthContext;
  if (!concedeScope(auth.scopes, "admin")) {
    return c.json(
      errorJsonRpc(-32000, "Requires the 'admin' scope.", null, "KITSUDEN_E_FORBIDDEN"),
      403
    );
  }
  const limit = Math.min(Number(c.req.query("limit")) || 100, MAX_LOG_ENTRIES);
  const agentFilter = c.req.query("agent");

  let entries = agentLog.slice(-limit);
  if (agentFilter) {
    entries = entries.filter((e) => e.agentName.includes(agentFilter));
  }

  return c.json({
    entries: entries.reverse(),
    total: agentLog.length,
    activeSessions: sessions.size,
    sessionDetails: Array.from(sessions.entries()).map(([id, s]) => ({
      sessionId: id,
      agentName: s.agentName,
      connectedAt: new Date(s.createdAt).toISOString(),
      lastActivity: new Date(s.lastActivity).toISOString(),
    })),
  });
});

// ═══════════════════════════════════════════════════════════════
// MCP Protocol Handler
// ═══════════════════════════════════════════════════════════════

async function handleMcpMessage(message: any, session: McpSession) {
  const { method, params, id } = message;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            resources: { listChanged: true },
            tools: { listChanged: true },
          },
          serverInfo: {
            name: "kitsuden-mcp-server",
            version: "0.7.0-beta",
          },
        },
        id,
      };

    case "initialized":
      return null;

    case "ping":
      return { jsonrpc: "2.0", result: {}, id };

    case "resources/list":
      return await listResources(id, session);

    case "resources/read":
      return await readResource(params?.uri, id, session);

    case "tools/list":
      return await listTools(id, session);

    case "tools/call":
      return await executeTool(params?.name, params?.arguments, id, session);

    default:
      return errorJsonRpc(-32601, `Method not found: ${method}`, id);
  }
}

// ═══════════════════════════════════════════════════════════════
// Resources
// ═══════════════════════════════════════════════════════════════

/**
 * The datasets THIS session can read (the same rule as the
 * tools). Before, resources listed all of them, with their schema and their
 * `policyJson`, to any agent with `mcp:connect` (security audit).
 */
async function visibleDatasets(session: McpSession) {
  const all = await db.select().from(dataSets);
  return all.filter((ds) => agentCanReadDataset(session, ds));
}

async function listResources(id: string | number, session: McpSession) {
  const allDatasets = await visibleDatasets(session);

  const resources = [
    {
      uri: "kitsuden://datasets",
      name: "All Datasets",
      mimeType: "application/json",
      description: `List of all ${allDatasets.length} datasets with their schemas`,
    },
    {
      uri: "kitsuden://kons",
      name: "Active Kons",
      mimeType: "application/json",
      description: "Active modules (blog, CRM, DMS, etc.) and their mount points",
    },
    // Individual dataset resources
    ...allDatasets.map((ds) => ({
      uri: `kitsuden://dataset/${ds.id}`,
      name: `Dataset: ${ds.name}`,
      mimeType: "application/json",
      description: `Schema and metadata for ${ds.name} (${ds.slug})`,
    })),
    // The guide of each SDK tool that declares one (and this session sees)
    ...(await guideResources(session)),
  ];

  return { jsonrpc: "2.0", result: { resources }, id };
}

async function readResource(uri: string, id: string | number, session: McpSession) {
  try {
    const guide = typeof uri === "string" ? await readGuide(uri, session) : null;
    if (guide !== null) {
      return {
        jsonrpc: "2.0",
        result: { contents: [{ uri, mimeType: "text/markdown", text: guide }] },
        id,
      };
    }

    if (uri === "kitsuden://datasets") {
      const allDatasets = await visibleDatasets(session);
      const mapped = allDatasets.map((ds: any) => ({
        id: ds.id,
        name: ds.name,
        slug: ds.slug,
        description: ds.description,
        fields: schemaFields(ds.schema),
        entryCount: ds.entryCount || 0,
      }));

      return jsonRpcResult(uri, mapped, id);
    }

    if (uri === "kitsuden://kons") {
      // Return actual kon registry instead of hardcoded stub
      const kons = KON_REGISTRY.map((g) => ({
        key: g.key,
        name: g.name,
        description: g.description,
        icon: g.icon,
        category: g.category,
        tables: g.tables,
        grimoireId: g.grimoireId || null,
      }));

      return jsonRpcResult(uri, kons, id);
    }

    // Individual dataset: kitsuden://dataset/{id}
    const datasetMatch = uri.match(/^kitsuden:\/\/dataset\/(.+)$/);
    if (datasetMatch) {
      const [dataset] = await db
        .select()
        .from(dataSets)
        .where(eq(dataSets.id, datasetMatch[1]))
        .limit(1);

      // Whoever cannot read does not exist for this session
      if (!dataset || !agentCanReadDataset(session, dataset)) {
        return jsonRpcError(-32002, `Dataset not found: ${datasetMatch[1]}`, id);
      }

      return jsonRpcResult(
        uri,
        {
          id: dataset.id,
          name: dataset.name,
          slug: dataset.slug,
          description: dataset.description,
          schema: dataset.schema,
        },
        id
      );
    }

    return jsonRpcError(-32002, `Unknown resource: ${uri}`, id);
  } catch (err: unknown) {
    // The detail (it may be SQL) goes to the log, not to the agent
    logger.warn({ err, uri }, "MCP resources/read failed");
    return jsonRpcError(-32603, "Resource read failed", id);
  }
}

// ═══════════════════════════════════════════════════════════════
// Tools
// ═══════════════════════════════════════════════════════════════

/**
 * Can this session use the tool? With a list of allowed tools
 * on the agent (panel), only those; without a list, all of them, and each one's
 * scope decides when it runs.
 */
function allowedTool(session: McpSession, name: string): boolean {
  if (session.allowedTools.length > 0 && !session.allowedTools.includes(name)) return false;
  const toolsets = session.toolsets ?? [];
  return toolsets.length === 0 || inAll(toolsets, cardOf(name));
}

/** The agent's preset (panel) is re-read on every request; the URL one stays. */
/**
 * Streamable HTTP: a POST `initialize` without a session opens one, with the same
 * per-key caps as the SSE GET. `null` if the body is not an
 * `initialize` (it carries on and answers "invalid session", as always).
 */
async function openStreamableSession(
  c: import("hono").Context
): Promise<{ id: string; session: McpSession } | Response | null> {
  const body = (await c.req.raw
    .clone()
    .json()
    .catch(() => null)) as { method?: unknown } | null;
  if (!body || typeof body !== "object" || Array.isArray(body) || body.method !== "initialize")
    return null;
  const auth = c.get("mcpAuth") as McpAuthContext;
  let ofThisKey = 0;
  for (const s of sessions.values()) if (s.apiKeyId === auth.apiKeyId) ofThisKey++;
  if (ofThisKey >= MAX_SESSIONS_PER_KEY || sessions.size >= MAX_SESSIONS) {
    return c.json(
      errorJsonRpc(
        -32000,
        "Too many open MCP sessions for this key.",
        null,
        "KITSUDEN_E_RATE_LIMITED",
        {
          hint: `Close unused sessions (limit ${MAX_SESSIONS_PER_KEY} per key).`,
        }
      ),
      429
    );
  }
  const request = parseToolset(c.req.query("toolset"));
  if (!request.ok) {
    return c.json(errorJsonRpc(-32602, request.error, null, "KITSUDEN_E_VALIDATION"), 400);
  }
  const id = crypto.randomUUID();
  const session: McpSession = {
    agentId: auth.agentId,
    agentName: auth.agentName,
    apiKeyId: auth.apiKeyId,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    scopes: auth.scopes,
    allowedTools: auth.allowedTools,
    connectionToolset: request.toolset,
  };
  refreshSettings(session, auth.mcpSettings);
  sessions.set(id, session);
  logger.info(
    { sessionId: id, agentName: auth.agentName, type: auth.type, transport: "streamable-http" },
    "MCP session created"
  );
  return { id, session };
}

function refreshSettings(session: McpSession, settings: McpSettings | undefined): void {
  const preset = parseToolset(settings?.toolset);
  // Those that do not restrict (`all`) need not be checked on every tool
  session.toolsets = [
    ...(preset.ok ? [preset.toolset] : []),
    ...(session.connectionToolset ? [session.connectionToolset] : []),
  ].filter((t) => !t.all);
  session.untrustedWrap = settings?.untrustedWrap;
}

/** Where a tool falls for the toolsets (lib/mcp-settings.ts). */
function cardOf(name: string): ToolCard {
  if (name === STATUS_TOOL) return { name, source: "proposals", readOnly: true };
  // Like the status tool, in every toolset: recording that it did NOT act must
  // always be possible (lib/agent-decisions.ts).
  if (name === DECISION_TOOL) return { name, source: "proposals", readOnly: false };
  const sdk = operationToolCard(name);
  if (sdk) return { name, source: "kon", kon: sdk.kon, readOnly: sdk.readOnly };
  if (listMCPTools().some((t) => t.name === name))
    return { name, source: "action", readOnly: false };
  // Annotations of an external tool are not trusted: never read-only.
  if (isExternalToolName(name)) return { name, source: "external", readOnly: false };
  return {
    name,
    source: "core",
    readOnly: readOnlyCoreTool(name),
    isDataTool: dataCoreTool(name),
  };
}

async function listTools(id: string | number, session: McpSession) {
  // Dynamically retrieve tools from the Actions engine
  const dynamicTools = listMCPTools().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema || { type: "object", properties: {} },
  }));

  const hardcodedTools = listHardcodedMCPTools().map((t) => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: t.function.parameters,
  }));

  // Kon SDK: one tool per declared operation, with the same
  // schema as its REST route. They already come filtered by `allowedTools` and by
  // the session's scopes (see lib/operations-mcp.ts).
  const ofOperations = (await operationTools(session))
    .filter((t) => !session.toolsets?.length || inAll(session.toolsets, cardOf(t.name)))
    .map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    }));

  // The query for its proposals (it only reads its own). With a list of
  // allowed tools, only if it is in it (GET /api/proposals/{id}
  // always works over REST).
  // Approved tools of external MCP servers this agent has an explicit scope for
  // (never with `admin` alone), narrowed by `allowedTools` and the toolsets.
  const taken = new Set([...dynamicTools, ...hardcodedTools].map((t) => t.name));
  const ofExternal = isNhiAgent(session)
    ? (await externalToolsFor(session))
        .filter((e) => !taken.has(e.exposedName) && allowedTool(session, e.exposedName))
        .map(externalToolDefinition)
    : [];

  const ofApproval = [
    ...(isNhiAgent(session) && allowedTool(session, STATUS_TOOL) ? [STATUS_TOOL_DEFINITION] : []),
    ...(isNhiAgent(session) && allowedTool(session, DECISION_TOOL)
      ? [DECISION_TOOL_DEFINITION]
      : []),
  ];

  return {
    jsonrpc: "2.0",
    result: {
      // Only those this agent can call: announcing the others invites failure
      tools: [
        ...[...dynamicTools, ...hardcodedTools].filter((t) => allowedTool(session, t.name)),
        ...ofOperations,
        ...ofExternal,
        ...ofApproval,
      ],
    },
    id,
  };
}

/** A real agent (not a legacy `kitsuden_sk_*` key). */
function isNhiAgent(session: McpSession): boolean {
  return Boolean(session.agentId) && !session.agentId.startsWith("machine-");
}

/** `kitsuden_proposal_status`: the status of ONE proposal of this agent. */
async function proposalStatus(args: unknown, id: string | number, session: McpSession) {
  const request = (args as { proposal_id?: unknown } | null)?.proposal_id;
  const proposalId = typeof request === "string" ? request : "";
  const p = isNhiAgent(session) ? await proposalById(proposalId) : null;
  // Another agent's does not exist for this one.
  if (!p || p.agentId !== session.agentId) {
    return jsonRpcError(
      -32602,
      `Proposal not found: ${proposalId || "(missing proposal_id)"}`,
      id,
      "KITSUDEN_E_NOT_FOUND"
    );
  }
  const view = agentView(p);
  return {
    jsonrpc: "2.0",
    result: {
      content: [{ type: "text", text: JSON.stringify(view) }],
      structuredContent: view,
    },
    id,
  };
}

/** `kitsuden_record_decision`: what this agent chose NOT to do, and why. */
async function recordDecisionTool(args: unknown, id: string | number, session: McpSession) {
  if (!isNhiAgent(session)) {
    return jsonRpcError(-32602, "Only an agent records decisions.", id, "KITSUDEN_E_FORBIDDEN");
  }
  let input;
  try {
    input = parseDecision(args ?? {});
  } catch (err) {
    if (err instanceof InvalidDecision) {
      return jsonRpcError(-32602, err.message, id, "KITSUDEN_E_VALIDATION");
    }
    throw err;
  }
  const view = decisionView(await recordDecision(session.agentId, input, "mcp"));
  return {
    jsonrpc: "2.0",
    result: {
      content: [
        {
          type: "text",
          text: `Recorded decision ${view.id}: a person can see it in the panel. ${JSON.stringify(view)}`,
        },
      ],
      structuredContent: view,
    },
    id,
  };
}

/** What changes when running an ALREADY approved proposal (see lib/approvals.ts). */
interface ExecutionOptions {
  approval?: { proposalId: string; approvedBy: string };
}

async function executeTool(
  name: string,
  args: any,
  id: string | number,
  session: McpSession,
  options: ExecutionOptions = {}
) {
  if (!allowedTool(session, name)) {
    return jsonRpcError(
      -32602,
      `Tool '${name}' is not in this agent's allowed tools.`,
      id,
      "KITSUDEN_E_FORBIDDEN"
    );
  }
  if (name === STATUS_TOOL) return proposalStatus(args, id, session);
  // Never held and no write quota: see lib/agent-decisions.ts.
  if (name === DECISION_TOOL) return recordDecisionTool(args, id, session);
  // An external MCP tool: resolved (catalog, explicit scope) BEFORE spending
  // quota or proposing it; refused here if this agent cannot call it.
  let external: ExternalToolEntry | null = null;
  if (isExternalToolName(name) && !listMCPTools().some((t) => t.name === name)) {
    const r = isNhiAgent(session)
      ? await resolveExternalTool(name, session.scopes)
      : ({
          ok: false,
          code: "KITSUDEN_E_FORBIDDEN",
          message: "Only an agent calls external tools.",
        } as const);
    if (!r.ok) {
      return jsonRpcError(-32602, r.message, id, r.code);
    }
    external = r.entry;
  }
  // Daily quota: each tool spends its write and its
  // units. The HTTP request that carries it already counted toward the minute.
  let returnQuota: (() => Promise<void>) | null = null;
  if (
    !options.approval &&
    session.agentId &&
    !session.agentId.startsWith("machine-") &&
    // A repeat (same idempotency_key and arguments) spends nothing.
    !(await isToolRepetition(name, args, session.agentId))
  ) {
    const ofTheSdk = operationToolUsage(name);
    const write = ofTheSdk
      ? ofTheSdk.write
      : // External tools always count as a write: their annotations are not trusted.
        listMCPTools().some((t) => t.name === name) || writingTool(name) || external !== null;
    const quota = await consumeQuota(
      {
        agentId: session.agentId,
        rateLimit: null,
        writesPerDay: session.writesPerDay ?? null,
        budgetUnitsPerDay: session.budgetUnitsPerDay ?? null,
      },
      { request: false, write, units: ofTheSdk ? ofTheSdk.units : 1 }
    );
    if (!quota.allowed) {
      return { jsonrpc: "2.0", result: errorResult(quotaProblem(quota, "/api/mcp")), id };
    }
    returnQuota = quota.giveBack;
  }
  // If this call needs human approval, it is not run: it is left
  // as a proposal and "pending" is returned with its id.
  if (!options.approval && isNhiAgent(session)) {
    const held = await holdToolIfNeeded(name, args, session);
    if (held) return { jsonrpc: "2.0", result: held, id };
  }
  try {
    // External MCP tool: the bridge checks the fingerprint with the server
    // again, calls it and wraps the output as untrusted.
    if (external) {
      const result = await callExternalTool(external, args, {
        agentId: session.agentId,
        keyId: session.apiKeyId,
        wrap: session.untrustedWrap,
        origin: "mcp",
        approval: options.approval,
      });
      return { jsonrpc: "2.0", result, id };
    }

    // Kon SDK operations: they run through the same path as REST
    // (gates, idempotency, RLS, the operation's permission) with the identity
    // of this session's agent.
    const ofOperation = await runOperationTool(name, args, session);
    if (ofOperation) {
      // An idempotency repeat (`idempotency_key` already used)
      // ran nothing: it spends no quota.
      const sc = ofOperation.structuredContent as
        { idempotentReplayed?: boolean; code?: string } | undefined;
      if (sc?.idempotentReplayed || sc?.code === "KITSUDEN_E_IDEMPOTENCY_NOT_REPLAYABLE") {
        await returnQuota?.();
      }
      return { jsonrpc: "2.0", result: ofOperation, id };
    }

    // First check if this is a dynamic tool registered in the Actions engine
    const dynamicTools = listMCPTools();
    if (dynamicTools.find((t) => t.name === name)) {
      // Same as in agent-tools: the base MCP scope, and then those the
      // action declares (the engine requires them with the session's scopes)
      assertToolScope(name, session.scopes);
      const result = await executeMCPTool(name, args, session);
      return {
        jsonrpc: "2.0",
        // If the action returned a failure, it carries the same problem as the REST API
        // The text of an action that succeeds, in the shortest lossless format
        result: autoResult(withProblem(result), `mcp:${name}`),
        id,
      };
    }

    // Delegate hardcoded tools to shared implementation
    const {
      text,
      format,
      provenance: provenance,
    } = await executeHardcodedToolWithFormat(name, args || {}, session, {
      onMutate: invalidateGraphQLCache,
    });

    // Propagate validation errors that return string messages as MCP errors
    if (
      text.startsWith("Missing:") ||
      text.startsWith("Invalid") ||
      text.startsWith("Collection not found") ||
      text.startsWith("Dataset not found") ||
      text.startsWith("Record not found") ||
      text.startsWith("Unsupported") ||
      text.startsWith("Unknown queue")
    ) {
      return jsonRpcError(
        -32602,
        text,
        id,
        /not found/i.test(text) ? "KITSUDEN_E_NOT_FOUND" : "KITSUDEN_E_VALIDATION"
      );
    }

    return toolResult(text, id, format, provenance);
  } catch (err: unknown) {
    // A DATABASE error (SQL, constraints) is not shown to the agent: it goes
    // to the log. Those from the tools (scope, arguments) are, since they are for it
    // (security audit).
    const message = messageOf(err);
    const sqlstate = (err as { code?: unknown } | null)?.code;
    const fromDb =
      /Failed query|syntax error|does not exist|violates|duplicate key/i.test(message) ||
      (typeof sqlstate === "string" && /^[0-9A-Z]{5}$/.test(sqlstate));
    if (fromDb) logger.warn({ err, tool: name }, "MCP tool failed on the database");
    return {
      jsonrpc: "2.0",
      result: errorResult(exceptionProblem(err, fromDb ? "Internal error" : message)),
      id,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// JSON-RPC Helpers
// ═══════════════════════════════════════════════════════════════

function jsonRpcResult(uri: string, data: unknown, id: string | number) {
  return {
    jsonrpc: "2.0",
    result: {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(data),
        },
      ],
    },
    id,
  };
}

function jsonRpcError(
  code: number,
  message: string,
  id: string | number,
  kitsudenCode?: Parameters<typeof errorJsonRpc>[3]
) {
  // Same fields as an API problem+json, in `error.data`
  return errorJsonRpc(code, message, id, kitsudenCode);
}

function toolResult(text: string, id: string | number, format?: Format, provenance?: Provenance) {
  const meta: Record<string, unknown> = {};
  // The format the text comes in (json | toon | tron); without it, it is a message.
  if (format) meta[META_FORMAT] = format;
  // Who wrote each row and whether it is untrusted content (lib/provenance.ts)
  if (provenance) meta[META_PROVENANCE] = provenance;
  return {
    jsonrpc: "2.0",
    result: {
      content: [{ type: "text", text }],
      ...(Object.keys(meta).length ? { _meta: meta } : {}),
    },
    id,
  };
}

/**
 * How an approved MCP proposal is run. The same tool,
 * the same arguments and an agent session rebuilt with its identity
 * as of NOW (lib/approvals.ts re-read it); no quota (already counted) or gate.
 */
setApprovalsMcpExecutor(async (tool, args, agent, approval) => {
  const session: McpSession = {
    agentId: agent.agentId,
    agentName: agent.agentName,
    apiKeyId: agent.keyId,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    scopes: agent.scopes,
    allowedTools: agent.allowedTools,
    sponsor: agent.sponsor ?? null,
    untrustedWrap: agent.mcpSettings?.untrustedWrap,
  };
  session.approvedBy = approval.approvedBy;
  const r = (await executeTool(tool, args, 0, session, { approval })) as {
    result?: { content?: unknown; structuredContent?: unknown; isError?: boolean };
    error?: { message?: string; data?: unknown };
  };
  if (r.result) return r.result;
  return {
    content: [{ type: "text", text: r.error?.message ?? "error" }],
    structuredContent: r.error?.data,
    isError: true,
  };
});

export { mcpRoutes };
