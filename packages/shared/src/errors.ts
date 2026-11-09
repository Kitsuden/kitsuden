/**
 * Catalog of Kitsuden API errors (RFC 9457, `application/problem+json`)
 * ============================================================================
 *
 * An agent cannot read "HTTP 409" and guess whether to retry, wait or
 * change the request. That is why every error response from `/api/*` carries:
 *
 *   - `code`        — stable, from this catalog (`KITSUDEN_E_*`). It is the
 *                     contract: it is not renamed or reused for something else.
 *   - `retryable`   — whether repeating the SAME request might succeed.
 *   - `retry_after` — seconds to wait before retrying (or `null`).
 *   - `hint`        — what to do, in one sentence.
 *   - `docs` and `type` — the URL of this code's entry in the public guide.
 *
 * And the RFC 9457 fields: `type`, `title`, `status`, `detail`, `instance`.
 *
 * The `error` field is kept exactly as each route sent it (text or object
 * `{ code, message, details }`): the panel, the websites, Inti and the SDK read it.
 *
 * Only the catalog and the body construction live here (pure, no Hono):
 * the API (output middleware), the MCP server and the clients share them.
 * The public guide is `docs/install/errors-and-retries.md`; a test checks
 * that every code has its entry there.
 */

/** Where the error guide lives (each code is an anchor on that page). */
export const ERROR_DOCS =
  "https://github.com/Kitsuden/kitsuden/blob/main/docs/install/errors-and-retries.md";

export interface ErrorCatalogEntry {
  /** HTTP status it normally comes out with. */
  status: number;
  /** Short, stable title (RFC 9457 `title`). */
  title: string;
  /** Might repeating the same request succeed? */
  retryable: boolean;
  /** Suggested wait in seconds if the response has no `Retry-After`. */
  retryAfter?: number;
  /** What to do, in one sentence. */
  hint: string;
}

/**
 * The catalog. Adding is compatible; renaming or removing a code is NOT
 * (there are agents that branch on it).
 */
