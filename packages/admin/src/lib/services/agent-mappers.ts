/**
 * What `/api/v1` really sends for agents and traces → what the panel shows.
 *
 * The panel's types described an API that does not exist: `agent.model`, `agent.status`,
 * `agent.totalTraces`, `trace.totalTokens`, a trace status called `completed`. The real rows
 * (routes/agents-v1.ts, tables `agent_identities` and `agent_traces`) carry `isActive`,
 * `type`, `tokensIn`/`tokensOut` and the status `success`. Against the real API the cards
 * said "undefined", and `trace.totalTokens.toLocaleString()` threw and blanked the page.
 *
 * Everything optional is tolerated as missing: these run on every row of a list.
 */
import type { Agent, AgentStatus, AgentTrace, TraceStatus } from "$lib/types/agents";

type Row = Record<string, unknown>;

const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const count = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

/**
 * `POST /api/v1/agents` keeps the chosen model as the first line of the prompt
 * (`Model: gpt-4`): there is no model column. Read back from there, when it is there.
 */
export function modelFromPrompt(systemPrompt: unknown): string | undefined {
  const m = typeof systemPrompt === "string" ? /^\s*Model:\s*(\S+)/.exec(systemPrompt) : null;
  return m?.[1];
}

export function agentStatus(row: Row): AgentStatus {
  const declared = text(row.status);
  if (declared === "active" || declared === "paused" || declared === "error") return declared;
  // `isActive` is the API's only notion of state; absent counts as active (its default).
  return row.isActive === false || row.enabled === false ? "paused" : "active";
}

export function toAgent(raw: unknown): Agent {
  const row = (raw && typeof raw === "object" ? raw : {}) as Row;
  const status = agentStatus(row);
  return {
    ...(row as Partial<Agent>),
    id: String(row.id ?? ""),
    name: text(row.name) ?? "",
    description: text(row.description),
    type: text(row.type),
    model: text(row.model) ?? modelFromPrompt(row.systemPrompt),
    enabled: status === "active",
    status,
    createdAt: String(row.createdAt ?? ""),
    updatedAt: String(row.updatedAt ?? row.createdAt ?? ""),
    totalTraces: count(row.totalTraces),
    totalTokens: count(row.totalTokens),
  };
}

const TRACE_STATUSES: readonly TraceStatus[] = [
  "pending",
  "running",
  "success",
  "error",
  "cancelled",
];

/** The API's enum, plus `completed` from older rows and mocks, which means `success`. */
export function traceStatus(v: unknown): TraceStatus {
  if (v === "completed") return "success";
  return TRACE_STATUSES.includes(v as TraceStatus) ? (v as TraceStatus) : "pending";
}

export function toTrace(raw: unknown): AgentTrace {
  const row = (raw && typeof raw === "object" ? raw : {}) as Row;
  const tokensIn = count(row.tokensIn) ?? 0;
  const tokensOut = count(row.tokensOut) ?? 0;
  return {
    ...(row as Partial<AgentTrace>),
    id: String(row.id ?? ""),
    agentId: String(row.agentId ?? ""),
    agentName: text(row.agentName),
    sessionId: text(row.sessionId),
    status: traceStatus(row.status),
    tokensIn,
    tokensOut,
    // The API has no `totalTokens`: it is the sum of both directions.
    totalTokens: count(row.totalTokens) ?? tokensIn + tokensOut,
    totalDurationMs: count(row.totalDurationMs) ?? 0,
    createdAt: String(row.createdAt ?? ""),
    updatedAt: String(row.updatedAt ?? row.completedAt ?? row.createdAt ?? ""),
  };
}

/** `GET /api/v1/traces` answers `{ traces, total }`; a bare array is accepted too. */
export function toTracePage(res: unknown): { traces: AgentTrace[]; total: number } {
  const list = Array.isArray(res)
    ? res
    : Array.isArray((res as { traces?: unknown[] } | null)?.traces)
      ? (res as { traces: unknown[] }).traces
      : [];
  const traces = list.map(toTrace);
  // `count(*)` comes out of Postgres as a string.
  const total = Array.isArray(res) ? undefined : count((res as { total?: unknown } | null)?.total);
  return { traces, total: total ?? traces.length };
}
