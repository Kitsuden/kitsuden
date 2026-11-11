/**
 * The numbers and lists of the dashboard, mapped from what the API already answers:
 *
 *   agent audit logs     GET /api/admin/agents/logs      → calls and failures per day, per agent
 *   approvals audit      GET /api/approvals/audit        → the recent-changes feed (who asked, who decided)
 *   request summary      GET /api/admin/requests/summary → requests, errors, denials
 *   system               GET /api/health, /api/admin/queue, /api/admin/system/status
 *
 * Pure functions, so the page only fetches and draws.
 */
import { activityLabel } from "./dashboard-activity";

export interface AgentLog {
  id?: string;
  agentId?: string | null;
  action?: string | null;
  resource?: string | null;
  success?: boolean | null;
  createdAt?: string | null;
}

/** The logs route answers a bare array; an older shape wrapped it in `{ data }`. */
export function logsOf(body: unknown): AgentLog[] {
  if (Array.isArray(body)) return body as AgentLog[];
  const data = (body as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as AgentLog[]) : [];
}

const dayOf = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

export interface ActivityDay {
  [key: string]: string | number;
  day: string;
  calls: number;
  failures: number;
}

/** One row per day for the last `days` days (UTC), oldest first; days with nothing are zero. */
export function activitySeries(
  logs: AgentLog[],
  days: number,
  now: Date = new Date()
): ActivityDay[] {
  const out: ActivityDay[] = [];
  const index = new Map<string, ActivityDay>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const row = { day: d.toISOString().slice(0, 10), calls: 0, failures: 0 };
    out.push(row);
    index.set(row.day, row);
  }
  for (const log of logs) {
    const row = index.get(dayOf(log.createdAt) ?? "");
    if (!row) continue;
    row.calls += 1;
    if (log.success === false) row.failures += 1;
  }
  return out;
}

export interface ActivityTotals {
  calls: number;
  failures: number;
  /** Failures as a percentage of calls, one decimal; 0 with no calls. */
  failureRate: number;
  /** Calls in the later half of the window minus the earlier half. */
  delta: number;
}

export function activityTotals(series: ActivityDay[]): ActivityTotals {
  const calls = series.reduce((n, d) => n + d.calls, 0);
  const failures = series.reduce((n, d) => n + d.failures, 0);
  const half = Math.floor(series.length / 2);
  const sum = (rows: ActivityDay[]) => rows.reduce((n, d) => n + d.calls, 0);
  return {
    calls,
    failures,
    failureRate: calls > 0 ? Math.round((failures / calls) * 1000) / 10 : 0,
    delta: sum(series.slice(series.length - half)) - sum(series.slice(0, half)),
  };
}

export interface AgentName {
  id: string;
  name: string;
}

/** Calls per agent, busiest first, each linking to the agent. */
export function busiestAgents(
  logs: AgentLog[],
  agents: AgentName[],
  limit = 5
): Array<{ label: string; value: number; href?: string; note?: string }> {
  const names = new Map(agents.map((a) => [a.id, a.name]));
  const counts = new Map<string, { calls: number; failures: number }>();
  for (const log of logs) {
    if (!log.agentId) continue;
    const c = counts.get(log.agentId) ?? { calls: 0, failures: 0 };
    c.calls += 1;
    if (log.success === false) c.failures += 1;
    counts.set(log.agentId, c);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, limit)
    .map(([id, c]) => ({
      label: names.get(id) ?? id.slice(0, 8),
      value: c.calls,
      href: `/agents/${id}`,
      note: c.failures > 0 ? String(c.failures) : undefined,
    }));
}

export interface AuditEvent {
  id: string;
  at: string;
  action: string;
  agentId?: string | null;
  agentName?: string | null;
  proposalId?: string | null;
  by?: string | null;
  byName?: string | null;
  success?: boolean | null;
}

export interface FeedItem {
  id: string;
  at: string;
  /** What happened, in words. */
  title: string;
  /** The agent that asked, when one did. */
  agent?: string;
  /** The person who decided or changed it. */
  person?: string;
  tone: "default" | "accent" | "success" | "warning" | "error";
  href?: string;
}

const TONE: Array<[RegExp, FeedItem["tone"]]> = [
  [/(rejected|failed|denied|blocked|rolled_back)/, "error"],
  [/(approved|executed|activated|passed|done)/, "success"],
  [/(created|submitted|due|scheduled)/, "warning"],
  [/(changed|edit)/, "accent"],
];

/**
 * The recent-changes feed: approval and promotion events (which agent asked, which person
 * decided) and, for an administrator, the agents' own audit log. Newest first.
 */
