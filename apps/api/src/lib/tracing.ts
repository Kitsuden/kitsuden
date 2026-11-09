/**
 * Kitsuden — Distributed Tracing (W3C Trace Context)
 * ============================================================================
 *
 * Practice #2 (Distributed Tracing) + basis of #5 (Log-Trace Correlation) of the
 * observability manual.
 *
 * Implements a propagatable trace context compatible with W3C Trace Context
 * (`traceparent` header), held with AsyncLocalStorage so that ANY
 * code (logs, queries, jobs) can read the current trace_id/span_id without passing it
 * by hand. It is wire-interoperable with OpenTelemetry/Jaeger/Tempo: the
 * `traceparent` we emit is understood by any OTel collector, so migrating
 * to the OpenTelemetry SDK later is a drop-in replacement of this layer.
 *
 * traceparent format (W3C):  00-<trace_id:32hex>-<span_id:16hex>-<flags:2hex>
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TraceContext {
  traceId: string; // 32 hex
  spanId: string; // 16 hex (span actual)
  parentSpanId?: string; // parent span (if it arrived propagated)
  sampled: boolean;
  /** Human-readable requestId (correlation with existing logs). */
  requestId: string;
}

const als = new AsyncLocalStorage<TraceContext>();

// ── ID generation (W3C: random hex) ───────────────────────────────────────────

export function generateTraceId(): string {
  return randomBytes(16).toString("hex"); // 32 hex
}

export function generateSpanId(): string {
  return randomBytes(8).toString("hex"); // 16 hex
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * Parses an incoming `traceparent` header (W3C). Returns null if invalid.
 */
export function parseTraceparent(
  header: string | null | undefined
): { traceId: string; spanId: string; sampled: boolean } | null {
  if (!header) return null;
  const m = header.trim().match(TRACEPARENT_RE);
  if (!m) return null;
  const [, traceId, spanId, flags] = m;
  // all-zero trace_id / span_id are invalid per spec.
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 0x01) === 1 };
}

/** Serializes the current context as a `traceparent` header to propagate. */
export function toTraceparent(ctx: TraceContext): string {
  const flags = ctx.sampled ? "01" : "00";
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

// ── Deterministic sampling ────────────────────────────────────────────────────

/**
 * DETERMINISTIC probabilistic sampling based on the trace_id (not on Math.random),
 * so the same trace is sampled the same way in all services.
 * Practice #2: "do not trace 100% in production".
 */
export function shouldSample(traceId: string, ratio: number): boolean {
  if (ratio >= 1) return true;
  if (ratio <= 0) return false;
  // Uses the last 4 hex digits of the trace as a uniform value [0,1).
  const slice = parseInt(traceId.slice(-4), 16) / 0xffff;
  return slice < ratio;
}

const SAMPLE_RATIO = Number(process.env.TRACE_SAMPLE_RATIO ?? "1");

// ── Context lifecycle ─────────────────────────────────────────────────────────

export interface StartTraceOptions {
  traceparent?: string | null;
  requestId: string;
  /** Forces sampling (e.g. always sample on error — tail sampling). */
  forceSample?: boolean;
}

/**
 * Creates a TraceContext for a new request, continuing the incoming trace if
 * a valid `traceparent` arrived, or starting a new one.
 */
export function startTrace(options: StartTraceOptions): TraceContext {
  const incoming = parseTraceparent(options.traceparent);
  const traceId = incoming?.traceId ?? generateTraceId();
  const spanId = generateSpanId();
  const sampled =
    options.forceSample || (incoming ? incoming.sampled : shouldSample(traceId, SAMPLE_RATIO));

  return {
    traceId,
    spanId,
    parentSpanId: incoming?.spanId,
    sampled,
    requestId: options.requestId,
  };
}

/** Runs `fn` with the TraceContext active (accessible via getTraceContext()). */
export function runWithTrace<T>(ctx: TraceContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** Returns the active TraceContext (or undefined outside a request). */
export function getTraceContext(): TraceContext | undefined {
  return als.getStore();
}

/** Correlation fields to inject into logs (practice #5). */
export function getTraceLogFields(): { trace_id?: string; span_id?: string; requestId?: string } {
  const ctx = als.getStore();
  if (!ctx) return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId, requestId: ctx.requestId };
}
