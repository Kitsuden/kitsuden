/**
 * Agents Service
 * Service to interact with the agents API
 */

import type {
  AccessCatalog,
  AgentAccess,
  AgentApiKey,
  AgentQuotas,
  AgentQuotaLimits,
  AgentMcpSettings,
  UntrustedWrap,
  AgentSponsor,
  Agent,
  AgentTrace,
  AgentTraceStep,
  AgentIdentity,
  CreateAgentInput,
  UpdateAgentInput,
} from "$lib/types/agents";

// With VITE_API_URL (panel and API on different origins) a relative path went to the
// panel server and returned its index.html with a 404.
const ROOT = import.meta.env.VITE_API_URL ?? "";
/**
 * Agents, traces and identities live in `/api/v1` (routes/agents-v1.ts), which is
 * the contract this service expects: flat lists and `{ agent, token }`.
 * It pointed to `/api/admin`, which wraps in `{ success, data }` and has no
 * identities: the agents screen came out empty even when there were agents.
 */
const API_BASE = `${ROOT}/api/v1`;
/** The playground chat is in /api/admin/agents/:id/chat (agent-playground.ts). */
const API_ADMIN = `${ROOT}/api/admin`;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || error.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ============== Agents ==============

export async function listAgents(): Promise<Agent[]> {
  return fetchJson<Agent[]>(`${API_BASE}/agents`);
}

export async function getAgent(id: string): Promise<Agent> {
  return fetchJson<Agent>(`${API_BASE}/agents/${id}`);
}

