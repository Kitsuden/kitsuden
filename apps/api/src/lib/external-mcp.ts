/**
 * External MCP servers: a fingerprint per tool, and a person's review
 * ============================================================================
 *
 * Kitsuden is an MCP server. This is the first piece of it as a CLIENT, and
 * it only READS: an administrator registers an external MCP server, a refresh
 * connects (Streamable HTTP), reads `tools/list` and keeps a fingerprint of
 * each tool. A tool's description and input schema are what a model reads to
 * decide what to call; a server that changes them after review can steer an
 * agent ("tool poisoning", a "rug pull"). So:
 *
 *   · fingerprint = SHA-256 of the canonical JSON of {name, description,
 *     inputSchema} (keys sorted, so the order a server sends them in does not
 *     count as a change);
 *   · a tool that is NEW, whose fingerprint CHANGED from the one approved, or
 *     that was REMOVED is `needs_review`;
 *   · it stays so until a PERSON (never an agent: `humansOnly`) approves the
 *     fingerprint they saw. Approving a fingerprint that is no longer the
 *     current one fails (409): the person must look again.
 *
 * `approvedTools()` is the gate agents go through: only tools whose current
 * fingerprint equals the approved one. Agents call them through the bridge
 * (lib/external-mcp-bridge.ts: an explicit `mcp-external:<server>:<tool>`
 * scope, the fingerprint checked again at call time, human approval, quota,
 * audit, output wrapped as untrusted). This file stays the registry and the
 * transport (`withExternalMcpClient`), which both use.
 *
 * The connection goes only to public addresses (the same check as webhooks,
 * `nonPublicAddress`), does not follow redirects and has a timeout.
 * `KITSUDEN_EXTERNAL_MCP_ALLOW_INTERNAL=true` lets it reach an internal server
 * (tests, a server on the same network). The auth header is stored encrypted
 * (services/secrets.ts) and never returned.
 */

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { sql } from "drizzle-orm";

import { db } from "../db";
import { logAgentAction } from "../services/agent-audit";
import { decryptSecret, encryptSecret, type EncryptedValue } from "../services/secrets";

import { logger } from "./logger";
import { nonPublicAddress } from "./oauth/cimd";

// ═══════════════════════════════════════════════════════════════
// Fingerprints
// ═══════════════════════════════════════════════════════════════

export interface AnnouncedTool {
  name: string;
  description?: string | null;
  inputSchema?: unknown;
}

function canonical(v: unknown, depth = 0): string {
  if (depth > 64) throw new Error("Tool schema nested too deeply");
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x, depth + 1)).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k], depth + 1)}`)
    .join(",")}}`;
}

