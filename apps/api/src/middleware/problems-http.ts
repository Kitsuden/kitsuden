/**
 * All `/api/*` errors come out as `application/problem+json` (RFC 9457)
 * ============================================================================
 *
 * ── WHY AT THE OUTPUT AND NOT ROUTE BY ROUTE ───────────────────────────────
 *
 * There are hundreds of `c.json({ error: "…" }, 4xx)` scattered across the core and the
 * kons, plus `app.onError`, `app.notFound`, the limiter, the body limit,
 * the exhausted pool and the authorization gates, each with its own shape.
 * Migrating them one by one leaves out the next one that gets written (which is what already
 * happened with `errors-without-detail.ts`). This is the net: after the handler, if the
 * response is an error, it is rewritten with ONE shape:
 *
 *   { …whatever the route sent (including `error`, as is),
 *     type, title, status, detail, instance,
 *     code: "KITSUDEN_E_*", retryable, retry_after, hint, docs, requestId }
 *
 * The catalog of codes lives in `@kitsuden/shared` (`errors.ts`).
 *
 * ── COMPATIBILITY ──────────────────────────────────────────────────────────
 *
 * - `error` is kept with its original value (text or `{ code, message, details }`
 *   object); if the route did not send it, it carries the detail.
 *   The panel, the sites, Inti and the SDK read it.
 * - The other original fields are kept. If one collides with an
 *   RFC 9457 or Kitsuden name (`code`, `status`, `type`…), its old value moves
 *   to `legacy_<name>` instead of being lost.
 * - `/api/auth/*` is excluded (better-auth's own protocol: its client
 *   branches on its `code`).
 * - A JSON-RPC body (`"jsonrpc": "2.0"`, MCP) is not touched: it carries the same
 *   problem in `error.data` (see lib/problems-mcp.ts). What MCP never
 *   gets to see —the global authentication that rejects a key earlier— does
 *   get normalized.
 *
 * ── ORDER ──────────────────────────────────────────────────────────────────
 *
 * It goes OUTSIDE `poolExhaustedTo503` and `errorsWithoutDetail`: it sees the response
 * already decided (pool 503, 5xx without detail in production) and only shapes it.
 * If it went inside, `errorsWithoutDetail` would stop recognizing the body as
 * JSON (`problem+json` does not contain `application/json`) and in production the
 * internal detail of a 500 would be shown again.
 */
import {
  PROBLEM_JSON,
  buildProblem,
  errorCodeForStatus,
  errorCodeFromLegacy,
  parseRetryAfter,
  type ProblemDetails,
} from "@kitsuden/shared";
import type { Context, Next } from "hono";

/** Paths with their own error protocol. */
// `/api/oauth`: OAuth errors have their own shape (RFC 6749 §5.2:
// `{ error, error_description }`) and MCP clients read it as is.
export const EXCLUDED_FROM_PROBLEMS = ["/api/auth", "/api/oauth"];

/** Names that the problem sets; if the original body carried them, they become `legacy_*`. */
const RESERVED = new Set([
  "type",
  "title",
  "status",
  "detail",
  "instance",
  "code",
  "retryable",
  "retry_after",
  "hint",
  "docs",
]);

const MAX_DETAIL = 500;

function usefulText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_DETAIL) : null;
}

/**
 * Converts any error response into a problem. Pure: used by the
 * middleware and the tests.
 */
