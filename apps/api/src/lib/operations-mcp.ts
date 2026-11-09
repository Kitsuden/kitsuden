/**
 * Kons SDK operations as MCP tools
 * ============================================================================
 *
 * Each mounted operation of an SDK kon is a tool (except those
 * excluded with a reason), with the SAME schema as its REST route
 * (`operations-openapi.ts`).
 *
 * ── HOW A TOOL IS EXECUTED ─────────────────────────────────────────────────
 *
 * The handler is not called directly: the operation's HTTP request is built and
 * passed through an internal PIPELINE with the same pieces the API
 * puts in front of a kon, in the same order:
 *
 *   request context (requestId, trace, request-scope)
 *   → identity = the MCP session's agent (`agent` + `user` with their scopes,
 *     just as global authentication leaves it with `Bearer kitsuden_agent_*`)
 *   → the prefix gates of `auth-guard` (`ADMIN_ONLY_ROUTES`)
 *   → `Idempotency-Key` (if the agent sends `idempotency_key`)
 *   → errors as problem+json
 *   → in production, no internal detail in a 5xx for an agent without `admin`
 *     (`errorsWithoutDetail`, as REST; `withoutServerDetail` on the result)
 *   → the kon's RLS transaction (`mountKonRls`)
 *   → the kon's router (validation, permission, handler)
 *
 * This way a tool CANNOT do anything the same key could not do
 * over REST: it inherits authorization, RLS and idempotency without duplicating them.
 * What the MCP session adds on top is its `allowedTools` list.
 *
 * What does NOT go through here (known differences from REST): the per-kon request
 * limit (MCP has its own, 200/min), the Origin check
 * (it is for cookies) and REST's format negotiation: the result text comes out in the
 * shortest LOSSLESS format (`auto`, lib/formats.ts)
 * and `_meta["kitsuden/format"]` says which; `structuredContent` carries the data.
 */

import {
  operationCost,
  exclusionMcp,
  toolName,
  buildProblem,
  errorCodeFromLegacy,
  errorCodeForStatus,
  type AgentSigner,
  type ProblemDetails,
} from "@kitsuden/shared";
import { Hono, type Context, type Next } from "hono";

import { readSseEvents } from "../../../../packages/engine/src/flows";
import {
  grantsOperation,
  mountedOperations,
  mountedOperationsVersion,
  type AnyOperation,
} from "../../../../packages/engine/src/operations";
import { db } from "../db";
import { agentDenials, adminGate, ADMIN_ONLY_ROUTES } from "../middleware/auth-guard";
import { errorsWithoutDetail } from "../middleware/errors-without-detail";
import { idempotency } from "../middleware/idempotency";
import { httpProblems } from "../middleware/problems-http";
import { requestContextMiddleware } from "../middleware/telemetry";

import { inProduction } from "./environment";
import { encodeResponse, META_FORMAT } from "./formats";
import { VALID_IDEMPOTENCY_KEY, requestFingerprint, savedRepetition } from "./idempotency";
import { defaultStores } from "./idempotency-stores";
import { logger } from "./logger";
import type { WrapperMode } from "./mcp-settings";
import { mountKonRls } from "./module-loader";
import {
  ARG_BODY,
  ARG_IDEMPOTENCY,
  mcpTool,
  requestFromArguments,
  guideUri,
  type McpTool,
} from "./operations-openapi";
import { errorResult, withoutServerDetail } from "./problems-mcp";
import { wrapRows, META_PROVENANCE, rowProvenance, type Provenance } from "./provenance";

/** What the MCP knows about a session's agent. */
export interface SessionAgent {
  agentId: string;
  agentName: string;
  apiKeyId: string;
  scopes: string[];
  allowedTools: string[];
  /** The agent's human signer (see @kitsuden/shared signer.ts). */
  sponsor?: AgentSigner | null;
  /** Wrapping for untrusted content (panel; lib/provenance.ts). */
  untrustedWrap?: WrapperMode;
}

interface Input {
  konId: string;
  mountPath: string;
  op: AnyOperation;
  tool: McpTool;
}

