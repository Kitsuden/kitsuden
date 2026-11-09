/**
 * The typed Kitsuden client: one property per kon, one typed method per
 * operation, generated from the API's OpenAPI 3.1 (`src/generated/**`).
 *
 * @example
 * ```ts
 * import { createKitsuden } from "@kitsuden/sdk";
 *
 * const kitsuden = createKitsuden(); // KITSUDEN_API_URL + KITSUDEN_API_TOKEN
 * const res = await kitsuden.media.listMedia({ limit: 5 });
 * if (res.kind === "ok") console.log(res.data.docs.map((p) => p.title));
 * ```
 */

import { KONS, type KitsudenKons } from "../generated/index";

import { ProposalPendingError } from "./errors";
import { iterate, pages } from "./pagination";
import { streamEvents } from "./stream";
import { DEFAULT_RETRY, execute, randomIdempotencyKey, type TransportConfig } from "./transport";
import type {
  CallOptions,
  Format,
  Ok,
  OperationInfo,
  Outcome,
  RecordProvenance,
  RetryPolicy,
} from "./types";

export interface KitsudenApiOptions {
  /**
   * Origin of the API (`https://api.example.com`; a trailing `/api` is
   * accepted). Default: `KITSUDEN_API_URL`, else the page's origin in a
   * browser. There is no localhost default on purpose.
   */
  baseUrl?: string;
  /** Agent key (`kitsuden_agent_…`). Default: `KITSUDEN_API_TOKEN`. `null` = do not read the environment. */
  token?: string | null;
  /** Session cookie for server-side code (`better-auth.session_token=…`). */
  sessionCookie?: string;
  /** Browsers: `"include"` sends the panel's session cookie cross-origin. */
  credentials?: RequestCredentials;
  /** Default wire format for responses (default `json`). Bodies are always decoded. */
  format?: Format;
  /** Ask for provenance on every call (`X-Kitsuden-Provenance: 1`). */
  provenance?: boolean;
  untrustedWrap?: CallOptions["untrustedWrap"];
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Per-attempt timeout (default 30 s; `0` = none). */
  timeoutMs?: number;
  retry?: Partial<RetryPolicy> | false;
  /** Your own `fetch` (tests, proxies, instrumented clients). */
  fetch?: typeof fetch;
  /** Generator of `Idempotency-Key` values (default: 128 random bits). */
  idempotencyKey?: () => string;
  /** @internal tests */
  sleep?: (ms: number) => Promise<void>;
  /** @internal tests */
  random?: () => number;
}

function environment(name: string): string | undefined {
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    Deno?: { env?: { get?: (n: string) => string | undefined } };
  };
  try {
    const v = g.process?.env?.[name] ?? g.Deno?.env?.get?.(name);
    return v && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined; // Deno without --allow-env
  }
}

function origin(): string | undefined {
  const l = (globalThis as { location?: { origin?: string } }).location;
  return l?.origin && l.origin !== "null" ? l.origin : undefined;
}

export function normalizeBaseUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api$/, "");
}

type Call = (
  info: OperationInfo,
  params: Record<string, unknown>,
  options?: CallOptions
) => Promise<Outcome<unknown>>;

type Stream = (
  info: OperationInfo,
  params: Record<string, unknown>,
  options?: CallOptions
) => AsyncIterableIterator<unknown>;

function operation(call: Call, info: OperationInfo, stream: Stream) {
  if (info.stream) {
    const s = ((params?: Record<string, unknown>, options?: CallOptions) =>
      stream(info, params ?? {}, options)) as {
      (params?: Record<string, unknown>, options?: CallOptions): AsyncIterableIterator<unknown>;
      info: OperationInfo;
    };
    s.info = info;
    return Object.freeze(s);
  }
  const f = ((params?: Record<string, unknown>, options?: CallOptions) =>
    call(info, params ?? {}, options)) as {
    (params?: Record<string, unknown>, options?: CallOptions): Promise<Outcome<unknown>>;
    info: OperationInfo;
    pages?: unknown;
    iterate?: unknown;
  };
  f.info = info;
  if (info.pagination) {
    f.pages = (params?: Record<string, unknown>, options?: CallOptions) =>
      pages(call, info, params ?? {}, options);
    f.iterate = (params?: Record<string, unknown>, options?: CallOptions) =>
      iterate(call, info, params ?? {}, options);
  }
  return Object.freeze(f);
}

export interface RawCall extends CallOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  /** `json` (default) or `multipart` (pass a FormData). */
  bodyFormat?: "json" | "multipart";
}

// The kon properties are defined in the constructor from the generated table
// (`Object.defineProperty`), so the class cannot declare them itself; the
// interface gives them their types. Safe here: every merged member exists at
// runtime, which the "generated surface" test checks.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface KitsudenApi extends KitsudenKons {}

