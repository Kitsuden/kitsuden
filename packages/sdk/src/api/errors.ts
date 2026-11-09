import type { KitsudenErrorCode } from "../generated/index";

import type { OperationInfo, Problem, ProposalPending, ResponseMeta } from "./types";

/** An `/api/*` error response (problem+json). `code` is the stable thing to branch on. */
export class KitsudenApiError extends Error {
  readonly name = "KitsudenApiError";
  readonly status: number;
  readonly code: KitsudenErrorCode | (string & {});
  readonly problem: Problem;
  readonly retryable: boolean;
  /** Seconds the server asked to wait (`Retry-After` or `retry_after`), or `null`. */
  readonly retryAfter: number | null;
  readonly requestId: string | null;
  readonly meta: ResponseMeta;

  constructor(problem: Problem, meta: ResponseMeta, retryAfter: number | null) {
    super(
      `${problem.code}: ${problem.detail || problem.title}${problem.hint ? ` (${problem.hint})` : ""}`
    );
    this.status = meta.status;
    this.code = problem.code;
    this.problem = problem;
    this.retryable = problem.retryable === true;
    this.retryAfter = retryAfter;
    this.requestId =
      meta.requestId ?? (typeof problem.requestId === "string" ? problem.requestId : null);
    this.meta = meta;
  }
}

/** The request never got an HTTP response (DNS, refused connection, timeout, abort). */
export class KitsudenNetworkError extends Error {
  readonly name = "KitsudenNetworkError";
  readonly operation: OperationInfo | null;
  readonly attempts: number;
  readonly timedOut: boolean;

  constructor(
    message: string,
    opts: { cause?: unknown; operation: OperationInfo | null; attempts: number; timedOut: boolean }
  ) {
    super(message, { cause: opts.cause });
    this.operation = opts.operation;
    this.attempts = opts.attempts;
    this.timedOut = opts.timedOut;
  }
}

/** A success response whose body could not be decoded in the format it declared. */
export class KitsudenDecodeError extends Error {
  readonly name = "KitsudenDecodeError";
  readonly meta: ResponseMeta;

  constructor(message: string, meta: ResponseMeta, cause?: unknown) {
    super(message, { cause });
    this.meta = meta;
  }
}

/**
 * Thrown only where a pending proposal cannot be returned as a value
 * (`pages()`, `iterate()`, `expectOk()`). Calling an operation never throws it:
 * it returns `{ kind: "proposal_pending" }`.
 */
export class ProposalPendingError extends Error {
  readonly name = "ProposalPendingError";
  readonly pending: ProposalPending;

  constructor(pending: ProposalPending) {
    super(
      `${pending.problem.code}: proposal ${pending.proposal.id} is waiting for human approval; ` +
        `nothing ran. Do not resend it; poll ${pending.proposal.statusUrl}.`
    );
    this.pending = pending;
  }
}

/** `true` if `e` is an API error, optionally with one of these codes. */
export function isKitsudenError<C extends KitsudenErrorCode>(
  e: unknown,
  ...codes: C[]
): e is KitsudenApiError & { code: C } {
  return (
    e instanceof KitsudenApiError && (codes.length === 0 || (codes as string[]).includes(e.code))
  );
}