let index: { version: number; byName: Map<string, Input> } | null = null;

function tools(): Map<string, Input> {
  const version = mountedOperationsVersion();
  if (index?.version === version) return index.byName;
  const byName = new Map<string, Input>();
  for (const { konId, mountPath, operations: operations } of mountedOperations()) {
    for (const op of operations) {
      const tool = mcpTool(konId, mountPath, op);
      if (!tool) continue;
      if (byName.has(tool.name)) {
        logger.warn({ tool: tool.name }, "[mcp] duplicate tool name; the first one is kept");
        continue;
      }
      byName.set(tool.name, { konId, mountPath, op, tool });
    }
  }
  index = { version, byName };
  return byName;
}

/** The user the session's agent reaches the operations as. */
function agentUser(a: SessionAgent) {
  return {
    id: a.agentId,
    name: a.agentName,
    role: "agent",
    scopes: a.scopes,
    sponsor: a.sponsor ?? null,
  };
}

/**
 * Should this agent SEE the tool? If its `allowedTools` list allows it and
 * if the operation's permission grants it (the SAME check the REST route does:
 * scopes ∪ roles ∪ the kon's policy): advertising those it cannot
 * use only invites failure. Those that depend on the resource
 * (`policy.inHandler`) are advertised: it is decided at execution time.
 */
async function visible(agent: SessionAgent, e: Input): Promise<boolean> {
  if (agent.allowedTools.length > 0 && !agent.allowedTools.includes(e.tool.name)) return false;
  if (!e.op.permission || e.op.permission.policy?.inHandler) return true;
  return grantsOperation(e.konId, e.op, agentUser(agent));
}

/** The operation tools this session can see (for `tools/list`). */
export async function operationTools(agent: SessionAgent): Promise<McpTool[]> {
  const output: McpTool[] = [];
  for (const e of tools().values()) if (await visible(agent, e)) output.push(e.tool);
  return output;
}

/**
 * What a call to this SDK tool spends from the quota:
 * a write if it is not GET, and the declared `cost` (1 by default). `null` if
 * it is not an SDK tool.
 */
export function operationToolUsage(name: string): { write: boolean; units: number } | null {
  const e = tools().get(name);
  if (!e) return null;
  return { write: e.op.method !== "GET", units: operationCost(e.op) };
}

/**
 * The REST request this SDK tool would make (to decide whether
 * it needs approval and store it as a proposal). `null` if it is not an SDK tool;
 * `{ error }` if the arguments are not valid (then it is not proposed: the call
 * goes on and returns its validation error).
 */
