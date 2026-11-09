/**
 * External MCP servers — what the panel uses (registry and tool review)
 * Contract with apps/api/src/routes/mcp-servers.ts. Guide: docs/agents/external-mcp.md.
 */

const ROOT = import.meta.env.VITE_API_URL ?? "";
const API = `${ROOT}/api/admin/mcp-servers`;

export interface McpServer {
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
}

export interface McpTool {
  name: string;
  description: string | null;
  inputSchema: unknown;
  fingerprint: string;
  approvedFingerprint: string | null;
  status: "approved" | "needs_review";
  change: "new" | "changed" | "removed" | null;
  lastSeenAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  /** Approved tools: the name agents see, the scope they need, whether it is offered now. */
  agentTool?: { name: string; scope: string; offered: boolean } | null;
}

export interface RefreshResult {
  ok: boolean;
  error?: string;
  tools: number;
  needsReview: Array<{ name: string; change: string | null }>;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(body.error ?? body.message ?? `HTTP ${res.status}`));
  return body as T;
}

export async function listServers(): Promise<McpServer[]> {
  return (await request<{ docs: McpServer[] }>(API)).docs;
}

export function createServer(input: {
  name: string;
  url: string;
  authHeaderName?: string;
  authHeaderValue?: string;
}): Promise<McpServer> {
  return request(API, { method: "POST", body: JSON.stringify(input) });
}

export function setEnabled(id: string, enabled: boolean): Promise<McpServer> {
  return request(`${API}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export function deleteServer(id: string): Promise<{ success: boolean }> {
  return request(`${API}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function refreshServer(id: string): Promise<RefreshResult> {
  return request(`${API}/${encodeURIComponent(id)}/refresh`, { method: "POST" });
}

export async function listTools(id: string): Promise<McpTool[]> {
  return (await request<{ docs: McpTool[] }>(`${API}/${encodeURIComponent(id)}/tools`)).docs;
}

export function approveTool(id: string, name: string, fingerprint: string): Promise<unknown> {
  return request(`${API}/${encodeURIComponent(id)}/tools/approve`, {
    method: "POST",
    body: JSON.stringify({ name, fingerprint }),
  });
}
