/**
 * Kitsuden — Telemetry Middleware
 * ============================================================================
 *
 * Brings together the 5 observability practices at request level:
 *
 *   requestContextMiddleware()  → creates/continues the W3C TraceContext, puts it in
 *                                 AsyncLocalStorage, sets requestId and responds
 *                                 with the `traceparent` header (propagation).
 *   accessLogAndMetrics()       → measures the request (status + latency), records
 *                                 it in the MetricsRegistry (real SLIs) and
 *                                 emits a structured access log already correlated
 *                                 with trace_id/span_id.
 *
 * It must be mounted early: requestContextMiddleware BEFORE everything else (so
 * the context is available in any later handler/middleware).
 */

import { runInRequestScope, type RequestScope } from "@kitsuden/engine";
import type { Context, Next } from "hono";

import { logger } from "../lib/logger";
import { recordRequest } from "../lib/metrics";
import { logPath } from "../lib/route-for-log";
import { startTrace, runWithTrace, toTraceparent, getTraceContext } from "../lib/tracing";

/**
 * Creates the TraceContext and runs the rest of the request inside its ALS scope.
 * Replaces the old `requestId` middleware.
 */
export function requestContextMiddleware() {
  return async (c: Context, next: Next) => {
    const requestId = crypto.randomUUID();
    const ctx = startTrace({
      traceparent: c.req.header("traceparent"),
      requestId,
    });

    // Expose in the Hono context (compat with code that reads requestId).
    c.set("requestId", requestId);
    c.set("traceId", ctx.traceId);
    c.set("spanId", ctx.spanId);

    // Propagate the trace in the response (W3C).
    c.header("traceparent", toTraceparent(ctx));
    c.header("x-trace-id", ctx.traceId);
    c.header("x-request-id", requestId);

    // MUTABLE request scope: later middlewares (withTransactionalRLS)
    // enrich it with the RLS tx, and repo() uses it automatically.
    const scope: RequestScope = { requestId, traceId: ctx.traceId, services: {} };

    // Run the WHOLE pipeline inside the trace context AND the request scope.
    await runWithTrace(ctx, () => runInRequestScope(scope, () => next()));
  };
}

/**
 * Normalizes the route to a pattern (without ids) to group metrics by endpoint
 * and not blow up cardinality. E.g.: /api/data-sets/abc-123/entries →
 * /api/data-sets/:id/entries.
 */
function routePattern(c: Context): string {
  // Hono exposes the matched pattern in c.req.routePath when there is a match.
  const rp = (c.req as unknown as { routePath?: string }).routePath;
  if (rp && rp !== "/*") return rp;
  // Deterministic fallback: replace UUIDs and numbers with :id.
  return c.req.path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:id")
    .replace(/\/\d+/g, "/:id");
}

/**
 * Measures the request and emits the structured access log. Replaces the old
 * "Request started/completed" middleware.
 */
export function accessLogAndMetrics() {
  return async (c: Context, next: Next) => {
    const start = Date.now();
    let error: unknown;
    try {
      await next();
    } catch (err) {
      error = err;
      throw err;
    } finally {
      const durationMs = Date.now() - start;
      const status = error ? 500 : c.res.status;
      const route = routePattern(c);

      recordRequest({ method: c.req.method, route, status, durationMs });

      const ctx = getTraceContext();
      const fields = {
        type: "access",
        method: c.req.method,
        // No tokens: see lib/route-for-log.ts
        path: logPath(c.req.path),
        route,
        status,
        durationMs,
        userId: c.get("user")?.id ?? "anonymous",
        userAgent: c.req.header("user-agent"),
        // trace_id/span_id are already added by the logger mixin, but we leave them
        // explicit in case the sink does not apply the mixin.
        trace_id: ctx?.traceId,
        span_id: ctx?.spanId,
      };

      if (status >= 500) logger.error(fields, "request failed");
      else if (status >= 400) logger.warn(fields, "request client error");
      else logger.info(fields, "request completed");
    }
  };
}
