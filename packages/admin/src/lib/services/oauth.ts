/**
 * OAuth for MCP — what the panel uses (consent and connections)
 * Contract with apps/api/src/routes/oauth.ts. Guide: docs/agents/oauth.md.
 */

const ROOT = import.meta.env.VITE_API_URL ?? "";
const API = `${ROOT}/api/oauth`;

export interface EligibleAgent {
  id: string;
  name: string;
  description: string | null;
  /** Scopes of the agent that this human can delegate. */
  grantable: string[];
  /** Scopes of the agent that this human can NOT delegate (an editor does not give `admin`). */
  notDelegable: string[];
  /** Agent denials: they always apply. */
  denies: string[];
  sponsorUserId: string | null;
}

export interface ConsentView {
  request: { id: string; expiresAt: string; requestedScopes: string[]; resource: string };
  client: {
    id: string;
    name: string;
    kind: "dcr" | "cimd";
    uri: string | null;
    logoUri: string | null;
    softwareId: string | null;
    redirectUri: string;
    redirectHost: string;
    localhostRedirect: boolean;
    registeredAt: string;
  };
  human: { id: string; role: string; canCreateAgent: boolean };
  basicScopes: string[];
  agents: EligibleAgent[];
  /** There are more agents than fit in the list (the most recent are shown). */
  moreAgents?: boolean;
}

export interface OAuthConnection {
  id: string;
  client: { id: string; name: string; kind: string; uri: string | null; logoUri: string | null };
  agent: { id: string; name: string };
  grantedBy: { id: string; name: string | null; email: string | null };
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const e = new Error(String(body.error ?? body.detail ?? `HTTP ${res.status}`)) as Error & {
      status?: number;
    };
    e.status = res.status;
    throw e;
  }
  return body as T;
}

export function readConsent(requestId: string): Promise<ConsentView> {
  return request(`${API}/consent/${encodeURIComponent(requestId)}`);
}

export interface ConsentDecision {
  decision: "approve" | "deny";
  agentId?: string;
  newAgent?: { name: string };
  scopes?: string[];
}

export function decide(requestId: string, d: ConsentDecision): Promise<{ redirectTo: string }> {
  return request(`${API}/consent/${encodeURIComponent(requestId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(d),
  });
}

export async function listConnections(
  options: { agentId?: string; includeRevoked?: boolean } = {}
): Promise<OAuthConnection[]> {
  const q = new URLSearchParams();
  if (options.agentId) q.set("agentId", options.agentId);
  if (options.includeRevoked) q.set("includeRevoked", "true");
  const r = await request<{ grants: OAuthConnection[] }>(`${API}/grants${q.size ? `?${q}` : ""}`);
  return r.grants;
}

export function revokeConnection(id: string): Promise<{ revoked: boolean }> {
  return request(`${API}/grants/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * What is checked by default: what the client asked for (whatever the agent has)
 * and `mcp:connect`. Nothing it did not ask for: one click on Approve must not give
 * `admin` to a client that only asked to connect. The human can check more
 * before approving.
 */
export function inputScopes(requests: string[], _basics: string[], delegable: string[]): string[] {
  const chosenItems = delegable.filter((s) => requests.includes(s));
  if (delegable.includes("mcp:connect") && !chosenItems.includes("mcp:connect"))
    chosenItems.unshift("mcp:connect");
  return chosenItems;
}
