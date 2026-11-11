/**
 * The "glass box" (request traces) and the Postgres queue.
 * API: apps/api/src/routes/traces.ts (/api/admin/requests) and
 * apps/api/src/routes/queue.ts (/api/admin/queue). Administrators only.
 */

const ROOT = import.meta.env.VITE_API_URL ?? "";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || error.detail || error.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface TraceBlocking {
  table: string;
  operation: "update" | "delete";
  reason: "not_yours" | "not_found";
}

export interface RequestTrace {
  /** The row as Postgres names it (`SELECT *` from `kitsuden_traces_list`). */
  created_at: string;
  /** Not sent by the API: kept so an older answer or a mock still shows its date. */
  createdAt?: string;
  request_id: string | null;
  method: string;
  route: string;
  status: number;
  actor_type: "human" | "agent" | "anonymous";
  actor_id: string | null;
  kon: string | null;
  operation: string | null;
  duration_ms: number;
  db_time_ms: number | null;
  queries: number | null;
  rows_affected: number | null;
  denials: number;
  denial_details: TraceBlocking[] | null;
}

export interface OperationSummary {
  kon: string | null;
  operation: string | null;
  method: string;
  route: string;
  requests: number;
  errors: number;
  denials: number;
  p95_ms: number;
  avg_db_ms: number | null;
  rows: number;
}

export interface TraceFilter {
  hours?: number;
  blocked?: boolean;
  errors?: boolean;
  actor?: string;
}

export function listRequestTraces(
  f: TraceFilter = {}
): Promise<{ enabled: boolean; requests: RequestTrace[] }> {
  const q = new URLSearchParams();
  if (f.hours) q.set("hours", String(f.hours));
  if (f.blocked) q.set("blocked", "1");
  if (f.errors) q.set("errors", "1");
  if (f.actor) q.set("actor", f.actor);
  return fetchJson(`${ROOT}/api/admin/requests?${q}`);
}

export function requestTraceSummary(
  hours = 24
): Promise<{ enabled: boolean; operations: OperationSummary[] }> {
  return fetchJson(`${ROOT}/api/admin/requests/summary?hours=${hours}`);
}

export interface DeadJob {
  id: string;
  queue: string;
  name: string;
  reason: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  user_id: string | null;
  agent_id: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface QueueState {
  worker: "running" | "stopped" | "disabled";
  listens: boolean;
  byQueue: Record<string, Record<string, number>>;
  totals: Record<string, number>;
  dead: DeadJob[];
}

export function queueStatus(): Promise<QueueState> {
  return fetchJson(`${ROOT}/api/admin/queue`);
}

export function retryJob(id: string): Promise<{ success: boolean }> {
  return fetchJson(`${ROOT}/api/admin/queue/${encodeURIComponent(id)}/retry`, { method: "POST" });
}

export function discardJob(id: string): Promise<{ success: boolean }> {
  return fetchJson(`${ROOT}/api/admin/queue/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** When the request happened. The API sends `created_at`; the panel read `createdAt` and showed "Invalid Date". */
export function requestTraceTime(tr: Pick<RequestTrace, "created_at" | "createdAt">): string {
  return tr.created_at ?? tr.createdAt ?? "";
}
