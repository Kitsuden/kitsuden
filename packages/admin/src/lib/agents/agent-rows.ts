/**
 * Agents as rows of the list template and as the header of their page: what the API's
 * list gives (name, type, state, scopes, limit, dates) plus what the panel can count
 * itself (the proposals of each agent that wait for a person).
 */
import type { Agent } from "$lib/types/agents";

export interface AgentRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string;
  status: string;
  /** The model when the prompt names one, else the agent's type (`custom`, `claude-desktop`…). */
  kind: string;
  scopes: number;
  /** Requests per minute, or null when the agent has no limit of its own. */
  rateLimit: number | null;
  pending: number;
  updatedAt: string | null;
}

/** How many pending proposals each agent has. */
export function pendingByAgent(
  proposals: ReadonlyArray<{ agentId: string; status: string }>
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of proposals) {
    if (p.status !== "pending") continue;
    counts.set(p.agentId, (counts.get(p.agentId) ?? 0) + 1);
  }
  return counts;
}

const number = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export function agentRow(agent: Agent, pending: ReadonlyMap<string, number> = new Map()): AgentRow {
  const raw = agent as Agent & { scopes?: unknown; rateLimit?: unknown };
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description ?? "",
    status: agent.status,
    kind: agent.model ?? agent.type ?? "",
    scopes: Array.isArray(raw.scopes) ? raw.scopes.length : 0,
    rateLimit: number(raw.rateLimit),
    pending: pending.get(agent.id) ?? 0,
    updatedAt: agent.updatedAt || agent.createdAt || null,
  };
}

export interface AgentFacts {
  kind: string;
  sponsor: string | null;
  /** Keys that still work, and all the keys ever issued. */
  activeKeys: number | null;
  totalKeys: number | null;
  pending: number | null;
  /** Calls counted by the API over its stats window, when it answered. */
  calls: number | null;
}

/**
 * The quiet line under an agent's name: type or model, sponsor, keys, pending approvals,
 * calls. A fact the API did not give is left out rather than shown as zero.
 */
export function agentMetaParts(
  facts: AgentFacts,
  t: (key: string, params?: Record<string, unknown>) => string
): string[] {
  const parts: string[] = [];
  if (facts.kind) parts.push(facts.kind);
  parts.push(
    facts.sponsor ? t("agentPage.sponsoredBy", { name: facts.sponsor }) : t("agentPage.noSponsor")
  );
  if (facts.activeKeys !== null) {
    parts.push(
      facts.activeKeys === 1 ? t("agentPage.keysOne") : t("agentPage.keys", { n: facts.activeKeys })
    );
  }
  if (facts.pending !== null && facts.pending > 0) {
    parts.push(t("agentPage.pending", { n: facts.pending }));
  }
  if (facts.calls !== null) parts.push(t("agentPage.calls", { n: facts.calls }));
  return parts;
}

/** A key counts as working when it was neither revoked nor has expired. */
export function activeKeyCount(
  keys: ReadonlyArray<{ revokedAt?: string | null; expiresAt?: string | null }>,
  now = Date.now()
): number {
  return keys.filter((k) => !k.revokedAt && (!k.expiresAt || new Date(k.expiresAt).getTime() > now))
    .length;
}