export async function createAgent(
  data: CreateAgentInput
): Promise<{ agent: Agent; token: string }> {
  return fetchJson<{ agent: Agent; token: string }>(`${API_BASE}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function updateAgent(id: string, data: UpdateAgentInput): Promise<Agent> {
  return fetchJson<Agent>(`${API_BASE}/agents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function deleteAgent(id: string): Promise<void> {
  await fetchJson<void>(`${API_BASE}/agents/${id}`, { method: "DELETE" });
}

export async function regenerateToken(agentId: string): Promise<{ token: string }> {
  return fetchJson<{ token: string }>(`${API_BASE}/agents/${agentId}/token`, {
    method: "POST",
  });
}

// ============== Traces ==============

interface ListTracesOptions {
  agentId?: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
}

export async function listTraces(options: ListTracesOptions = {}): Promise<AgentTrace[]> {
  const { agentId, sessionId, limit = 20, offset = 0 } = options;
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (sessionId) params.set("sessionId", sessionId);

  if (agentId) params.set("agentId", agentId);

  // /api/v1/traces responds { traces, total }
  const res = await fetchJson<{ traces: AgentTrace[] } | AgentTrace[]>(
    `${API_BASE}/traces?${params}`
  );
  return Array.isArray(res) ? res : (res.traces ?? []);
}

export async function getTrace(id: string): Promise<AgentTrace & { steps: AgentTraceStep[] }> {
  return fetchJson<AgentTrace & { steps: AgentTraceStep[] }>(
    `${API_BASE}/traces/${id}?expand=steps`
  );
}

export async function listTraceSteps(traceId: string): Promise<AgentTraceStep[]> {
  return fetchJson<AgentTraceStep[]>(`${API_BASE}/traces/${traceId}/steps`);
}

// ============== Playground ==============

export interface PlaygroundMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface PlaygroundResponse {
  success: boolean;
  response: string;
  traceId: string;
  sessionId: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  cached: boolean;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown>; result: string }>;
}

export async function sendPlaygroundMessage(
  agentId: string,
  message: string,
  sessionId?: string
): Promise<PlaygroundResponse> {
  return fetchJson<PlaygroundResponse>(`${API_ADMIN}/agents/${agentId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      sessionId,
      enableMemory: true,
      enableBrainSearch: true,
    }),
  });
}

// ============== Agent Identities ==============

export async function listIdentities(): Promise<AgentIdentity[]> {
  return fetchJson<AgentIdentity[]>(`${API_BASE}/identities`);
}

export async function getIdentity(id: string): Promise<AgentIdentity> {
  return fetchJson<AgentIdentity>(`${API_BASE}/identities/${id}`);
}

export async function createIdentity(data: {
  name: string;
  systemPrompt: string;
  description?: string;
}): Promise<AgentIdentity> {
  return fetchJson<AgentIdentity>(`${API_BASE}/identities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function updateIdentity(
  id: string,
  data: Partial<{ name: string; systemPrompt: string; description?: string }>
): Promise<AgentIdentity> {
  return fetchJson<AgentIdentity>(`${API_BASE}/identities/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function deleteIdentity(id: string): Promise<void> {
  await fetchJson<void>(`${API_BASE}/identities/${id}`, { method: "DELETE" });
}

// ============== Permissions, keys and quotas (routes/agent-permissions.ts) ==============

const json = (body: unknown): RequestInit => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** What can be granted: presets, broad scopes, per-kon operations and datasets. */
export function getAccessCatalog(): Promise<AccessCatalog> {
  return fetchJson<AccessCatalog>(`${API_BASE}/agent-access/catalog`);
}

/** What this agent can do, already merged (broad + fine − denied). */
export function getAgentAccess(agentId: string): Promise<AgentAccess> {
  return fetchJson<AgentAccess>(`${API_BASE}/agents/${agentId}/access`);
}

/** Replaces the scope list (the API validates it: 422 with the reason). */
export function setAgentScopes(agentId: string, scopes: string[]): Promise<AgentAccess> {
  return fetchJson<AgentAccess>(`${API_BASE}/agents/${agentId}/scopes`, {
    method: "PUT",
    ...json({ scopes }),
  });
}

export async function listAgentKeys(agentId: string): Promise<AgentApiKey[]> {
  const r = await fetchJson<{ keys: AgentApiKey[] }>(`${API_BASE}/agents/${agentId}/keys`);
  return r.keys;
}

export function createAgentKey(
  agentId: string,
  data: { name?: string; expiresInDays?: number | null }
): Promise<{ key: AgentApiKey; apiKey: string }> {
  return fetchJson(`${API_BASE}/agents/${agentId}/keys`, { method: "POST", ...json(data) });
}

export function rotateAgentKey(
  agentId: string,
  keyId: string,
  data: { graceHours: number; expiresInDays?: number | null }
): Promise<{ key: AgentApiKey; apiKey: string; previous: AgentApiKey }> {
  return fetchJson(`${API_BASE}/agents/${agentId}/keys/${keyId}/rotate`, {
    method: "POST",
    ...json(data),
  });
}

export function revokeAgentKey(agentId: string, keyId: string): Promise<{ key: AgentApiKey }> {
  return fetchJson(`${API_BASE}/agents/${agentId}/keys/${keyId}/revoke`, {
    method: "POST",
    ...json({}),
  });
}

export function getAgentQuotas(agentId: string): Promise<AgentQuotas> {
  return fetchJson<AgentQuotas>(`${API_BASE}/agents/${agentId}/quotas`);
}

export function setAgentQuotas(
  agentId: string,
  limits: Partial<AgentQuotaLimits>
): Promise<AgentQuotas> {
  return fetchJson<AgentQuotas>(`${API_BASE}/agents/${agentId}/quotas`, {
    method: "PUT",
    ...json(limits),
  });
}

// ============== MCP settings (toolset and untrusted content) ==============

export function getAgentMcpSettings(agentId: string): Promise<AgentMcpSettings> {
  return fetchJson<AgentMcpSettings>(`${API_BASE}/agents/${agentId}/mcp-settings`);
}

/** `toolset: null` = all the tools. */
export function setAgentMcpSettings(
  agentId: string,
  settings: { toolset?: string | null; untrustedWrap?: UntrustedWrap }
): Promise<AgentMcpSettings> {
  return fetchJson<AgentMcpSettings>(`${API_BASE}/agents/${agentId}/mcp-settings`, {
    method: "PUT",
    ...json(settings),
  });
}

// ============== Human signer ==============

/** Who signs what the agent creates, and who can do it (admin or editor). */
export function getAgentSponsor(agentId: string): Promise<AgentSponsor> {
  return fetchJson<AgentSponsor>(`${API_BASE}/agents/${agentId}/sponsor`);
}

/** `null` removes the signer (the agent goes back to how it was before). */
export function setAgentSponsor(agentId: string, userId: string | null): Promise<AgentSponsor> {
  return fetchJson<AgentSponsor>(`${API_BASE}/agents/${agentId}/sponsor`, {
    method: "PUT",
    ...json({ userId }),
  });
}

// ============== Versions (definition history) ==============

export interface AgentVersionSummary {
  id: string;
  version: number;
  hash: string;
  source: "create" | "update" | "restore" | "baseline" | "detected";
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  model: string | null;
  config: { type?: string; allowedTools?: string[]; capabilities?: string[] };
  promptLength: number;
}

export interface AgentVersionDetail extends Omit<AgentVersionSummary, "promptLength"> {
  agentId: string;
  systemPrompt: string | null;
}

export function listAgentVersions(
  agentId: string
): Promise<{ agentId: string; current: number | null; versions: AgentVersionSummary[] }> {
  return fetchJson(`${API_BASE}/agents/${agentId}/versions`);
}

export function getAgentVersion(agentId: string, version: number): Promise<AgentVersionDetail> {
  return fetchJson(`${API_BASE}/agents/${agentId}/versions/${version}`);
}

export function restoreAgentVersion(
  agentId: string,
  version: number
): Promise<{ restored: number; current: AgentVersionDetail }> {
  return fetchJson(`${API_BASE}/agents/${agentId}/versions/${version}/restore`, { method: "POST" });
}

// ============== Decisions (what agents chose not to do) ==============

export interface AgentDecision {
  id: string;
  agentId: string;
  agentName: string | null;
  agentVersionId: string | null;
  version: number | null;
  traceId: string | null;
  channel: "rest" | "mcp" | "engine";
  action: string;
  reason: string;
  alternatives: string[];
  context: Record<string, unknown>;
  createdAt: string;
}

export function listAgentDecisions(
  filter: { agentId?: string; days?: number; limit?: number; offset?: number } = {}
): Promise<{ total: number; decisions: AgentDecision[] }> {
  const q = new URLSearchParams();
  if (filter.agentId) q.set("agentId", filter.agentId);
  if (filter.days) q.set("days", String(filter.days));
  if (filter.limit) q.set("limit", String(filter.limit));
  if (filter.offset) q.set("offset", String(filter.offset));
  const qs = q.toString();
  return fetchJson(`${API_BASE}/agent-decisions${qs ? `?${qs}` : ""}`);
}