/** Stable hash of what a model reads about a tool: name, description, input schema. */
export function toolFingerprint(tool: AnnouncedTool): string {
  const text = canonical({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema ?? null,
  });
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export type ToolChange = "new" | "changed" | "removed";

export interface StoredTool {
  name: string;
  fingerprint: string;
  approvedFingerprint: string | null;
  status: "approved" | "needs_review";
  change: ToolChange | null;
}

export interface ToolDecision {
  name: string;
  fingerprint: string;
  status: "approved" | "needs_review";
  change: ToolChange | null;
  /** The announced tool (absent when it was removed). */
  tool?: AnnouncedTool;
}

/**
 * What each tool becomes after a refresh. Pure: the tests check it without a
 * server. An approved fingerprint never changes here; only `approveTool` sets it.
 */
export function diffTools(stored: StoredTool[], announced: AnnouncedTool[]): ToolDecision[] {
  const before = new Map(stored.map((t) => [t.name, t]));
  const seen = new Set<string>();
  const out: ToolDecision[] = [];
  for (const tool of announced) {
    seen.add(tool.name);
    const fingerprint = toolFingerprint(tool);
    const old = before.get(tool.name);
    if (old?.approvedFingerprint === fingerprint) {
      out.push({ name: tool.name, fingerprint, status: "approved", change: null, tool });
    } else {
      out.push({
        name: tool.name,
        fingerprint,
        status: "needs_review",
        change: old?.approvedFingerprint ? "changed" : "new",
        tool,
      });
    }
  }
  for (const old of stored) {
    if (seen.has(old.name)) continue;
    out.push({
      name: old.name,
      fingerprint: old.fingerprint,
      status: "needs_review",
      change: "removed",
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// Where it may connect
// ═══════════════════════════════════════════════════════════════

function internalAllowed(): boolean {
  return process.env.KITSUDEN_EXTERNAL_MCP_ALLOW_INTERNAL === "true";
}

/** Shape of the URL (when saving it). */
export function serverUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Invalid MCP server URL";
  }
  if (url.username || url.password)
    return "Credentials in the URL are not allowed (use the auth header)";
  if (url.protocol !== "https:" && !(internalAllowed() && url.protocol === "http:")) {
    return "The MCP server URL must be https://";
  }
  if (raw.length > 2000) return "URL too long";
  return null;
}

/** The host must resolve to public addresses only (unless the internal opt-in is on). */
export async function serverTargetProblem(raw: string): Promise<string | null> {
  const shape = serverUrlProblem(raw);
  if (shape) return shape;
  if (internalAllowed()) return null;
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string }[];
  try {
    addresses = isIP(host)
      ? [{ address: host }]
      : await lookup(host, { all: true, verbatim: true });
  } catch {
    return `MCP server host could not be resolved: ${url.hostname}`;
  }
  if (!addresses.length || addresses.some((a) => nonPublicAddress(a.address))) {
    return `MCP server host resolves to a non-public address: ${url.hostname}`;
  }
  return null;
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "content-type",
  "accept",
]);

export function authHeaderProblem(name: unknown, value: unknown): string | null {
  if (name === undefined && value === undefined) return null;
  if (
    typeof name !== "string" ||
    !HEADER_NAME.test(name) ||
    RESERVED_HEADERS.has(name.toLowerCase())
  ) {
    return "authHeaderName must be a simple header name (e.g. Authorization)";
  }
  if (typeof value !== "string" || !value || value.length > 8192 || /[\r\n]/.test(value)) {
    return "authHeaderValue must be a non-empty single-line string";
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// Reading tools/list
// ═══════════════════════════════════════════════════════════════

const LIMITS = {
  timeoutMs: 15_000,
  pages: 20,
  tools: 1000,
  descriptionChars: 20_000,
  // One HTTP response of the transport (a tools/list page, a tools/call result).
  responseBytes: 8 * 1024 * 1024,
} as const;

/** Timeout of each request to an external MCP server (connect, list, call). */
export const EXTERNAL_MCP_TIMEOUT_MS = LIMITS.timeoutMs;

/** A body that stops with an error once it passes `max` bytes. */
function limitedBody(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) {
          controller.error(new Error(`The MCP server answered more than ${max} bytes`));
          return;
        }
        controller.enqueue(chunk);
      },
    })
  );
}

/** The SDK client, once connected. */
export type ExternalMcpClient = InstanceType<
  typeof import("@modelcontextprotocol/sdk/client/index.js").Client
>;

/**
 * Connects to an external MCP server, runs `fn` with the client and
 * disconnects. The ONE transport of the registry and of the agent bridge
 * (lib/external-mcp-bridge.ts): the address check (`serverTargetProblem`),
 * every request on the server's origin, no redirects, a timeout per request
 * and a cap on each response.
 */