export function problemFromResponse(params: {
  status: number;
  /** JSON body already read (if the response was JSON). */
  body?: unknown;
  /** Text body (if it was not JSON). */
  text?: string;
  retryAfterHeader?: string | null;
  instance?: string;
  requestId?: string | null;
  traceId?: string | null;
}): ProblemDetails {
  const { status } = params;
  const body = params.body;
  const retryAfter = parseRetryAfter(params.retryAfterHeader ?? null);

  if (body && typeof body === "object" && !Array.isArray(body)) {
    const original = body as Record<string, unknown>;
    const fieldError = original.error;
    const errorObject =
      fieldError && typeof fieldError === "object" && !Array.isArray(fieldError)
        ? (fieldError as Record<string, unknown>)
        : null;

    const code =
      errorCodeFromLegacy(original.code) ??
      errorCodeFromLegacy(errorObject?.code) ??
      errorCodeForStatus(status);

    const detail =
      usefulText(original.message) ??
      usefulText(errorObject?.message) ??
      usefulText(fieldError) ??
      usefulText(original.detail) ??
      undefined;

    const extensions: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(original)) {
      if (key === "requestId" || key === "traceId") continue;
      if (RESERVED.has(key)) {
        // A `code` that is already in the catalog is not "legacy": it is the same datum.
        if (key === "code" && value === code) continue;
        extensions[`legacy_${key}`] = value;
      } else {
        extensions[key] = value;
      }
    }

    return buildProblem({
      code,
      status,
      detail,
      instance: params.instance,
      retryAfter,
      hint: usefulText(original.hint) ?? undefined,
      requestId:
        (typeof original.requestId === "string" ? original.requestId : null) ??
        params.requestId ??
        null,
      traceId: params.traceId ?? null,
      error: fieldError === undefined ? undefined : fieldError,
      extensions,
    });
  }

  const text = usefulText(params.text);
  return buildProblem({
    code: errorCodeForStatus(status),
    status,
    detail: text ?? undefined,
    instance: params.instance,
    retryAfter,
    requestId: params.requestId ?? null,
    traceId: params.traceId ?? null,
    extensions: Array.isArray(body) ? { data: body } : undefined,
  });
}

/**
 * Responds with a problem directly (for new code: idempotency,
 * gates). Sets `Retry-After` if there is a wait.
 */
export function respondProblem(
  c: Context,
  problem: ProblemDetails,
  extraHeaders: Record<string, string> = {}
): Response {
  const headers = new Headers({ "content-type": `${PROBLEM_JSON}; charset=utf-8` });
  if (problem.retry_after !== null) headers.set("retry-after", String(problem.retry_after));
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers,
  });
}

export function httpProblems(excludedOnes: string[] = EXCLUDED_FROM_PROBLEMS) {
  return async (c: Context, next: Next) => {
    await next();

    const path = c.req.path;
    if (!path.startsWith("/api/")) return;
    if (excludedOnes.some((p) => path === p || path.startsWith(`${p}/`))) return;

    const res = c.res;
    if (res.status < 400 || c.req.method === "HEAD") return;

    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (type.includes("problem+json") || type.includes("text/event-stream")) return;

    let body: unknown;
    let text: string | undefined;
    if (type.includes("json")) {
      body = await res
        .clone()
        .json()
        .catch(() => undefined);
    } else {
      text = await res
        .clone()
        .text()
        .catch(() => "");
      // An HTML body is not a message: without tags, the detail stays clean.
      if (type.includes("html")) text = undefined;
    }

    if (body && typeof body === "object" && (body as { jsonrpc?: unknown }).jsonrpc === "2.0") {
      return;
    }

    const get = c.get as (k: string) => unknown;
    const problem = problemFromResponse({
      status: res.status,
      body,
      text,
      retryAfterHeader: res.headers.get("retry-after"),
      instance: path,
      requestId: (get("requestId") as string | undefined) ?? null,
      traceId: (get("traceId") as string | undefined) ?? null,
    });

    const headers = new Headers(res.headers);
    headers.delete("content-length");
    headers.set("content-type", `${PROBLEM_JSON}; charset=utf-8`);
    if (problem.retry_after !== null && !headers.has("retry-after")) {
      headers.set("retry-after", String(problem.retry_after));
    }

    // Empty before assigning: Hono's setter copies the previous response's
    // headers onto the new one (including a stale `content-length`).
    c.res = undefined as unknown as Response;
    c.res = new Response(JSON.stringify(problem), { status: res.status, headers });
  };
}
