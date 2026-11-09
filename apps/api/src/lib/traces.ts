/**
 * Kitsuden — Request traces in Postgres: the "glass box"
 * ============================================================================
 *
 * One row per request in `kitsuden_request_traces` (migration 0057): request_id,
 * actor (person, agent, anonymous), kon, operation, duration, database time,
 * queries, rows written and BLOCKS (a write by id that the
 * owner filter or RLS set aside; see engine/src/glass-box.ts).
 * It is shown in the panel (/traces → Requests) and in `GET /api/admin/requests`.
 *
 * Cost: it is NOT one write per request. Traces are gathered in memory and
 * written in batches (a multi-row INSERT) every `TRACES_FLUSH_MS` (2 s)
 * or on reaching 200, with the system connection and outside the request's
 * transaction (a request that rolls back still leaves its trace). Writes,
 * errors (≥400) and blocks are ALWAYS stored; successful reads
 * are sampled (`TRACES_READ_SAMPLING`, 0.1). If the in-memory queue
 * exceeds 5,000 (the database cannot keep up), new ones are dropped and a
 * warning is logged: tracing never slows down the API.
 *
 * Retention: daily partitions, `TRACES_RETENTION_DAYS` (7). Rotated
 * at startup and every hour.
 *
 * Off switch: `TRACES_ENABLED=false`. Off by default in tests and in pg-mem.
 *
 * OTLP (G2): with `OTEL_EXPORTER_OTLP_ENDPOINT`, each batch is also sent
 * as spans to that collector (otlp.ts). Optional; without it nothing goes out.
 */

import { readEnv } from "@kitsuden/shared";
import { sql } from "drizzle-orm";
import type { Context, Next } from "hono";

import { requestBlockings, requestMeasures } from "../../../../packages/engine/src/glass-box";
import { routeOperation } from "../../../../packages/engine/src/operations";
import { useRequest } from "../../../../packages/engine/src/request-scope";
import { db, isPgMem } from "../db";

import { inTesting } from "./environment";
import { pathKon } from "./kon-routes";
import { logger } from "./logger";
import { exportOtlpSpans, otlpConfigured } from "./otlp";

export interface Trace {
  createdAt: Date;
  requestId: string | null;
  traceId: string | null;
  method: string;
  route: string;
  status: number;
  actorType: "human" | "agent" | "anonymous";
  actorId: string | null;
  kon: string | null;
  operation: string | null;
  durationMs: number;
  dbTimeMs: number | null;
  queries: number | null;
  affectedRows: number | null;
  denials: number;
  lockDetails: unknown[] | null;
}

function number(name: string, defaultValue: number): number {
  const n = Number(readEnv(name));
  return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

export function tracesEnabled(): boolean {
  if (readEnv("TRACES_ENABLED") === "false") return false;
  if (readEnv("TRACES_ENABLED") === "true") return !isPgMem;
  return !isPgMem && !inTesting();
}

const READ = new Set(["GET", "HEAD", "OPTIONS"]);
/** What adds nothing to the glass box and is requested constantly. */
const WITHOUT_TRACE = /^\/(api\/health|health|metrics|api\/metrics|favicon\.ico|media\/)/;

/** The path without ids (like the access log): it groups and does not store identifiers. */
export function normalizedPath(c: Context): string {
  const rp = (c.req as unknown as { routePath?: string }).routePath;
  if (rp && rp !== "/*" && rp !== "*") return rp;
  return c.req.path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .slice(0, 300);
}

// ── The buffer and its writing ─────────────────────────────────────────────

const pendingItems: Trace[] = [];
const MAX_PENDING = 5000;
let timer: ReturnType<typeof setInterval> | null = null;
let rotation: ReturnType<typeof setInterval> | null = null;
let writing: Promise<void> | null = null;
let discardWarning = 0;

function enqueue(t: Trace): void {
  if (pendingItems.length >= MAX_PENDING) {
    if (Date.now() - discardWarning > 60_000) {
      discardWarning = Date.now();
      logger.warn("[traces] the database cannot keep up: new traces are being dropped");
    }
    return;
  }
  pendingItems.push(t);
  if (pendingItems.length >= 200) void dump();
}

async function insert(batch: Trace[]): Promise<void> {
  const rows = batch.map(
    (
      t
    ) => sql`(${t.createdAt.toISOString()}::timestamptz, ${t.requestId}, ${t.traceId}, ${t.method},
      ${t.route}, ${t.status}, ${t.actorType}, ${t.actorId}, ${t.kon}, ${t.operation},
      ${t.durationMs}, ${t.dbTimeMs}, ${t.queries}, ${t.affectedRows}, ${t.denials},
      ${t.lockDetails ? JSON.stringify(t.lockDetails) : null}::jsonb)`
  );
  await db.execute(sql`
    INSERT INTO kitsuden_request_traces
      (created_at, request_id, trace_id, method, route, status, actor_type, actor_id, kon, operation,
       duration_ms, db_time_ms, queries, rows_affected, denials, denial_details)
    VALUES ${sql.join(rows, sql`, `)}
  `);
}

/** Writes what is pending (one INSERT per batch). Never throws. */
export async function dump(): Promise<void> {
  if (writing) return writing;
  if (pendingItems.length === 0) return;
  const batch = pendingItems.splice(0, 500);
  writing = (async () => {
    try {
      try {
        await insert(batch);
      } catch {
        // The usual case: the day's partition is missing (midnight, or a new database).
        await rotate();
        await insert(batch);
      }
      if (otlpConfigured()) void exportOtlpSpans(batch);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), lost: batch.length },
        "[traces] could not write a batch"
      );
    } finally {
      writing = null;
    }
  })();
  return writing;
}