export async function withExternalMcpClient<T>(
  url: string,
  auth: { name: string; value: string } | null | undefined,
  purpose: "review" | "bridge",
  fn: (client: ExternalMcpClient) => Promise<T>
): Promise<T> {
  const problem = await serverTargetProblem(url);
  if (problem) throw new Error(problem);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

  const origin = new URL(url).origin;
  const guardedFetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== origin) throw new Error(`MCP transport tried to leave ${origin}`);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(LIMITS.timeoutMs)])
      : AbortSignal.timeout(LIMITS.timeoutMs);
    const res = await fetch(input, { ...init, redirect: "manual", signal });
    if (!res.body) return res;
    return new Response(limitedBody(res.body, LIMITS.responseBytes), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };

  const headers: Record<string, string> = {
    "User-Agent": purpose === "review" ? "Kitsuden-MCP-Review/1" : "Kitsuden-MCP-Bridge/1",
  };
  if (auth) headers[auth.name] = auth.value;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers, redirect: "manual" },
    fetch: guardedFetch as never,
  });
  const client = new Client({
    name: purpose === "review" ? "kitsuden-tool-review" : "kitsuden-tool-bridge",
    version: "1.0.0",
  });
  try {
    await client.connect(transport, { timeout: LIMITS.timeoutMs });
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/** Every page of `tools/list` of a connected client (the first tool of each name wins). */
export async function listAnnouncedTools(client: ExternalMcpClient): Promise<AnnouncedTool[]> {
  const tools: AnnouncedTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LIMITS.pages; page++) {
    const r = await client.listTools(cursor ? { cursor } : undefined, {
      timeout: LIMITS.timeoutMs,
    });
    for (const t of r.tools ?? []) {
      if (typeof t.name !== "string" || !t.name || t.name.length > 200) continue;
      tools.push({
        name: t.name,
        description:
          typeof t.description === "string"
            ? t.description.slice(0, LIMITS.descriptionChars)
            : null,
        inputSchema: t.inputSchema ?? null,
      });
      if (tools.length > LIMITS.tools)
        throw new Error(`The server announces more than ${LIMITS.tools} tools`);
    }
    cursor = typeof r.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined;
    if (!cursor) break;
  }
  const names = new Set<string>();
  return tools.filter((t) => (names.has(t.name) ? false : (names.add(t.name), true)));
}

/** Connects, reads every page of `tools/list` and disconnects. */
export async function fetchAnnouncedTools(
  url: string,
  auth?: { name: string; value: string } | null
): Promise<AnnouncedTool[]> {
  return withExternalMcpClient(url, auth, "review", listAnnouncedTools);
}

// ═══════════════════════════════════════════════════════════════
// The registry (Postgres)
// ═══════════════════════════════════════════════════════════════

