/**
 * Own time of each global middleware (for measuring, OFF by default)
 * ============================================================================
 *
 * With `KITSUDEN_PROFILE_MIDDLEWARE=<file.json>` in the environment, each
 * middleware registered with `app.use` in `index.ts` (and whatever is mounted
 * with `app.use` afterwards) is wrapped to measure its OWN TIME: what it takes
 * before calling `next()` plus what it takes after `next()` returns.
 * What is inside (routes and following middlewares) does not count. Every 5 s the
 * summary is written to that file: calls, total, mean and p95 per
 * middleware.
 *
 * Without the variable nothing is wrapped: not even an `if` per request. It does not change what
 * any middleware does or their order; it only measures. It is not for production (the
 * wrapper costs a few microseconds per layer); it is for `scripts/bench`.
 */

import { writeFileSync } from "node:fs";

import type { Context, Hono, MiddlewareHandler, Next } from "hono";

interface Measure {
  calls: number;
  totalMs: number;
  samples: number[];
}

const measures = new Map<string, Measure>();
/** Samples per middleware for the p95 (reservoir: sorting them on dump should cost little). */
const MAX_SAMPLES = 1000;

function annotate(name: string, ms: number): void {
  let m = measures.get(name);
  if (!m) {
    m = { calls: 0, totalMs: 0, samples: [] };
    measures.set(name, m);
  }
  m.calls++;
  m.totalMs += ms;
  if (m.samples.length < MAX_SAMPLES) m.samples.push(ms);
  else m.samples[Math.floor(Math.random() * MAX_SAMPLES)] = ms;
}

/** The summary sorted by total time (the heaviest on top). */
export function profileSummary(): {
  middleware: string;
  calls: number;
  totalMs: number;
  mediaMs: number;
  p95Ms: number;
}[] {
  return [...measures.entries()]
    .map(([middleware, m]) => {
      const order = [...m.samples].sort((a, b) => a - b);
      const p95 = order[Math.min(order.length - 1, Math.ceil(order.length * 0.95) - 1)] ?? 0;
      return {
        middleware,
        calls: m.calls,
        totalMs: Math.round(m.totalMs),
        mediaMs: Math.round((m.totalMs / m.calls) * 1000) / 1000,
        p95Ms: Math.round(p95 * 1000) / 1000,
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs);
}

/** For tests. */
export function clearProfile(): void {
  measures.clear();
}

/** Wraps a middleware to measure its own time. */
export function measureMiddleware(name: string, mw: MiddlewareHandler): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const t0 = performance.now();
    let before = -1;
    let inside = 0;
    const res = await mw(c, async () => {
      before = performance.now() - t0;
      const t1 = performance.now();
      try {
        await next();
      } finally {
        inside = performance.now() - t1;
      }
    });
    const total = performance.now() - t0;
    annotate(name, before < 0 ? total : total - inside);
    return res;
  };
}

/**
 * If `KITSUDEN_PROFILE_MIDDLEWARE` is set, replaces `app.use` with one
 * that wraps each middleware with its name (`<order> <path> <function>`) and
 * dumps the summary periodically. Returns whether it enabled it.
 */
export function activateMiddlewareProfile(app: Hono<any>, env = process.env): boolean {
  const file = env.KITSUDEN_PROFILE_MIDDLEWARE;
  if (!file) return false;
  const original = app.use.bind(app) as (...args: unknown[]) => unknown;
  let order = 0;
  (app as { use: unknown }).use = (...args: unknown[]) => {
    const route = typeof args[0] === "string" ? args[0] : "*";
    const handlers = typeof args[0] === "string" ? args.slice(1) : args;
    const wrappedItems = handlers.map((h) => {
      order++;
      const fn = h as MiddlewareHandler & { name?: string };
      const name = `${String(order).padStart(3, "0")} ${route} ${fn.name || "anonymous"}`;
      return measureMiddleware(name, fn);
    });
    return typeof args[0] === "string"
      ? original(args[0], ...wrappedItems)
      : original(...wrappedItems);
  };
  const dump = () => {
    try {
      writeFileSync(file, JSON.stringify(profileSummary(), null, 2));
    } catch {
      /* measuring must not take anything down */
    }
  };
  setInterval(dump, 5000).unref?.();
  process.on("exit", dump);
  return true;
}