export function changesFeed(
  events: AuditEvent[],
  logs: AgentLog[],
  agents: AgentName[],
  t: (key: string) => string,
  limit = 12
): FeedItem[] {
  const names = new Map(agents.map((a) => [a.id, a.name]));
  const items: FeedItem[] = events.map((e) => ({
    id: `audit:${e.id}`,
    at: e.at,
    title: activityLabel(e.action, t),
    agent: e.agentName ?? (e.agentId ? names.get(e.agentId) : undefined) ?? undefined,
    person: e.byName ?? undefined,
    tone:
      e.success === false ? "error" : (TONE.find(([re]) => re.test(e.action))?.[1] ?? "default"),
    href: e.proposalId ? `/approvals?proposal=${e.proposalId}` : "/activity?tab=audit",
  }));
  const seen = new Set(events.map((e) => e.id));
  for (const log of logs) {
    if (!log.createdAt || !log.action || (log.id && seen.has(log.id))) continue;
    items.push({
      id: `log:${log.id ?? `${log.agentId}:${log.createdAt}`}`,
      at: log.createdAt,
      title: activityLabel(log.action, t),
      agent: log.agentId ? (names.get(log.agentId) ?? undefined) : undefined,
      tone: log.success === false ? "error" : "default",
      href: log.agentId ? `/agents/${log.agentId}?tab=activity` : "/activity?tab=agents",
    });
  }
  return items
    .filter((i) => !Number.isNaN(new Date(i.at).getTime()))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, limit);
}

export interface OperationRow {
  requests: number;
  errors: number;
  denials: number;
  p95_ms: number;
  route: string;
  method: string;
}

export function requestTotals(operations: OperationRow[]): {
  requests: number;
  errors: number;
  denials: number;
  errorRate: number;
  slowest: OperationRow | null;
} {
  const requests = operations.reduce((n, o) => n + (Number(o.requests) || 0), 0);
  const errors = operations.reduce((n, o) => n + (Number(o.errors) || 0), 0);
  const denials = operations.reduce((n, o) => n + (Number(o.denials) || 0), 0);
  const slowest = operations.reduce<OperationRow | null>(
    (worst, o) => (!worst || Number(o.p95_ms) > Number(worst.p95_ms) ? o : worst),
    null
  );
  return {
    requests,
    errors,
    denials,
    errorRate: requests > 0 ? Math.round((errors / requests) * 1000) / 10 : 0,
    slowest,
  };
}

export type CheckState = "ok" | "warn" | "down" | "unknown";

export interface SystemCheck {
  id: "api" | "queue" | "deadJobs" | "kons" | "migrations";
  state: CheckState;
  /** A number or a short word to show next to the label (jobs, kons, migrations). */
  value?: string;
}

export interface SystemInput {
  /** `null`: not asked (an editor) or no answer yet. */
  apiOnline: boolean | null;
  queue?: { worker: string; dead?: unknown[] } | null;
  status?: {
    migrations?: { total?: number };
    kons?: { total?: number; active?: number };
  } | null;
}

/** The system status rows, each with a verdict; what could not be read is "unknown". */
export function systemChecks(input: SystemInput): SystemCheck[] {
  const checks: SystemCheck[] = [
    {
      id: "api",
      state: input.apiOnline === null ? "unknown" : input.apiOnline ? "ok" : "down",
    },
  ];
  if (input.queue !== undefined) {
    const q = input.queue;
    checks.push({
      id: "queue",
      state: !q
        ? "unknown"
        : q.worker === "running"
          ? "ok"
          : q.worker === "disabled"
            ? "warn"
            : "down",
      value: q?.worker,
    });
    const dead = q?.dead?.length ?? 0;
    checks.push({
      id: "deadJobs",
      state: !q ? "unknown" : dead > 0 ? "warn" : "ok",
      value: q ? String(dead) : undefined,
    });
  }
  if (input.status !== undefined) {
    const s = input.status;
    checks.push({
      id: "kons",
      state: s?.kons ? "ok" : "unknown",
      value: s?.kons ? `${s.kons.active ?? 0} / ${s.kons.total ?? 0}` : undefined,
    });
    checks.push({
      id: "migrations",
      state: s?.migrations ? "ok" : "unknown",
      value: s?.migrations ? String(s.migrations.total ?? 0) : undefined,
    });
  }
  return checks;
}

/** "5 min ago" from a timestamp, through Intl (so it follows the panel's language). */
export function timeAgo(iso: string, locale: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((then - now.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86400), "day");
}
