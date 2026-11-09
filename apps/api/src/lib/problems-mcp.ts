/**
 * MCP errors (`/api/mcp`) with the same fields as the REST API
 * ============================================================================
 *
 * MCP is JSON-RPC: its errors cannot be `application/problem+json`
 * (the MCP client expects a JSON-RPC object). But an agent that uses both
 * routes has to be able to branch the same way. So the SAME problem
 * (`code: KITSUDEN_E_*`, `retryable`, `retry_after`, `hint`, `docs`…) goes:
 *
 *   - in a JSON-RPC error: in `error.data` (the place JSON-RPC 2.0 reserves
 *     for additional information). `error.code` and `error.message` do not change;
 *   - in the result of a tool that fails (`isError: true`): in
 *     `structuredContent`, and summarized in the text, which is what the model reads.
 *
 * Pure (no database or Hono) so it can be tested in isolation.
 */
import {
  buildProblem,
  errorCodeForStatus,
  errorCodeFromLegacy,
  isKitsudenErrorCode,
  type KitsudenErrorCode,
  type ProblemDetails,
} from "@kitsuden/shared";

const INSTANCE = "/api/mcp";

/** JSON-RPC code → catalog code when no other is given. */
function jsonRpcCode(code: number): KitsudenErrorCode {
  switch (code) {
    case -32700: // parse error
    case -32600: // invalid request
      return "KITSUDEN_E_BAD_REQUEST";
    case -32601: // method not found
    case -32002: // resource not found (MCP)
      return "KITSUDEN_E_NOT_FOUND";
    case -32602: // invalid params
      return "KITSUDEN_E_VALIDATION";
    case -32603:
      return "KITSUDEN_E_INTERNAL";
    default:
      return "KITSUDEN_E_BAD_REQUEST";
  }
}

export function mcpProblem(
  code: KitsudenErrorCode,
  detail: string,
  extra: { requestId?: string | null; hint?: string } = {}
): ProblemDetails {
  return buildProblem({
    code,
    detail,
    instance: INSTANCE,
    requestId: extra.requestId,
    hint: extra.hint,
  });
}

/** JSON-RPC error with the problem in `error.data`. */
export function errorJsonRpc(
  rpcCode: number,
  message: string,
  id: string | number | null,
  code?: KitsudenErrorCode,
  extra: { requestId?: string | null; hint?: string } = {}
) {
  return {
    jsonrpc: "2.0" as const,
    error: {
      code: rpcCode,
      message,
      data: mcpProblem(code ?? jsonRpcCode(rpcCode), message, extra),
    },
    id,
  };
}

/** Problem for an exception thrown inside a tool. */
export function exceptionProblem(err: unknown, message: string): ProblemDetails {
  const e = err as { code?: unknown; status?: unknown; statusCode?: unknown };
  const status =
    typeof e?.status === "number"
      ? e.status
      : typeof e?.statusCode === "number"
        ? e.statusCode
        : 500;
  const code =
    errorCodeFromLegacy(e?.code) ??
    (status === 500 ? codeByMessage(message) : null) ??
    errorCodeForStatus(status);
  return mcpProblem(code, message);
}

/**
 * The core tools (services/mcp-tools.ts) throw a bare `Error`
 * with fixed messages. Without this, «unknown tool» or «you are missing a
 * scope» would come out as INTERNAL and an agent would retry them.
 */
function codeByMessage(message: string): KitsudenErrorCode | null {
  if (/^Unknown (hardcoded )?MCP tool|^Tool not found/i.test(message))
    return "KITSUDEN_E_NOT_FOUND";
  if (/^Invalid arguments/i.test(message)) return "KITSUDEN_E_VALIDATION";
  if (/lacks required scope/i.test(message)) return "KITSUDEN_E_FORBIDDEN";
  return null;
}

/** Failed tool result (`isError: true`) with the problem. */
/**
 * The last net for a server error on its way to the model: in production, a
 * 5xx keeps its code, status and requestId but not its detail, unless the
 * agent has `admin` (the same rule as REST, `errorsWithoutDetail`). It covers
 * what the middleware cannot see: a problem+json a kon built itself, and the
 * `error` event of a flow, which travels inside a 200. 4xx are untouched: they
 * tell the agent what to fix.
 */
export function withoutServerDetail(
  problem: ProblemDetails,
  scopes: readonly string[],
  production: boolean
): ProblemDetails {
  const status = Number(problem.status) || 500;
  if (!production || status < 500 || scopes.includes("admin")) return problem;
  return buildProblem({
    code: isKitsudenErrorCode(problem.code) ? problem.code : errorCodeForStatus(status),
    status,
    instance: INSTANCE,
    retryAfter: typeof problem.retry_after === "number" ? problem.retry_after : null,
    requestId: typeof problem.requestId === "string" ? problem.requestId : null,
    traceId: typeof problem.traceId === "string" ? problem.traceId : null,
  });
}

export function errorResult(problem: ProblemDetails) {
  return {
    content: [{ type: "text" as const, text: problemText(problem) }],
    structuredContent: problem,
    isError: true as const,
  };
}

/**
 * What the model reads: the reason and, on one JSON line, the fields for
 * deciding (retry or not, how long to wait, what to do).
 */
export function problemText(problem: ProblemDetails): string {
  const summary = {
    code: problem.code,
    status: problem.status,
    retryable: problem.retryable,
    retry_after: problem.retry_after,
    hint: problem.hint,
    docs: problem.docs,
  };
  return `Error: ${problem.detail}\n${JSON.stringify(summary)}`;
}

/**
 * A tool result that already came with `isError: true` (the engine's
 * actions return `Error: …` as text): the problem is added without
 * touching the original text.
 */
export function withProblem<T extends { isError?: boolean; content?: unknown[] }>(
  result: T,
  code: KitsudenErrorCode = "KITSUDEN_E_BAD_REQUEST"
): T {
  if (!result?.isError || (result as { structuredContent?: unknown }).structuredContent) {
    return result;
  }
  const first = (result.content ?? [])[0] as { type?: string; text?: string } | undefined;
  const detail = (first?.text ?? "").replace(/^Error:\s*/, "") || "Tool failed";
  const problem = mcpProblem(code, detail);
  return {
    ...result,
    content: [
      ...(result.content ?? []),
      { type: "text", text: problemText(problem).split("\n").slice(1).join("\n") },
    ],
    structuredContent: problem,
  };
}