export const KITSUDEN_ERRORS = {
  KITSUDEN_E_BAD_REQUEST: {
    status: 400,
    title: "Bad request",
    retryable: false,
    hint: "Fix the request (syntax, parameters or headers) before sending it again.",
  },
  KITSUDEN_E_VALIDATION: {
    status: 422,
    title: "Validation failed",
    retryable: false,
    hint: "Correct the fields listed in `error.details` and send the request again.",
  },
  KITSUDEN_E_UNAUTHENTICATED: {
    status: 401,
    title: "Authentication required",
    retryable: false,
    hint: "Send a valid session cookie or an `Authorization: Bearer kitsuden_agent_…` key.",
  },
  KITSUDEN_E_LEGACY_KEY_RETIRED: {
    status: 401,
    title: "Legacy API key retired",
    retryable: false,
    hint: "`kitsuden_sk_*` keys no longer work. Create an agent identity and use its `kitsuden_agent_*` key.",
  },
  KITSUDEN_E_FORBIDDEN: {
    status: 403,
    title: "Forbidden",
    retryable: false,
    hint: "The caller is authenticated but lacks the role or scope this operation needs.",
  },
  KITSUDEN_E_NOT_FOUND: {
    status: 404,
    title: "Not found",
    retryable: false,
    hint: "Check the identifier or path. Every route is listed in GET /api/docs/openapi.json.",
  },
  KITSUDEN_E_METHOD_NOT_ALLOWED: {
    status: 405,
    title: "Method not allowed",
    retryable: false,
    hint: "The path exists; use one of the methods in the `Allow` header.",
  },
  KITSUDEN_E_CONFLICT: {
    status: 409,
    title: "Conflict",
    retryable: false,
    hint: "The current state of the resource does not allow this change. Read it again and decide.",
  },
  KITSUDEN_E_PAYLOAD_TOO_LARGE: {
    status: 413,
    title: "Payload too large",
    retryable: false,
    hint: "Send a smaller body (the limit is in `maxBytes` when known).",
  },
  KITSUDEN_E_UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    title: "Unsupported media type",
    retryable: false,
    hint: "Send the body with a supported `Content-Type` (usually `application/json`).",
  },
  KITSUDEN_E_RATE_LIMITED: {
    status: 429,
    title: "Too many requests",
    retryable: true,
    retryAfter: 60,
    hint: "Wait `retry_after` seconds before sending more requests.",
  },
  KITSUDEN_E_QUOTA_EXCEEDED: {
    status: 429,
    title: "Agent quota exceeded",
    retryable: true,
    retryAfter: 3600,
    hint: "This agent used up its daily writes or budget units. Wait `retry_after` seconds (until 00:00 UTC) or ask an admin to raise the quota.",
  },
  KITSUDEN_E_APPROVAL_REQUIRED: {
    status: 202,
    title: "Pending human approval",
    retryable: false,
    hint: "Nothing was executed yet: the request was stored as a proposal for a human to approve. Do not resend it; poll `proposal.statusUrl` (or the MCP tool `kitsuden_proposal_status`) until it is executed, rejected or expired.",
  },
  KITSUDEN_E_APPROVAL_UNSUPPORTED: {
    status: 403,
    title: "Request cannot be held for approval",
    retryable: false,
    hint: "This agent needs human approval for this request, but it cannot be stored as a proposal (it carries a secret, a file that is not an image, or a body that is too large). Ask a human to do it, or ask an admin to change the agent's approval mode.",
  },
  KITSUDEN_E_DENIED_UNATTENDED: {
    status: 403,
    title: "Refused in an unattended run",
    retryable: false,
    hint: "This request would wait for human approval, but nobody is attending this run, so it was refused instead and nothing was executed. Do what `alternative` says (usually: record the decision for a person with kitsuden_record_decision) rather than retrying.",
  },
  KITSUDEN_E_AGENT_SPONSOR_INVALID: {
    status: 403,
    title: "Agent signer no longer valid",
    retryable: false,
    hint: "This agent signs what it creates with a human signer that no longer exists or is no longer an admin or editor. An admin must assign a new signer in the panel (Agents → agent → Signer).",
  },
  KITSUDEN_E_IDEMPOTENCY_KEY_INVALID: {
    status: 422,
    title: "Invalid Idempotency-Key",
    retryable: false,
    hint: "Use 8-128 characters from [A-Za-z0-9_.:-]; a UUID works.",
  },
  KITSUDEN_E_IDEMPOTENCY_KEY_REUSED: {
    status: 422,
    title: "Idempotency-Key reused with a different request",
    retryable: false,
    hint: "This key was already used for a different method, path or body. Generate a new key for a new operation.",
  },
  KITSUDEN_E_IDEMPOTENCY_IN_PROGRESS: {
    status: 409,
    title: "Request with this Idempotency-Key still in progress",
    retryable: true,
    retryAfter: 1,
    hint: "Another request with the same key is running. Retry with the same key after `retry_after` seconds to get its result.",
  },
  KITSUDEN_E_IDEMPOTENCY_NOT_REPLAYABLE: {
    status: 409,
    title: "Original response cannot be replayed",
    retryable: false,
    hint: "The original request with this key already succeeded, but its response carried a secret or was too large to store. Read the resource instead of repeating the write.",
  },
  KITSUDEN_E_IDEMPOTENCY_UNAVAILABLE: {
    status: 503,
    title: "Idempotency store unavailable",
    retryable: true,
    retryAfter: 5,
    hint: "The request was NOT executed. Retry later with the same Idempotency-Key.",
  },
  KITSUDEN_E_INTERNAL: {
    status: 500,
    title: "Internal server error",
    retryable: false,
    hint: "Not caused by the request. Report the `requestId`; retry only if the operation is idempotent or carries an Idempotency-Key.",
  },
  KITSUDEN_E_BAD_GATEWAY: {
    status: 502,
    title: "Bad gateway",
    retryable: true,
    retryAfter: 5,
    hint: "An upstream service failed. Retry after `retry_after` seconds.",
  },
  KITSUDEN_E_UNAVAILABLE: {
    status: 503,
    title: "Service unavailable",
    retryable: true,
    retryAfter: 5,
    hint: "Temporary. Retry after `retry_after` seconds.",
  },
  KITSUDEN_E_DB_POOL_EXHAUSTED: {
    status: 503,
    title: "Database busy",
    retryable: true,
    retryAfter: 5,
    hint: "All database connections are in use. Retry after `retry_after` seconds.",
  },
  KITSUDEN_E_TIMEOUT: {
    status: 504,
    title: "Gateway timeout",
    retryable: true,
    retryAfter: 5,
    hint: "The operation took too long. Retry after `retry_after` seconds (with an Idempotency-Key for writes).",
  },
} as const satisfies Record<string, ErrorCatalogEntry>;