function rows(r: unknown): Array<Record<string, unknown>> {
  return ((r as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);

export interface ServerView {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  hasAuth: boolean;
  authHeaderName: string | null;
  lastRefreshedAt: string | null;
  lastError: string | null;
  needsReview: number;
  tools: number;
  createdAt: string | null;
  updatedAt: string | null;
}

function serverView(r: Record<string, unknown>): ServerView {
  return {
    id: String(r.id),
    name: String(r.name),
    url: String(r.url),
    enabled: r.enabled === true,
    hasAuth: r.has_auth === true,
    authHeaderName: (r.auth_header_name as string | null) ?? null,
    lastRefreshedAt: iso(r.last_refreshed_at),
    lastError: (r.last_error as string | null) ?? null,
    needsReview: Number(r.needs_review ?? 0),
    tools: Number(r.tools ?? 0),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const SERVER_COLUMNS = sql`
  s.id, s.name, s.url, s.enabled, s.auth_header_name, s.auth_header_value IS NOT NULL AS has_auth,
  s.last_refreshed_at, s.last_error, s.created_at, s.updated_at,
  (SELECT count(*) FROM external_mcp_tools t WHERE t.server_id = s.id AND t.status = 'needs_review') AS needs_review,
  (SELECT count(*) FROM external_mcp_tools t WHERE t.server_id = s.id AND t.change IS DISTINCT FROM 'removed') AS tools`;

export async function listServers(): Promise<ServerView[]> {
  return rows(
    await db.execute(sql`SELECT ${SERVER_COLUMNS} FROM external_mcp_servers s ORDER BY s.name`)
  ).map(serverView);
}

export async function getServer(id: string): Promise<ServerView | null> {
  const [r] = rows(
    await db.execute(
      sql`SELECT ${SERVER_COLUMNS} FROM external_mcp_servers s WHERE s.id = ${id}::uuid`
    )
  );
  return r ? serverView(r) : null;
}

export interface ServerInput {
  name?: string;
  url?: string;
  enabled?: boolean;
  /** `null` removes the header. */
  authHeaderName?: string | null;
  authHeaderValue?: string | null;
}

export async function createServer(
  input: Required<Pick<ServerInput, "name" | "url">> & ServerInput,
  by: string
) {
  const secret =
    input.authHeaderName && input.authHeaderValue
      ? JSON.stringify(encryptSecret(input.authHeaderValue))
      : null;
  const [r] = rows(
    await db.execute(sql`
      INSERT INTO external_mcp_servers (name, url, enabled, auth_header_name, auth_header_value, created_by, updated_by)
      VALUES (${input.name}, ${input.url}, ${input.enabled !== false}, ${secret ? input.authHeaderName : null},
              ${secret}::jsonb, ${by}, ${by})
      RETURNING id`)
  );
  return (await getServer(String(r!.id)))!;
}

export async function updateServer(
  id: string,
  input: ServerInput,
  by: string
): Promise<ServerView | null> {
  const current = await getServer(id);
  if (!current) return null;
  const sets = [sql`updated_by = ${by}`, sql`updated_at = now()`];
  if (input.name !== undefined) sets.push(sql`name = ${input.name}`);
  if (input.enabled !== undefined) sets.push(sql`enabled = ${input.enabled}`);
  if (input.url !== undefined && input.url !== current.url) {
    // Another URL is another server: every tool is reviewed again.
    sets.push(sql`url = ${input.url}`);
    await db.execute(sql`
      UPDATE external_mcp_tools SET approved_fingerprint = NULL, status = 'needs_review',
             change = COALESCE(change, 'changed')
       WHERE server_id = ${id}::uuid`);
  }
  if (input.authHeaderName === null || input.authHeaderValue === null) {
    sets.push(sql`auth_header_name = NULL`, sql`auth_header_value = NULL`);
  } else if (input.authHeaderName && input.authHeaderValue) {
    sets.push(
      sql`auth_header_name = ${input.authHeaderName}`,
      sql`auth_header_value = ${JSON.stringify(encryptSecret(input.authHeaderValue))}::jsonb`
    );
  }
  await db.execute(
    sql`UPDATE external_mcp_servers SET ${sql.join(sets, sql`, `)} WHERE id = ${id}::uuid`
  );
  return getServer(id);
}

export async function deleteServer(id: string): Promise<boolean> {
  return (
    rows(
      await db.execute(sql`DELETE FROM external_mcp_servers WHERE id = ${id}::uuid RETURNING id`)
    ).length > 0
  );
}

export interface ToolView {
  name: string;
  description: string | null;
  inputSchema: unknown;
  fingerprint: string;
  approvedFingerprint: string | null;
  status: "approved" | "needs_review";
  change: ToolChange | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
}

function toolView(r: Record<string, unknown>): ToolView {
  return {
    name: String(r.name),
    description: (r.description as string | null) ?? null,
    inputSchema: r.input_schema ?? null,
    fingerprint: String(r.fingerprint),
    approvedFingerprint: (r.approved_fingerprint as string | null) ?? null,
    status: r.status as ToolView["status"],
    change: (r.change as ToolChange | null) ?? null,
    firstSeenAt: iso(r.first_seen_at),
    lastSeenAt: iso(r.last_seen_at),
    approvedBy: (r.approved_by as string | null) ?? null,
    approvedAt: iso(r.approved_at),
  };
}

export async function listTools(serverId: string): Promise<ToolView[]> {
  return rows(
    await db.execute(sql`
      SELECT * FROM external_mcp_tools WHERE server_id = ${serverId}::uuid
       ORDER BY (status = 'needs_review') DESC, name`)
  ).map(toolView);
}

/**
 * The tools an agent can be offered: approved, and still announced with the
 * fingerprint a person approved. The bridge (lib/external-mcp-bridge.ts) offers
 * nothing else, and checks the fingerprint again with the server at call time.
 */
export async function approvedTools(serverId: string): Promise<ToolView[]> {
  return (await listTools(serverId)).filter(
    (t) => t.status === "approved" && t.change === null && t.fingerprint === t.approvedFingerprint
  );
}

/**
 * A change noticed OUTSIDE a refresh (the bridge, at call time): the tool goes
 * back to review exactly as a refresh would leave it. The approved fingerprint
 * stays; a person approves the new one or not.
 */
export async function flagToolForReview(
  serverId: string,
  name: string,
  change: "changed" | "removed",
  announced?: AnnouncedTool
): Promise<void> {
  if (change === "removed" || !announced) {
    await db.execute(sql`
      UPDATE external_mcp_tools SET status = 'needs_review', change = 'removed'
       WHERE server_id = ${serverId}::uuid AND name = ${name}`);
    return;
  }
  await db.execute(sql`
    UPDATE external_mcp_tools
       SET status = 'needs_review', change = 'changed', description = ${announced.description ?? null},
           input_schema = ${JSON.stringify(announced.inputSchema ?? null)}::jsonb,
           fingerprint = ${toolFingerprint(announced)}, last_seen_at = now()
     WHERE server_id = ${serverId}::uuid AND name = ${name}`);
}

export interface RefreshResult {
  server: ServerView;
  ok: boolean;
  error?: string;
  tools: number;
  needsReview: Array<{ name: string; change: ToolChange | null }>;
}

export interface ServerConnection {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  /** Raw (encrypted) header; `authOf` decrypts it at the moment of connecting. */
  authHeaderName: string | null;
  authHeaderValue: EncryptedValue | null;
}

/** What it takes to connect to a server (the header still encrypted). */
export async function serverConnection(id: string): Promise<ServerConnection | null> {
  const [s] = rows(
    await db.execute(sql`
      SELECT id, name, url, enabled, auth_header_name, auth_header_value
        FROM external_mcp_servers WHERE id = ${id}::uuid`)
  );
  if (!s) return null;
  return {
    id: String(s.id),
    name: String(s.name),
    url: String(s.url),
    enabled: s.enabled === true,
    authHeaderName: (s.auth_header_name as string | null) ?? null,
    authHeaderValue: (s.auth_header_value as EncryptedValue | null) ?? null,
  };
}

/** The decrypted auth header, or `null`. */
export function authOf(s: ServerConnection): { name: string; value: string } | null {
  return s.authHeaderName && s.authHeaderValue
    ? { name: s.authHeaderName, value: decryptSecret(s.authHeaderValue) }
    : null;
}

/** Connects to the server, records what it announces and flags what changed. */
export async function refreshServer(id: string): Promise<RefreshResult | null> {
  const s = await serverConnection(id);
  if (!s) return null;
  if (!s.enabled) {
    const server = (await getServer(id))!;
    return {
      server,
      ok: false,
      error: "The server is disabled",
      tools: server.tools,
      needsReview: [],
    };
  }
  let announced: AnnouncedTool[];
  try {
    announced = await fetchAnnouncedTools(s.url, authOf(s));
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    await db.execute(sql`
      UPDATE external_mcp_servers SET last_error = ${message}, last_refreshed_at = now() WHERE id = ${id}::uuid`);
    logger.warn({ serverId: id, err: message }, "[external-mcp] refresh failed");
    const server = (await getServer(id))!;
    return { server, ok: false, error: message, tools: server.tools, needsReview: [] };
  }

  const stored = rows(
    await db.execute(sql`
      SELECT name, fingerprint, approved_fingerprint, status, change FROM external_mcp_tools
       WHERE server_id = ${id}::uuid`)
  ).map((r) => ({
    name: String(r.name),
    fingerprint: String(r.fingerprint),
    approvedFingerprint: (r.approved_fingerprint as string | null) ?? null,
    status: r.status as StoredTool["status"],
    change: (r.change as ToolChange | null) ?? null,
  }));
  // A removed tool that a person already acknowledged is gone from `stored`
  // (approving a removal deletes the row), so it is not flagged again.
  const decisions = diffTools(stored, announced);

  await db.transaction(async (tx) => {
    for (const d of decisions) {
      if (d.change === "removed") {
        await tx.execute(sql`
          UPDATE external_mcp_tools SET status = 'needs_review', change = 'removed'
           WHERE server_id = ${id}::uuid AND name = ${d.name}`);
        continue;
      }
      const schema = JSON.stringify(d.tool?.inputSchema ?? null);
      await tx.execute(sql`
        INSERT INTO external_mcp_tools (server_id, name, description, input_schema, fingerprint, status, change)
        VALUES (${id}::uuid, ${d.name}, ${d.tool?.description ?? null}, ${schema}::jsonb, ${d.fingerprint},
                ${d.status}, ${d.change})
        ON CONFLICT (server_id, name) DO UPDATE
          SET description = EXCLUDED.description, input_schema = EXCLUDED.input_schema,
              fingerprint = EXCLUDED.fingerprint, status = EXCLUDED.status, change = EXCLUDED.change,
              last_seen_at = now()`);
    }
    await tx.execute(sql`
      UPDATE external_mcp_servers SET last_error = NULL, last_refreshed_at = now() WHERE id = ${id}::uuid`);
  });

  const needsReview = decisions
    .filter((d) => d.status === "needs_review")
    .map((d) => ({ name: d.name, change: d.change }));
  if (needsReview.length) {
    logger.warn({ serverId: id, needsReview }, "[external-mcp] tools need review");
  }
  return { server: (await getServer(id))!, ok: true, tools: announced.length, needsReview };
}

export class FingerprintMismatch extends Error {}

/**
 * A person approves a tool AS THEY SAW IT: `fingerprint` must be the current
 * one. Approving a removal forgets the tool (if it comes back, it is new).
 */
export async function approveTool(
  serverId: string,
  name: string,
  fingerprint: string,
  by: string
): Promise<ToolView | { removed: true } | null> {
  const [t] = rows(
    await db.execute(sql`
      SELECT fingerprint, change FROM external_mcp_tools WHERE server_id = ${serverId}::uuid AND name = ${name}`)
  );
  if (!t) return null;
  if (t.fingerprint !== fingerprint) {
    throw new FingerprintMismatch(
      "The tool changed since you reviewed it: refresh and review the current description and schema"
    );
  }
  const audit = (decision: string) =>
    logAgentAction({
      agentId: null,
      action: "external_mcp_tool_approved",
      resource: "external_mcp_tool",
      resourceId: serverId,
      details: { tool: name, fingerprint, decision, by },
      success: true,
    });
  if (t.change === "removed") {
    await db.execute(
      sql`DELETE FROM external_mcp_tools WHERE server_id = ${serverId}::uuid AND name = ${name}`
    );
    audit("removal_acknowledged");
    return { removed: true };
  }
  const [r] = rows(
    await db.execute(sql`
      UPDATE external_mcp_tools
         SET approved_fingerprint = fingerprint, status = 'approved', change = NULL,
             approved_by = ${by}, approved_at = now()
       WHERE server_id = ${serverId}::uuid AND name = ${name} AND fingerprint = ${fingerprint}
      RETURNING *`)
  );
  if (!r) throw new FingerprintMismatch("The tool changed while approving it: review it again");
  audit("approved");
  return toolView(r);
}
