/**
 * Kitsuden — response format negotiation on /api/* (TOON, TRON, auto)
 *
 * By default the API responds with JSON, as always. A client can request another
 * format with the same information:
 *
 *   Accept: application/vnd.kitsuden.auto  or  ?format=auto  → the shortest
 *           of compact JSON / TOON / TRON for THIS response, verified
 *   Accept: application/vnd.toon           or  ?format=toon  → TOON
 *   Accept: application/vnd.tron           or  ?format=tron  → TRON
 *   Accept: application/json                               → JSON, always
 *           (even if the URL carries ?format=: the panel, Inti and the websites ask this way)
 *
 * The response says which format it uses with `Content-Type` and with the
 * `X-Kitsuden-Format: json|toon|tron` header. If the requested format cannot
 * represent the data losslessly, JSON is returned and the header says so.
 * The rules and the measurement are in lib/formats.ts and docs/agents/benchmarks.md.
 *
 * Errors are left untouched: they come out as application/problem+json (RFC 9457) for
 * all clients (middleware/problems-http.ts).
 */

import { type MiddlewareHandler } from "hono";

import { notifySavings, measureFormatSync } from "./format-measure";
import { FORMAT_HEADER, encodeResponse, requestedFormat, MIME } from "./formats";
import { encodeToon } from "./toon-tabular";

// ── MIME types ─────────────────────────────────────────────────
export const TOON_MIME = MIME.toon;
export const TRON_MIME = MIME.tron;
export const AUTO_MIME = MIME.auto;

// Re-export the canonical codec for consumers (SDK, tests).
export { encodeToon, decodeToon, ToonDecodeError } from "./toon-tabular";

/**
 * @deprecated Use `encodeToon`. It used to unwrap `{ data }` and dropped the sibling
 * keys (`view`, `profile`…): it no longer unwraps anything.
 */
export function encodeTOON(data: unknown): string {
  return encodeToon(data);
}

/** Per-shape cache key: method + path with the ids replaced by `:`. */
function routeKey(method: string, route: string): string {
  return `${method} ${route.replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}|\/\d+(?=\/|$)/gi, "/:")}`;
}

/**
 * Format negotiation middleware. Requests that ask for nothing
 * pass through untouched (not a byte of difference for JSON clients).
 */
export function toonMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const request = requestedFormat(c.req.header("accept"), c.req.query("format"));
    if (!request) return next();

    await next();

    if (c.res.status >= 400 || c.res.status === 204) return;
    const contentType = c.res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) return;

    let data: unknown;
    try {
      data = JSON.parse(await c.res.clone().text());
    } catch {
      return; // not real JSON: left as it was
    }

    const { value: output, measure: measure } = measureFormatSync(() =>
      encodeResponse(data, request.requested, {
        candidates: request.candidates,
        key: routeKey(c.req.method, c.req.path),
      })
    );
    // What it saved an AGENT (panel → quotas); nobody else is counted.
    notifySavings(
      (c.get as (k: string) => { agentId?: string } | undefined)("agent")?.agentId,
      "rest",
      measure
    );

    // Hono copies the headers of the previous Response to the new one (CORS, cache…)
    // except Content-Type; those describing the old body are removed.
    c.res = new Response(output.text, {
      status: c.res.status,
      headers: {
        "Content-Type": MIME[output.format],
        [FORMAT_HEADER]: output.format,
      },
    });
    c.res.headers.delete("content-length");
    c.res.headers.delete("etag");
    c.res.headers.append("Vary", "Accept");
  };
}