export function toolRequest(
  name: string,
  args: unknown
):
  | { konId: string; op: AnyOperation; method: string; path: string; query: string; body: unknown }
  | { error: string }
  | null {
  const e = tools().get(name);
  if (!e) return null;
  const argsObject = (
    args && typeof args === "object" && !Array.isArray(args) ? args : {}
  ) as Record<string, unknown>;
  const valid = Object.keys((e.tool.inputSchema.properties ?? {}) as Record<string, unknown>);
  if (Object.keys(argsObject).some((k) => !valid.includes(k)))
    return { error: "unknown arguments" };
  try {
    const request = requestFromArguments(e.mountPath, e.op, argsObject);
    const url = new URL(request.url);
    return {
      konId: e.konId,
      op: e.op,
      method: e.op.method,
      path: url.pathname,
      query: url.search,
      body: argsObject[ARG_BODY],
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * Is this call the REPLAY of one already made (same
 * `idempotency_key`, same arguments)? Then no quota is charged: the pipeline's
 * idempotency will replay it without executing anything.
 */
export async function isToolRepetition(
  name: string,
  args: unknown,
  agentId: string
): Promise<boolean> {
  const e = tools().get(name);
  if (!e) return false;
  const argsObject = (
    args && typeof args === "object" && !Array.isArray(args) ? args : {}
  ) as Record<string, unknown>;
  const key = argsObject[ARG_IDEMPOTENCY];
  if (typeof key !== "string" || !VALID_IDEMPOTENCY_KEY.test(key)) return false;
  try {
    const request = requestFromArguments(e.mountPath, e.op, argsObject);
    const url = new URL(request.url);
    const headers = (request.init.headers ?? {}) as Record<string, string>;
    const body =
      typeof request.init.body === "string"
        ? new TextEncoder().encode(request.init.body)
        : new Uint8Array();
    const fingerprint = requestFingerprint({
      method: e.op.method,
      path: url.pathname,
      query: url.search,
      type: headers["content-type"] ?? "",
      body,
    });
    return await savedRepetition(defaultStores(), `agent:${agentId}`, key, fingerprint);
  } catch {
    return false;
  }
}

export interface GuideResource {
  uri: string;
  name: string;
  mimeType: "text/markdown";
  description: string;
}

/**
 * The guides (`kitsuden://guide/<tool>`) of the tools this
 * session SEES: the same visibility as `tools/list`, so as not to describe what
 * the agent cannot use.
 */
export async function guideResources(agent: SessionAgent): Promise<GuideResource[]> {
  const output: GuideResource[] = [];
  for (const e of tools().values()) {
    if (!e.op.guide || !(await visible(agent, e))) continue;
    output.push({
      uri: guideUri(e.tool.name),
      name: `Guide: ${e.tool.name}`,
      mimeType: "text/markdown",
      description: `How to use ${e.tool.name}: when, prerequisites, examples, common mistakes`,
    });
  }
  return output;
}

/**
 * The guide text of a tool, or `null` if the URI is not for a
 * guide, the tool has none or this session does not see it (answered the same as
 * for one that does not exist).
 */
export async function readGuide(uri: string, agent: SessionAgent): Promise<string | null> {
  const prefix = guideUri("");
  if (!uri.startsWith(prefix)) return null;
  const e = tools().get(uri.slice(prefix.length));
  if (!e?.op.guide || !(await visible(agent, e))) return null;
  return markdownGuide(e);
}

function markdownGuide(e: Input): string {
  const g = e.op.guide!;
  const h = e.tool;
  const lines = [`# ${h.name}`, "", h.title, ""];
  if (g.whenToUse) lines.push("## When to use", "", g.whenToUse, "");
  if (g.before?.length)
    lines.push("## Before calling it", "", ...g.before.map((a) => `- ${a}`), "");
  if (g.examples?.length) {
    lines.push("## Examples", "");
    for (const ej of g.examples) {
      lines.push(`### ${ej.title}`, "", "```json", JSON.stringify(ej.args, null, 2), "```", "");
    }
  }
  if (g.traps?.length) {
    lines.push("## Common mistakes", "", ...g.traps.map((t) => `- **${t.if}** → ${t.then}`), "");
  }
  lines.push("## Contract", "", h.description, "");
  return lines.join("\n");
}

/**
 * For toolsets (lib/mcp-settings.ts): which kon an SDK tool belongs to
 * and whether it only reads (GET). `null` if it is not an SDK tool.
 */
export function operationToolCard(name: string): { kon: string; readOnly: boolean } | null {
  const e = tools().get(name);
  if (!e) return null;
  return { kon: e.konId.replace(/^kon-/, ""), readOnly: e.op.method === "GET" };
}

/** Is it a tool generated by the SDK? */
export function isOperationTool(name: string): boolean {
  return tools().has(name);
}

/** For coverage: each mounted operation, with its tool or its reason. */
export function operationsMcpInventory(): {
  route: string;
  name: string | null;
  excluded: string | null;
}[] {
  const output: { route: string; name: string | null; excluded: string | null }[] = [];
  for (const { konId, mountPath, operations: operations } of mountedOperations()) {
    for (const op of operations) {
      const route = `${op.method} ${op.route === "/" ? mountPath : `${mountPath}${op.route}`}`;
      const excluded = exclusionMcp(op);
      output.push({ route, name: excluded === null ? toolName(konId, op) : null, excluded });
    }
  }
  return output;
}

// ── El pipeline ─────────────────────────────────────────────────────────────

type EnvPipeline = { Bindings: { agent: SessionAgent } };

let pipeline: { version: number; app: Hono<EnvPipeline> } | null = null;

function agentIdentity() {
  return async (c: Context<EnvPipeline>, next: Next) => {
    const a = c.env.agent;
    const set = c.set as (k: string, v: unknown) => void;
    set("agent", {
      agentId: a.agentId,
      agentName: a.agentName,
      scopes: a.scopes,
      keyId: a.apiKeyId,
      allowedTools: a.allowedTools,
      sponsor: a.sponsor ?? null,
      rateLimit: 0,
      writesPerDay: null,
      budgetUnitsPerDay: null,
    });
    // The same shape that global authentication (index.ts) leaves for an agent
    set("user", {
      ...agentUser(a),
      email: `agent@${a.agentId}.kitsuden.local`,
      image: null,
    });
    set("session", null);
    await next();
  };
}

function buildPipeline(): Hono<EnvPipeline> {
  const app = new Hono<EnvPipeline>();
  app.use("*", requestContextMiddleware() as never);
  app.use("*", agentIdentity());
  app.use("*", agentDenials as never);
  app.use("*", adminGate(ADMIN_ONLY_ROUTES) as never);
  app.use(
    "/api/*",
    idempotency({
      stores: defaultStores,
      notify: (message, data) => logger.warn(data, message),
    }) as never
  );
  app.use("*", httpProblems() as never);
  // The same net as REST (index.ts): in production a kon's 5xx does not hand its
  // internal message (SQL, paths) to an agent without `admin`. Inside
  // httpProblems, so the masked body still becomes a problem+json.
  app.use("*", errorsWithoutDetail(inProduction) as never);
  for (const { mountPath, router } of mountedOperations()) {
    mountKonRls(app as never, mountPath);
    app.route(mountPath, router as never);
  }
  return app;
}

function app(): Hono<EnvPipeline> {
  const version = mountedOperationsVersion();
  if (pipeline?.version !== version) pipeline = { version, app: buildPipeline() };
  return pipeline.app;
}

/** Keys under which a kon usually returns its list. */
const LIST_KEYS = ["items", "data", "entries", "results", "rows", "posts", "records"] as const;

/**
 * The rows of a kon response: the array, the list under a
 * known key, or the whole object as one row. It also returns how to
 * rebuild the response with the changed rows.
 */
function responseRows(body: object): { rows: unknown[]; mount: (rows: unknown[]) => unknown } {
  if (Array.isArray(body)) return { rows: body, mount: (f) => f };
  const o = body as Record<string, unknown>;
  for (const k of LIST_KEYS) {
    const v = o[k];
    if (Array.isArray(v) && v.every((x) => x && typeof x === "object")) {
      return { rows: v, mount: (f) => ({ ...o, [k]: f }) };
    }
  }
  return { rows: [o], mount: (f) => f[0] };
}

async function markProvenance(
  body: object,
  agent: SessionAgent
): Promise<{ data: unknown; provenance: Provenance } | null> {
  try {
    const { rows: rows, mount } = responseRows(body);
    const mode = agent.untrustedWrap ?? "none";
    // agent_identities has no RLS: the global connection is enough to classify.
    const provenance = await rowProvenance(rows, db as never, {
      reader: agent.agentId,
      wrap: mode,
    });
    return { data: mode === "none" ? body : mount(wrapRows(rows, provenance, mode)), provenance };
  } catch (err) {
    logger.warn({ err }, "[mcp] could not compute provenance");
    return null;
  }
}

export interface McpResult {
  content: { type: "text"; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

function argumentsProblem(
  name: string,
  detail: string,
  extra?: Record<string, unknown>
): ProblemDetails {
  return buildProblem({
    code: "KITSUDEN_E_VALIDATION",
    detail: `Invalid arguments for '${name}': ${detail}`,
    instance: "/api/mcp",
    extensions: extra,
  });
}

/**
 * Executes an SDK tool. `null` if the name is not an operation
 * (the call continues through the usual tools).
 */
export async function runOperationTool(
  name: string,
  args: unknown,
  agent: SessionAgent
): Promise<McpResult | null> {
  const e = tools().get(name);
  if (!e) return null;

  if (agent.allowedTools.length > 0 && !agent.allowedTools.includes(name)) {
    return errorResult(
      buildProblem({
        code: "KITSUDEN_E_FORBIDDEN",
        detail: `Tool '${name}' is not in this agent's allowed tools.`,
        instance: "/api/mcp",
      })
    );
  }

  const argsObject = (
    args && typeof args === "object" && !Array.isArray(args) ? args : {}
  ) as Record<string, unknown>;
  const valid = Object.keys((e.tool.inputSchema.properties ?? {}) as Record<string, unknown>);
  const extras = Object.keys(argsObject).filter((k) => !valid.includes(k));
  if (extras.length > 0) {
    return errorResult(
      argumentsProblem(
        name,
        `does not know ${extras.map((s) => `'${s}'`).join(", ")}. Valid arguments: ${valid.join(", ") || "(none)"}.` +
          (e.op.input?.body ? ` The body goes whole in '${ARG_BODY}'.` : ""),
        { unknownKeys: extras, validKeys: valid }
      )
    );
  }
  let request;
  try {
    request = requestFromArguments(e.mountPath, e.op, argsObject);
  } catch (err) {
    return errorResult(argumentsProblem(name, (err as Error).message));
  }

  const res = await app().request(request.url, request.init, { agent });
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text();
  let body: unknown = text;
  if (type.includes("json") && text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  // A flow (plan C5): over MCP, the LIST of its events. An
  // `error` event is the tool's error (with its problem+json).
  if (res.status === 200 && type.includes("text/event-stream")) {
    const events = readSseEvents(text);
    const failure = events.find((ev) => ev.event === "error");
    if (failure) {
      let p: unknown;
      try {
        p = JSON.parse(failure.data);
      } catch {
        p = null;
      }
      return errorResult(
        withoutServerDetail(
          p && typeof p === "object" && "code" in (p as object)
            ? (p as ProblemDetails)
            : buildProblem({ code: "KITSUDEN_E_INTERNAL", status: 500, instance: "/api/mcp" }),
          agent.scopes,
          inProduction()
        )
      );
    }
    body = events
      .filter((ev) => !ev.event || ev.event === "message")
      .map((ev) => {
        try {
          return JSON.parse(ev.data) as unknown;
        } catch {
          return ev.data;
        }
      });
  }

  if (res.status >= 400) {
    const problem =
      body && typeof body === "object" && "code" in (body as object)
        ? (body as ProblemDetails)
        : buildProblem({
            code:
              errorCodeFromLegacy((body as { code?: unknown })?.code) ??
              errorCodeForStatus(res.status),
            status: res.status,
            detail: typeof body === "string" ? body.slice(0, 500) : undefined,
            instance: "/api/mcp",
          });
    return errorResult(withoutServerDetail(problem, agent.scopes, inProduction()));
  }

  const replay = res.headers.get("idempotent-replayed") === "true";
  // A read brings what others wrote: who is marked (and it is wrapped
  // if the agent asked). Writes return what the agent sent.
  const flagged =
    e.op.method === "GET" && res.status !== 204 && body && typeof body === "object"
      ? await markProvenance(body, agent)
      : null;
  const data = res.status === 204 ? null : (flagged?.data ?? body);
  const output =
    typeof data === "string" ? null : encodeResponse(data, "auto", { key: `mcp:${name}` });
  const meta: Record<string, unknown> = {};
  if (output) meta[META_FORMAT] = output.format;
  if (flagged)
    meta[META_PROVENANCE] = {
      ...flagged.provenance,
      source: `kon:${e.konId.replace(/^kon-/, "")}`,
    };
  return {
    content: [{ type: "text", text: output ? output.text : (data as string) }],
    ...(Object.keys(meta).length ? { _meta: meta } : {}),
    structuredContent: {
      status: res.status,
      ...(replay ? { idempotentReplayed: true } : {}),
      data,
    },
  };
}
