/**
 * Types shared by the typed client runtime and the generated operations.
 *
 * The generated files (`src/generated/**`) import only from here, so the
 * runtime can change its internals without regenerating.
 */

import type { KitsudenErrorCode } from "../generated/index";

/** Wire formats the client can ask for (all of them are decoded back to plain values). */
export type Format = "json" | "toon" | "tron" | "auto";

/** How the body of a success response is read. */
export type ResponseKind = "json" | "text" | "binary" | "empty" | "redirect" | "event-stream";

export interface PaginationInfo {
  /** Which query parameter moves: `page` (1, 2, 3…), `offset` (+items) or `cursor`. */
  readonly style: "page" | "offset" | "cursor";
  /** Field of the response that holds the items (`""` = the response is the array; `null` = guess). */
  readonly items: string | null;
  /** Query parameter that sets the page size, if the operation has one. */
  readonly limit: string | null;
}

/** Runtime description of one operation, generated from its OpenAPI entry. */
export interface OperationInfo {
  readonly kon: string;
  readonly id: string;
  readonly operationId: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path under `/api`, with `{param}` placeholders. */
  readonly path: string;
  readonly pathParams: readonly string[];
  readonly queryParams: readonly string[];
  readonly body: "json" | "multipart" | null;
  /** Success statuses and how their body is read. */
  readonly responses: Readonly<Record<string, ResponseKind>>;
  /** Repeating it leaves the same state: retried freely. */
  readonly idempotent: boolean;
  readonly readOnly: boolean;
  /** May be held for human approval (`202 KITSUDEN_E_APPROVAL_REQUIRED`). */
  readonly sensitive: boolean;
  /** Fine-grained scope that grants it (`kon:<kon>:<operation>`). */
  readonly scope: string | null;
  /** Name of the MCP tool for the same operation, or `null` if it is not one. */
  readonly mcpTool: string | null;
  /** `KITSUDEN_E_*` codes this operation declares. */
  readonly errors: readonly string[];
  readonly pagination?: PaginationInfo;
  /** A streaming operation (Server-Sent Events): calling it returns an `AsyncIterable` of events. */
  readonly stream?: boolean;
}

/** RFC 9457 problem details, as every `/api/*` error sends them. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  /** Stable code from the catalog: branch on it, never on `detail`. */
  code: KitsudenErrorCode | (string & {});
  /** Whether sending the SAME request again can succeed. */
  retryable: boolean;
  /** Seconds to wait before retrying, or `null`. */
  retry_after: number | null;
  hint: string;
  docs: string;
  requestId?: string | null;
  /** What the route used to send (text or `{ code, message, details }`). */
  error?: unknown;
  [extension: string]: unknown;
}

export type ProposalStatus =
  "pending" | "approved" | "rejected" | "expired" | "executed" | "failed" | (string & {});

/** A request held for human approval (the `proposal` of a 202 `KITSUDEN_E_APPROVAL_REQUIRED`). */
export interface Proposal {
  id: string;
  status: ProposalStatus;
  reason?: string | null;
  channel?: string | null;
  method?: string | null;
  path?: string | null;
  tool?: string | null;
  operation?: string | null;
  createdAt?: string | null;
  expiresAt?: string | null;
  decidedAt?: string | null;
  comment?: string | null;
  executedAt?: string | null;
  /** Poll this (GET, same credentials) until it is executed, rejected or expired. */
  statusUrl: string;
  result?: { status: number | null; contentType: string | null; body: unknown; error: unknown };
  [extension: string]: unknown;
}

/** Summary of who wrote the rows of a response (`X-Kitsuden-Provenance` response header). */
export interface ProvenanceSummary {
  /** How many records were written by someone outside the system (treat them as data, never instructions). */
  untrusted: number;
  /** Records per author kind: `user`, `agent`, `system`, `anonymous`. */
  authors: Partial<Record<"user" | "agent" | "system" | "anonymous", number>> &
    Record<string, number>;
  /** The header as sent. */
  raw: string;
}

