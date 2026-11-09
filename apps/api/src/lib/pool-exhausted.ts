/**
 * Postgres pool exhausted → 503 with Retry-After, not 500
 * ============================================================================
 *
 * Under load (`GET /api/blog` in a burst) the pool ran out of free
 * connections: after `connectionTimeoutMillis` (a fixed 2 s) pg-pool
 * throws `timeout exceeded when trying to connect`. That is not a server
 * failure, it is «not right now»: a 503 with Retry-After tells the client (and
 * the sites' SSR, and a balancer) to retry, and it is not mistaken for
 * a real error in the logs.
 *
 * The problem is that almost all kons catch their errors and respond with their own
 * 500 (`{ error: "Failed to fetch posts" }`), so `app.onError`
 * never sees the pool error. That is why this works in two pieces:
 *
 *   1. `watchPool(pool)` wraps `pool.connect` (pg-pool also uses it
 *      inside `pool.query`) and, if the failure is an exhausted pool, it
 *      notes it on the current request (AsyncLocalStorage).
 *   2. `poolExhaustedTo503()`, an outer middleware, turns any 5xx response
 *      of a request so noted into 503 + Retry-After — whether
 *      `onError` or a kon's `catch` wrote it.
 *
 * Size and wait are configurable: `DB_POOL_MAX` (20) and
 * `DB_POOL_CONNECTION_TIMEOUT_MS` (5000; 2000 fell short in short
 * bursts, which is exactly when it is better to wait a bit than to fail).
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { Context, Next } from "hono";

/** Seconds the client is asked to wait before retrying. */
export const POOL_RETRY_AFTER_S = 5;

const POOL_EXHAUSTED_MESSAGES = [
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
];

/** Is it (or does it wrap, via `cause`) a failure to get a connection in time? */
export function isPoolExhausted(err: unknown): boolean {
  let actual: unknown = err;
  for (let i = 0; i < 5 && actual; i++) {
    const message = actual instanceof Error ? actual.message : String(actual);
    if (POOL_EXHAUSTED_MESSAGES.some((m) => message.includes(m))) return true;
    actual = actual instanceof Error ? actual.cause : undefined;
  }
  return false;
}

/** Pool configuration from the environment, with sensible defaults. */
export function poolConfiguration(env: Record<string, string | undefined> = process.env): {
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
} {
  const integer = (value: string | undefined, defaultValue: number, min: number, max: number) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= min && n <= max ? n : defaultValue;
  };
  return {
    max: integer(env.DB_POOL_MAX, 20, 1, 500),
    connectionTimeoutMillis: integer(env.DB_POOL_CONNECTION_TIMEOUT_MS, 5000, 100, 60_000),
    idleTimeoutMillis: integer(env.DB_POOL_IDLE_TIMEOUT_MS, 30_000, 1000, 600_000),
  };
}

interface Mark {
  exhausted: boolean;
}

const request = new AsyncLocalStorage<Mark>();

/** Notes the current request if the error is an exhausted pool. */
export function annotateIfPoolExhausted(err: unknown): void {
  if (!isPoolExhausted(err)) return;
  const mark = request.getStore();
  if (mark) mark.exhausted = true;
}

/** The minimum of pg-pool that is needed: `connect` with a promise or a callback. */
interface ConnectablePool {
  connect(...args: unknown[]): unknown;
}

/**
 * Wraps `pool.connect` to note exhausted-pool failures. It changes
 * nothing else: the error still reaches whoever was expecting it.
 */
export function watchPool<P extends ConnectablePool>(pool: P): P {
  const original = pool.connect.bind(pool);
  pool.connect = (...args: unknown[]) => {
    const callback = args[0];
    if (typeof callback === "function") {
      return original((err: unknown, ...rest: unknown[]) => {
        if (err) annotateIfPoolExhausted(err);
        callback(err, ...rest);
      });
    }
    const result = original();
    if (result instanceof Promise) {
      return result.catch((err: unknown) => {
        annotateIfPoolExhausted(err);
        throw err;
      });
    }
    return result;
  };
  return pool;
}

/**
 * Middleware: a request that ran out of connections and ends in 5xx goes out as
 * 503 + Retry-After with a generic message. It sits OUTSIDE `onError` and the
 * kons' `catch` blocks to see their final response.
 */
export function poolExhaustedTo503() {
  return async (c: Context, next: Next) => {
    const mark: Mark = { exhausted: false };
    await request.run(mark, () => next());
    if (mark.exhausted && c.res.status >= 500) {
      // Headers already set (CORS, trace) are kept: without them the
      // browser would not even let the 503 be read.
      const headers = new Headers(c.res.headers);
      headers.delete("content-length");
      headers.set("content-type", "application/json; charset=utf-8");
      headers.set("retry-after", String(POOL_RETRY_AFTER_S));
      c.res = new Response(
        JSON.stringify({
          error: "Service Unavailable",
          // Catalog code (@kitsuden/shared): problems-http respects it.
          code: "KITSUDEN_E_DB_POOL_EXHAUSTED",
          message: "The server is busy. Please retry shortly.",
          requestId: (c.get as (k: string) => unknown)("requestId") ?? null,
        }),
        { status: 503, headers }
      );
    }
  };
}
