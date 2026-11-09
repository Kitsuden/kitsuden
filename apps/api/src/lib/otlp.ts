/**
 * Kitsuden — Export traces over OTLP, for those who already have their collector (plan G2)
 * ============================================================================
 *
 * The «glass box» (traces.ts) works without configuring anything: it stores in the
 * same Postgres and is seen in the panel. Those who ALREADY have OpenTelemetry (Jaeger,
 * Tempo, Honeycomb, Grafana…) can additionally receive each trace as a span:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
 *   OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer abc,x-tenant=kitsuden   (optional)
 *   OTEL_SERVICE_NAME=kitsuden-api                                          (optional)
 *
 * OTLP/HTTP with JSON (`POST {endpoint}/v1/traces`), the format any
 * collector has accepted since version 1.0 of the specification, with no
 * dependencies: one `fetch` per batch. The `trace_id` is the request's W3C one
 * (the same as in the `traceparent` header and in the logs), so the span
 * joins the distributed trace the collector already has.
 *
 * Best effort: if the collector does not respond, a warning is given (at most once
 * per minute) and the batch is lost for OTLP; it is already saved in Postgres.
 */

import { randomBytes } from "node:crypto";

import { logger } from "./logger";
import type { Trace } from "./traces";

export function otlpConfigured(): boolean {
  return Boolean(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  );
}

function tracesUrl(): string {
  const own = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (own) return own;
  return `${(process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").replace(/\/+$/, "")}/v1/traces`;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  for (const par of (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
    const i = par.indexOf("=");
    if (i > 0)
      h[par.slice(0, i).trim().toLowerCase()] = decodeURIComponent(par.slice(i + 1).trim());
  }
  return h;
}

type Attribute = { key: string; value: Record<string, unknown> };

function attribute(
  key: string,
  value: string | number | boolean | null | undefined
): Attribute | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}

/** A trace as an OTLP span (JSON). Exported for tests. */
export function spanOf(t: Trace): Record<string, unknown> {
  const fin = BigInt(t.createdAt.getTime()) * 1_000_000n;
  const start = fin - BigInt(Math.max(0, Math.round(t.durationMs * 1_000_000)));
  const traceId =
    t.traceId && /^[0-9a-f]{32}$/.test(t.traceId) ? t.traceId : randomBytes(16).toString("hex");
  return {
    traceId,
    spanId: randomBytes(8).toString("hex"),
    name: `${t.method} ${t.route}`,
    kind: 2, // SERVER
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: fin.toString(),
    attributes: [
      attribute("http.request.method", t.method),
      attribute("http.route", t.route),
      attribute("http.response.status_code", t.status),
      attribute("kitsuden.request_id", t.requestId),
      attribute("kitsuden.actor.type", t.actorType),
      attribute("kitsuden.actor.id", t.actorId),
      attribute("kitsuden.kon", t.kon),
      attribute("kitsuden.operation", t.operation),
      attribute("kitsuden.db.duration_ms", t.dbTimeMs),
      attribute("kitsuden.db.queries", t.queries),
      attribute("kitsuden.db.rows_written", t.affectedRows),
      attribute("kitsuden.blocked", t.denials),
    ].filter((a): a is Attribute => a !== null),
    status: t.status >= 500 ? { code: 2 } : { code: 0 },
  };
}

let notified = 0;

export async function exportOtlpSpans(batch: Trace[]): Promise<void> {
  if (!otlpConfigured() || batch.length === 0) return;
  const body = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: process.env.OTEL_SERVICE_NAME || "kitsuden-api" },
            },
          ],
        },
        scopeSpans: [{ scope: { name: "kitsuden.traces" }, spans: batch.map(spanOf) }],
      },
    ],
  };
  try {
    const res = await fetch(tracesUrl(), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    if (Date.now() - notified > 60_000) {
      notified = Date.now();
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "[otlp] the collector did not accept the span batch"
      );
    }
  }
}