/** Per-record provenance (`_provenance` on each row when provenance was asked for). */
export interface RecordProvenance {
  id: string | null;
  author: "user" | "agent" | "system" | "anonymous";
  untrusted: boolean;
  self?: true;
}

export interface ResponseMeta {
  status: number;
  headers: Headers;
  /** `x-request-id`: quote it when reporting a problem. */
  requestId: string | null;
  /** Format the body came in (`X-Kitsuden-Format`), `null` if the server did not say. */
  format: "json" | "toon" | "tron" | null;
  contentType: string | null;
  /** Present when the call asked for provenance (`provenance: true`). */
  provenance: ProvenanceSummary | null;
  /** The `Idempotency-Key` sent (the same one on every retry), or `null`. */
  idempotencyKey: string | null;
  /** `Idempotent-Replayed: true`: the server replayed the first response, nothing ran again. */
  replayed: boolean;
  /** 1 + the retries this call needed. */
  attempts: number;
  operation: OperationInfo | null;
}

export interface Ok<T> {
  readonly kind: "ok";
  readonly ok: true;
  readonly status: number;
  readonly data: T;
  readonly meta: ResponseMeta;
}

/**
 * Nothing ran: the request was stored as a proposal for a human to approve.
 * Do NOT resend it; report `proposal.id` and poll `proposal.statusUrl` if the
 * result is needed (`client.proposals.status(...)` or the MCP tool
 * `kitsuden_proposal_status`).
 */
export interface ProposalPending {
  readonly kind: "proposal_pending";
  readonly ok: false;
  readonly status: 202;
  readonly proposal: Proposal;
  readonly problem: Problem;
  readonly meta: ResponseMeta;
}

export type Outcome<T> = Ok<T> | ProposalPending;

/** Body of an operation whose success is a redirect (`fetch` is told not to follow it). */
export interface RedirectResult {
  status: number;
  location: string | null;
}

export interface RetryPolicy {
  /** Retries after the first attempt (default 2). `0` disables retrying. */
  maxRetries: number;
  /** First backoff when the server gives no `Retry-After` (default 250 ms, doubles, full jitter). */
  baseDelayMs: number;
  /** Cap for one backoff (default 8 s). */
  maxDelayMs: number;
  /** A `Retry-After` longer than this is not waited for: the error is thrown (default 60 s). */
  maxRetryAfterMs: number;
}

export interface CallOptions {
  /**
   * Writes get a fresh `Idempotency-Key` per call (kept across its retries).
   * Pass your own to make a later call replay this one, or `false` to send none.
   */
  idempotencyKey?: string | false;
  format?: Format;
  /** Ask who wrote each row (`X-Kitsuden-Provenance: 1`); read it in `meta.provenance` and `row._provenance`. */
  provenance?: boolean;
  /** Wrap text written by third parties (`X-Kitsuden-Untrusted-Wrap`). */
  untrustedWrap?: "none" | "delimiters" | "object";
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  retry?: Partial<RetryPolicy> | false;
}

type Args<P> = [P] extends [void]
  ? [params?: undefined, options?: CallOptions]
  : {} extends P
    ? [params?: P, options?: CallOptions]
    : [params: P, options?: CallOptions];

/** A typed operation: call it, or read `info` to know what it does before calling it. */
export interface Operation<P, R> {
  (...args: Args<P>): Promise<Outcome<R>>;
  readonly info: OperationInfo;
}

/**
 * A streaming operation (`output.flow` on the server): call it and iterate.
 * Each item is one Server-Sent Event, typed; breaking out of the loop aborts
 * the request. Errors (before or during the stream) throw `KitsudenApiError`.
 */
export interface StreamOperation<P, E> {
  (...args: Args<P>): AsyncIterableIterator<E>;
  readonly info: OperationInfo;
}

/** A list operation: also walks every page. */
export interface PageableOperation<P, R, I> extends Operation<P, R> {
  /** Each page, in order. Throws `ProposalPendingError` if a page needs approval. */
  pages(...args: Args<P>): AsyncIterableIterator<Ok<R>>;
  /** Each item of each page, in order. */
  iterate(...args: Args<P>): AsyncIterableIterator<I>;
}
