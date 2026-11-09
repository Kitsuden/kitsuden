/**
 * Kitsuden — Uniform Error Envelope
 * ============================================================================
 *
 * Closes the gap "uniform error handling (envelope + consistent codes)".
 * A single `AppError` type with a stable code + a formatter that ALWAYS
 * produces the same response shape. It is used by validation (FormRequest), the
 * Policies/Gates layer and the global `onError`.
 *
 * Shape of the error response (stable, correlated with the trace):
 *   {
 *     "error": { "code": "FORBIDDEN", "message": "...", "details"?: {...} },
 *     "requestId": "...", "traceId": "..."
 *   }
 */

import type { Context } from "hono";

// ── Code catalog (stable, machine-readable) ───────────────────────────────────

export const ErrorCode = {
  BAD_REQUEST: "BAD_REQUEST",
  VALIDATION: "VALIDATION",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

const CODE_STATUS: Record<ErrorCodeValue, number> = {
  BAD_REQUEST: 400,
  VALIDATION: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

// ── AppError ──────────────────────────────────────────────────────────────────

export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly status: number;
  readonly details?: unknown;
  /** true = safe to expose the message to the client even if it is a 5xx (rare). */
  readonly expose: boolean;

  constructor(
    code: ErrorCodeValue,
    message: string,
    options: { details?: unknown; status?: number; expose?: boolean } = {}
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? CODE_STATUS[code];
    this.details = options.details;
    this.expose = options.expose ?? this.status < 500;
  }

  // Ergonomic helpers (Laravel/Nestits-style abort helpers).
  static badRequest(message = "Bad request", details?: unknown) {
    return new AppError(ErrorCode.BAD_REQUEST, message, { details });
  }
  static validation(message = "Validation failed", details?: unknown) {
    return new AppError(ErrorCode.VALIDATION, message, { details });
  }
  static unauthenticated(message = "Authentication required") {
    return new AppError(ErrorCode.UNAUTHENTICATED, message);
  }
  static forbidden(message = "Forbidden", details?: unknown) {
    return new AppError(ErrorCode.FORBIDDEN, message, { details });
  }
  static notFound(message = "Not found", details?: unknown) {
    return new AppError(ErrorCode.NOT_FOUND, message, { details });
  }
  static conflict(message = "Conflict", details?: unknown) {
    return new AppError(ErrorCode.CONFLICT, message, { details });
  }
  static internal(message = "Internal server error") {
    return new AppError(ErrorCode.INTERNAL, message, { expose: false });
  }
}

// ── Serialization ─────────────────────────────────────────────────────────────

export interface ErrorEnvelope {
  error: { code: ErrorCodeValue; message: string; details?: unknown };
  requestId?: string;
  traceId?: string;
}

/**
 * Converts any error into a uniform envelope. Unknown errors are treated as
 * INTERNAL and do NOT expose their message in production.
 */
/**
 * Extracts a readable message from anything that was thrown.
 *
 * It exists so that `catch` blocks can type as `unknown` —which is the correct
 * thing, because in JavaScript you can throw a number— without each one having
 * to repeat the check. The alternative was `catch (e: any)`, which turns off the
 * checker right on the error path, where it is tested least and a mistake
 * costs the most.
 *
 * It walks `cause` because drivers wrap: the Postgres error often arrives with
 * an empty `message` and the real reason one level down.
 */
export function messageOf(err: unknown, defaultValue = "Unknown error"): string {
  const seen = new Set<unknown>();

  for (let cur: unknown = err; cur && !seen.has(cur); cur = (cur as { cause?: unknown }).cause) {
    seen.add(cur);
    if (typeof cur === "string" && cur.trim()) return cur;
    const m = (cur as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m;
  }

  return defaultValue;
}

/**
 * Is this an `AppError`, wherever it comes from?
 *
 * ── WHY `instanceof` IS NOT ENOUGH ─────────────────────────────────────────
 *
 * The API is served BUNDLED (`dist/index.js`, with the engine inside), and the
 * kons are imported at RUNTIME from their own file. Each import loads the
 * engine again, so there are two distinct `AppError` objects in memory: the one
 * inside the bundle and the one the kon sees. `instanceof` compares class
 * identity and gives `false` between them.
 *
 * Consequence measured on a real installation: a kon's `validateRequest`
 * rejected a request with `AppError(VALIDATION)` —which knows it is a 422— and
 * the global handler did not recognize it, so it fell to the generic path and
 * answered **500**. The MOBA screen showed "HTTP 500" for a malformed body: a
 * client error disguised as a server outage.
 *
 * And it is a PRODUCTION failure again: in development everything is imported
 * from the same place, there is a single class, and `instanceof` gets it right.
 *
 * It is checked by SHAPE, not by identity: an object with a known `code` and a
 * numeric `status` is an `AppError` for all intents and purposes. `instanceof`
 * stays first because it is exact when it matches.
 */
function isAppError(err: unknown): err is AppError {
  if (err instanceof AppError) return true;

  const e = err as { code?: unknown; status?: unknown; name?: unknown };
  return (
    typeof e?.status === "number" &&
    typeof e?.code === "string" &&
    Object.prototype.hasOwnProperty.call(CODE_STATUS, e.code)
  );
}

function codeByStatus(status: number): ErrorCodeValue {
  if (status >= 500) return ErrorCode.INTERNAL;
  switch (status) {
    case 401:
      return ErrorCode.UNAUTHENTICATED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 409:
      return ErrorCode.CONFLICT;
    case 422:
      return ErrorCode.VALIDATION;
    case 429:
      return ErrorCode.RATE_LIMITED;
    default:
      return ErrorCode.BAD_REQUEST;
  }
}

/**
 * The SQLSTATE of a Postgres error, found in the `cause` chain
 * (Drizzle wraps it in "Failed query: …" and leaves the `pg` one inside).
 */
export function sqlstateOf(err: unknown): string | null {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * A Postgres error that is the fault of the INPUT, not the server: the status
 * and a message without the query. Schemathesis found a dozen 500s that were
 * this: text with U+0000, a `0` where a uuid goes, an out-of-range number, a
 * duplicate.
 */
export function postgresInputError(
  err: unknown
): { status: number; code: ErrorCodeValue; message: string } | null {
  const status = sqlstateOf(err);
  if (!status) return null;
  if (status.startsWith("22")) {
    return {
      status: 400,
      code: ErrorCode.BAD_REQUEST,
      message: "A value does not have the format or range that is allowed.",
    };
  }
  if (status === "23505")
    return {
      status: 409,
      code: ErrorCode.CONFLICT,
      message: "A record with that unique value already exists.",
    };
  if (status === "23503")
    return {
      status: 409,
      code: ErrorCode.CONFLICT,
      message: "It refers to a nonexistent record.",
    };
  if (status === "23502" || status === "23514") {
    return {
      status: 422,
      code: ErrorCode.VALIDATION,
      message: "A required value is missing or does not meet a constraint.",
    };
  }
  return null;
}

export function toErrorEnvelope(
  err: unknown,
  ctx: { requestId?: string; traceId?: string; isDev?: boolean }
): { envelope: ErrorEnvelope; status: number } {
  const ofInput = isAppError(err) ? null : postgresInputError(err);
  if (ofInput) {
    return {
      status: ofInput.status,
      envelope: {
        error: { code: ofInput.code, message: ofInput.message },
        requestId: ctx.requestId,
        traceId: ctx.traceId,
      },
    };
  }
  if (isAppError(err)) {
    return {
      status: err.status,
      envelope: {
        error: {
          code: err.code,
          message: err.expose ? err.message : "Internal server error",
          details: err.details,
        },
        requestId: ctx.requestId,
        traceId: ctx.traceId,
      },
    };
  }

  // Error with .status (e.g. Hono's HTTPException) or .statusCode (`KonError`
  // from @kitsuden/shared: it used to come out as 500 even if it said 404).
  const withStatus = err as { status?: unknown; statusCode?: unknown };
  const candidate =
    typeof withStatus?.status === "number"
      ? withStatus.status
      : typeof withStatus?.statusCode === "number"
        ? withStatus.statusCode
        : 500;
  const status = candidate >= 400 && candidate <= 599 ? candidate : 500;
  const message = err instanceof Error ? err.message : "Internal server error";

  return {
    status,
    envelope: {
      error: {
        // The code comes from the status: a 404 HTTPException is NOT_FOUND, not
        // BAD_REQUEST (clients and the KITSUDEN_E_* catalog branch on it).
        code: codeByStatus(status),
        message: status >= 500 && !ctx.isDev ? "Internal server error" : message,
      },
      requestId: ctx.requestId,
      traceId: ctx.traceId,
    },
  };
}

/** Writes the envelope into the Hono response. */
export function respondError(c: Context, err: unknown): Response {
  // The key goes in a variable on purpose: `bun build` replaces the literal
  // expression `process.env.NODE_ENV` with its value AT COMPILE TIME, and in the
  // production image that froze it as "development" (500 messages to the client).
  const key = "NODE_ENV";
  const isDev = (process.env[key] ?? "development") === "development";
  const { envelope, status } = toErrorEnvelope(err, {
    requestId: c.get("requestId"),
    traceId: c.get("traceId"),
    isDev,
  });
  return c.json(envelope, status as 400);
}