export type KitsudenErrorCode = keyof typeof KITSUDEN_ERRORS;

export function isKitsudenErrorCode(code: unknown): code is KitsudenErrorCode {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(KITSUDEN_ERRORS, code);
}

/** URL of a code's entry in the guide (the anchor is the lowercase code). */
export function errorDocsUrl(code: KitsudenErrorCode): string {
  return `${ERROR_DOCS}#${code.toLowerCase()}`;
}

/** The default code for an HTTP status. */
export function errorCodeForStatus(status: number): KitsudenErrorCode {
  switch (status) {
    case 400:
      return "KITSUDEN_E_BAD_REQUEST";
    case 401:
      return "KITSUDEN_E_UNAUTHENTICATED";
    case 403:
      return "KITSUDEN_E_FORBIDDEN";
    case 404:
      return "KITSUDEN_E_NOT_FOUND";
    case 405:
      return "KITSUDEN_E_METHOD_NOT_ALLOWED";
    case 409:
      return "KITSUDEN_E_CONFLICT";
    case 413:
      return "KITSUDEN_E_PAYLOAD_TOO_LARGE";
    case 415:
      return "KITSUDEN_E_UNSUPPORTED_MEDIA_TYPE";
    case 422:
      return "KITSUDEN_E_VALIDATION";
    case 429:
      return "KITSUDEN_E_RATE_LIMITED";
    case 502:
      return "KITSUDEN_E_BAD_GATEWAY";
    case 503:
      return "KITSUDEN_E_UNAVAILABLE";
    case 504:
      return "KITSUDEN_E_TIMEOUT";
    default:
      if (status >= 500) return "KITSUDEN_E_INTERNAL";
      if (status === 408) return "KITSUDEN_E_TIMEOUT";
      return "KITSUDEN_E_BAD_REQUEST";
  }
}

/**
 * Codes that already existed in the API (the engine's `ErrorCode`, `KonErrors`,
 * agent authentication) → their catalog code. Anything not here
 * is decided by the HTTP status.
 */
const LEGACY: Record<string, KitsudenErrorCode> = {
  BAD_REQUEST: "KITSUDEN_E_BAD_REQUEST",
  VALIDATION: "KITSUDEN_E_VALIDATION",
  VALIDATION_ERROR: "KITSUDEN_E_VALIDATION",
  UNAUTHENTICATED: "KITSUDEN_E_UNAUTHENTICATED",
  UNAUTHORIZED: "KITSUDEN_E_UNAUTHENTICATED",
  MISSING_AUTH: "KITSUDEN_E_UNAUTHENTICATED",
  INVALID_AUTH_FORMAT: "KITSUDEN_E_UNAUTHENTICATED",
  INVALID_KEY: "KITSUDEN_E_UNAUTHENTICATED",
  INVALID_KEY_FORMAT: "KITSUDEN_E_UNAUTHENTICATED",
  AGENT_NOT_FOUND: "KITSUDEN_E_UNAUTHENTICATED",
  AGENT_DEACTIVATED: "KITSUDEN_E_UNAUTHENTICATED",
  AUTH_ERROR: "KITSUDEN_E_UNAUTHENTICATED",
  LEGACY_KEY_RETIRED: "KITSUDEN_E_LEGACY_KEY_RETIRED",
  FORBIDDEN: "KITSUDEN_E_FORBIDDEN",
  NOT_FOUND: "KITSUDEN_E_NOT_FOUND",
  CONFLICT: "KITSUDEN_E_CONFLICT",
  RATE_LIMITED: "KITSUDEN_E_RATE_LIMITED",
  RATE_LIMIT_EXCEEDED: "KITSUDEN_E_RATE_LIMITED",
  INTERNAL: "KITSUDEN_E_INTERNAL",
};