export async function rotate(): Promise<void> {
  try {
    await db.execute(sql`SELECT kitsuden_traces_rotate(${number("TRACES_RETENTION_DAYS", 7)})`);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[traces] rotation failed"
    );
  }
}

/** Starts the periodic flush and the rotation. Idempotent. */
export function startTraces(): void {
  if (!tracesEnabled() || timer) return;
  timer = setInterval(() => void dump(), number("TRACES_FLUSH_MS", 2000) || 2000);
  timer.unref?.();
  rotation = setInterval(() => void rotate(), 60 * 60_000);
  rotation.unref?.();
  void rotate();
}

export async function stopTraces(): Promise<void> {
  if (timer) clearInterval(timer);
  if (rotation) clearInterval(rotation);
  timer = rotation = null;
  await dump();
}

// ── El middleware ──────────────────────────────────────────────────────────

/** Is this request stored? Writes, errors and blocks always; reads, sampled. */
export function isSaved(
  method: string,
  status: number,
  blockings: number,
  random = Math.random()
): boolean {
  if (!READ.has(method) || status >= 400 || blockings > 0) return true;
  return random < number("TRACES_READ_SAMPLING", 0.1);
}

/**
 * Anonymous 404s kept per minute, across all paths. Every error is kept, and an
 * unmatched path gets a fresh limiter bucket per spelling (`/api/x1`, `/api/x2`),
 * so without this cap anyone turned requests into INSERTs into the main database.
 */
let window404 = { minute: 0, count: 0 };

export function fitsAnotherAnonymous404(now = Date.now()): boolean {
  const minute = Math.floor(now / 60_000);
  if (window404.minute !== minute) window404 = { minute, count: 0 };
  window404.count++;
  return window404.count <= number("TRACES_MAX_ANONYMOUS_404_PER_MINUTE", 60);
}

export function requestTraces() {
  return async (c: Context, next: Next): Promise<void> => {
    if (!tracesEnabled() || WITHOUT_TRACE.test(c.req.path)) {
      await next();
      return;
    }
    const start = performance.now();
    try {
      await next();
    } finally {
      try {
        const status = c.res?.status ?? 500;
        const blockings = requestBlockings();
        const get = c.get as (k: string) => unknown;
        const agent = get("agent") as { agentId?: string } | undefined;
        const user = get("user") as { id?: string } | null | undefined;
        const anonymous404 = status === 404 && !agent?.agentId && !user?.id;
        if (
          isSaved(c.req.method, status, blockings.length) &&
          (!anonymous404 || fitsAnotherAnonymous404())
        ) {
          const measures = requestMeasures();
          const op = routeOperation(c.req.method, c.req.path);
          enqueue({
            createdAt: new Date(),
            requestId: (get("requestId") as string | undefined) ?? useRequest()?.requestId ?? null,
            traceId: (get("traceId") as string | undefined) ?? useRequest()?.traceId ?? null,
            method: c.req.method,
            route: normalizedPath(c),
            status,
            actorType: agent?.agentId ? "agent" : user?.id ? "human" : "anonymous",
            actorId: agent?.agentId ?? user?.id ?? null,
            kon: op?.konId ?? pathKon(c.req.path),
            operation: op?.op.id ?? null,
            durationMs: Math.round(performance.now() - start),
            dbTimeMs: measures && measures.queries > 0 ? Math.round(measures.ms) : null,
            queries: measures ? measures.queries : null,
            affectedRows: measures ? measures.rows : null,
            denials: blockings.length,
            lockDetails: blockings.length ? blockings : null,
          });
        }
      } catch {
        // The trace is an extra: it never breaks the response.
      }
    }
  };
}

// ── Reading (panel) ────────────────────────────────────────────────────────

function rows(r: unknown): Array<Record<string, unknown>> {
  return ((r as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>;
}

export async function listTraces(o: {
  from: Date;
  limit: number;
  onlyBlockers: boolean;
  onlyErrors: boolean;
  actor: string | null;
}): Promise<Array<Record<string, unknown>>> {
  await dump();
  return rows(
    await db.execute(
      sql`SELECT * FROM kitsuden_traces_list(${o.from.toISOString()}::timestamptz, ${o.limit}, ${o.onlyBlockers}, ${o.actor}, ${o.onlyErrors})`
    )
  );
}

export async function traceSummary(from: Date): Promise<Array<Record<string, unknown>>> {
  await dump();
  return rows(
    await db.execute(sql`SELECT * FROM kitsuden_traces_summary(${from.toISOString()}::timestamptz)`)
  );
}