/** Typed client of a Kitsuden API. Every kon is a property; see `operations` for the list. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class KitsudenApi {
  readonly #cfg: TransportConfig;
  readonly #options: KitsudenApiOptions;

  constructor(options: KitsudenApiOptions = {}) {
    const base = options.baseUrl ?? environment("KITSUDEN_API_URL") ?? origin();
    if (!base) {
      throw new TypeError(
        "Kitsuden: no API URL. Pass { baseUrl } or set KITSUDEN_API_URL (the origin, e.g. http://localhost:13000)."
      );
    }
    const token =
      options.token === null ? undefined : (options.token ?? environment("KITSUDEN_API_TOKEN"));
    this.#options = options;
    const f = options.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (!f) throw new TypeError("Kitsuden: no fetch in this runtime; pass { fetch }.");
    this.#cfg = {
      baseUrl: normalizeBaseUrl(base),
      token,
      sessionCookie: options.sessionCookie,
      credentials: options.credentials,
      fetch: options.fetch ? f : (f.bind(globalThis) as typeof fetch),
      format: options.format ?? "json",
      provenance: options.provenance ?? false,
      untrustedWrap: options.untrustedWrap,
      headers: { ...(options.headers ?? {}) },
      timeoutMs: options.timeoutMs ?? 30_000,
      retry:
        options.retry === false
          ? { ...DEFAULT_RETRY, maxRetries: 0 }
          : { ...DEFAULT_RETRY, ...(options.retry ?? {}) },
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: options.random ?? Math.random,
      newIdempotencyKey: options.idempotencyKey ?? randomIdempotencyKey,
    };
    const call: Call = (info, params, opts) => {
      const { body, ...rest } = params;
      return execute(this.#cfg, { info, params: rest, body, options: opts });
    };
    const stream: Stream = (info, params, opts) => {
      const { body, ...rest } = params;
      return streamEvents(this.#cfg, { info, params: rest, body, options: opts });
    };
    for (const [kon, ops] of Object.entries(KONS)) {
      const group: Record<string, unknown> = {};
      for (const [name, info] of Object.entries(ops))
        group[name] = operation(call, info as OperationInfo, stream);
      Object.defineProperty(this, kon, { value: Object.freeze(group), enumerable: true });
    }
  }

  /** Base URL in use (origin, without `/api`). */
  get baseUrl(): string {
    return this.#cfg.baseUrl;
  }

  /** Every operation this client knows (kon, id, method, path, scope, MCP tool…), for discovery. */
  get operations(): OperationInfo[] {
    return Object.values(KONS).flatMap((ops) => Object.values(ops) as OperationInfo[]);
  }

  /** A copy with other defaults (`client.withOptions({ format: "auto" })`). */
  withOptions(options: KitsudenApiOptions): KitsudenApi {
    return new KitsudenApi({
      ...this.#options,
      baseUrl: this.#cfg.baseUrl,
      token: this.#cfg.token ?? null,
      ...options,
    });
  }

  /**
   * Any route, untyped (legacy routes without a contract). Same auth,
   * retries, idempotency, formats and approval handling as the typed methods.
   * `path` is under `/api` (`/health`, `/items/games`).
   */
  request<T = unknown>(
    method: OperationInfo["method"],
    path: string,
    call: RawCall = {}
  ): Promise<Outcome<T>> {
    const { query, body, bodyFormat, ...opts } = call;
    const clean = path.startsWith("/") ? path : `/${path}`;
    const info: OperationInfo = {
      kon: "",
      id: "",
      operationId: `${method} ${clean}`,
      method,
      path: clean,
      pathParams: [],
      queryParams: Object.keys(query ?? {}),
      body: body === undefined ? null : (bodyFormat ?? "json"),
      responses: {},
      idempotent: method === "GET" || method === "PUT" || method === "DELETE",
      readOnly: method === "GET",
      sensitive: false,
      scope: null,
      mcpTool: null,
      errors: [],
    };
    return execute<T>(this.#cfg, { info, params: { ...(query ?? {}) }, body, options: opts });
  }
}

/** `new KitsudenApi(options)`. */
export function createKitsuden(options: KitsudenApiOptions = {}): KitsudenApi {
  return new KitsudenApi(options);
}

/** The data of an `ok` outcome; throws `ProposalPendingError` if it is a pending proposal. */
export function expectOk<T>(outcome: Outcome<T>): T {
  if (outcome.kind === "ok") return outcome.data;
  throw new ProposalPendingError(outcome);
}

/** `true` when the outcome is a proposal waiting for a human. */
export function isProposalPending<T>(outcome: Outcome<T>): outcome is Exclude<Outcome<T>, Ok<T>> {
  return outcome.kind === "proposal_pending";
}

/** Who wrote this row (`_provenance`, present when the call asked for provenance). */
export function provenanceOf(row: unknown): RecordProvenance | null {
  const p = (row as { _provenance?: RecordProvenance } | null)?._provenance;
  return p && typeof p === "object" ? p : null;
}