/** Translates an old code (or one already in the catalog) to the catalog; `null` if unknown. */
export function errorCodeFromLegacy(code: unknown): KitsudenErrorCode | null {
  if (isKitsudenErrorCode(code)) return code;
  if (typeof code !== "string") return null;
  return LEGACY[code] ?? null;
}

/** Kitsuden `application/problem+json` body. */
export interface ProblemDetails {
  /** RFC 9457: URI of the problem type (the guide entry). */
  type: string;
  title: string;
  status: number;
  detail: string;
  /** Path of the request. */
  instance?: string;
  code: KitsudenErrorCode;
  retryable: boolean;
  /** Seconds; `null` if there is no suggested wait. */
  retry_after: number | null;
  hint: string;
  docs: string;
  requestId?: string | null;
  traceId?: string | null;
  /**
   * Compatibility: what the route used to send in `error` (text or object
   * `{ code, message, details }`). Always present.
   */
  error: unknown;
  [extension: string]: unknown;
}

export const PROBLEM_JSON = "application/problem+json";

/**
 * Builds the body of a problem.
 *
 * `retryAfter` (from the `Retry-After` header, if there was one) overrides the
 * catalog's default wait. `retryable` can be forced (e.g. a business 409
 * known to be transient), but by default it comes from the catalog.
 */
export function buildProblem(opts: {
  code: KitsudenErrorCode;
  status?: number;
  detail?: string;
  instance?: string;
  retryAfter?: number | null;
  retryable?: boolean;
  hint?: string;
  requestId?: string | null;
  traceId?: string | null;
  /** Compatibility value for `error`; by default, the `detail`. */
  error?: unknown;
  /** Extension fields (they do not override those of RFC 9457 or Kitsuden). */
  extensions?: Record<string, unknown>;
}): ProblemDetails {
  const input: ErrorCatalogEntry = KITSUDEN_ERRORS[opts.code];
  const docs = errorDocsUrl(opts.code);
  const detail = opts.detail?.trim() || input.title;
  const retryAfter =
    opts.retryAfter !== undefined && opts.retryAfter !== null
      ? opts.retryAfter
      : (input.retryAfter ?? null);
  const retryable = opts.retryable ?? input.retryable;

  return {
    // First what the route used to send: whoever reads the body as text (Inti
    // truncates at 300 characters) still sees the reason at the start.
    ...(opts.extensions ?? {}),
    error: opts.error === undefined ? detail : opts.error,
    type: docs,
    title: input.title,
    status: opts.status ?? input.status,
    detail,
    ...(opts.instance ? { instance: opts.instance } : {}),
    code: opts.code,
    retryable,
    retry_after: retryable ? retryAfter : null,
    hint: opts.hint ?? input.hint,
    docs,
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
    ...(opts.traceId !== undefined && opts.traceId !== null ? { traceId: opts.traceId } : {}),
  };
}

/**
 * Seconds from a `Retry-After` header (number or HTTP date). `null` if it is
 * not understood.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const clean = value.trim();
  if (/^\d+$/.test(clean)) return Number(clean);
  const date = Date.parse(clean);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}
