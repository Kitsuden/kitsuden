/**
 * One HTTP call of the typed client: URL, headers, retries, decoding.
 *
 * Only `fetch`, `AbortController`, `Headers`, `URLSearchParams`, `TextDecoder`
 * and `crypto.getRandomValues` (all in Node 18+, Bun, Deno and browsers).
 */

import { decodeToon } from "../toon";

import { KitsudenApiError, KitsudenDecodeError, KitsudenNetworkError } from "./errors";
import { decodeTron } from "./tron";
import type {
  CallOptions,
  Format,
  OperationInfo,
  Outcome,
  Problem,
  Proposal,
  ProvenanceSummary,
  ResponseMeta,
  RetryPolicy,
} from "./types";

export const MIME = {
  json: "application/json",
  toon: "application/vnd.toon",
  tron: "application/vnd.tron",
  auto: "application/vnd.kitsuden.auto",
} as const;

export const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 60_000,
};

/** Statuses retried when the body is not a Kitsuden problem (a proxy in front, say). */
const RETRYABLE_WITHOUT_PROBLEM = new Set([408, 429, 502, 503, 504]);

export interface TransportConfig {
  baseUrl: string;
  token?: string;
  sessionCookie?: string;
  credentials?: RequestCredentials;
  fetch: typeof fetch;
  format: Format;
  provenance: boolean;
  untrustedWrap?: CallOptions["untrustedWrap"];
  headers: Record<string, string>;
  timeoutMs: number;
  retry: RetryPolicy;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  newIdempotencyKey: () => string;
}

/** A random key that matches the server's pattern (`^[A-Za-z0-9_.:-]+$`, 8–128). */
export function randomIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `ksdk-${hex}`;
}

function textValue(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** The URL of one call (path params encoded, query params like the MCP tools: text as is, the rest as JSON). */
export function buildUrl(
  baseUrl: string,
  info: OperationInfo,
  params: Record<string, unknown>
): string {
  let path = info.path;
  for (const name of info.pathParams) {
    const v = params[name];
    if (v === undefined || v === null || v === "") {
      throw new TypeError(`${info.operationId}: missing path parameter '${name}'`);
    }
    path = path.replace(`{${name}}`, encodeURIComponent(textValue(v)));
  }
  const q = new URLSearchParams();
  for (const name of info.queryParams) {
    const v = params[name];
    if (v === undefined || v === null) continue;
    q.set(name, textValue(v));
  }
  const qs = q.toString();
  return `${baseUrl}/api${path === "/" ? "" : path}${qs ? `?${qs}` : ""}`;
}

export function acceptFor(format: Format): string {
  return MIME[format];
}

export function parseProvenance(raw: string | null): ProvenanceSummary | null {
  if (!raw) return null;
  const out: ProvenanceSummary = { untrusted: 0, authors: {}, raw };
  for (const part of raw.split(";")) {
    const [k, v] = part.split("=").map((s) => s.trim());
    if (!k || v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    if (k === "untrusted") out.untrusted = n;
    else out.authors[k] = n;
  }
  return out;
}

/** `Retry-After` in seconds (delta or HTTP date), or `null`. */
export function parseRetryAfter(v: string | null, now = Date.now()): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const date = Date.parse(s);
  if (Number.isNaN(date)) return null;
  return Math.max(0, (date - now) / 1000);
}

function formatOf(
  contentType: string | null,
  header: string | null
): "json" | "toon" | "tron" | null {
  const f = header?.trim().toLowerCase();
  if (f === "json" || f === "toon" || f === "tron") return f;
  if (!contentType) return null;
  if (contentType.includes(MIME.toon)) return "toon";
  if (contentType.includes(MIME.tron)) return "tron";
  if (contentType.includes("json")) return "json";
  return null;
}

export function metaOf(
  res: Response,
  info: OperationInfo | null,
  key: string | null,
  attempts: number
): ResponseMeta {
  const contentType = res.headers.get("content-type");
  return {
    status: res.status,
    headers: res.headers,
    requestId: res.headers.get("x-request-id"),
    format: formatOf(contentType, res.headers.get("x-kitsuden-format")),
    contentType,
    provenance: parseProvenance(res.headers.get("x-kitsuden-provenance")),
    idempotencyKey: key,
    replayed: (res.headers.get("idempotent-replayed") ?? "").toLowerCase() === "true",
    attempts,
    operation: info,
  };
}

/** Decode a text body according to its declared format. */
export function decodeBody(text: string, format: "json" | "toon" | "tron" | null): unknown {
  if (format === "toon") return decodeToon(text);
  if (format === "tron") return decodeTron(text);
  return text.length === 0 ? null : JSON.parse(text);
}

export function problemOf(status: number, body: unknown, statusText: string): Problem {
  if (body && typeof body === "object" && typeof (body as Problem).code === "string") {
    const p = body as Problem;
    return { ...p, status: typeof p.status === "number" ? p.status : status };
  }
  // Not a Kitsuden problem (a proxy, an HTML page): synthesize one so callers have one shape.
  const detail =
    body && typeof body === "object" && "error" in body
      ? textValue((body as { error: unknown }).error)
      : typeof body === "string" && body
        ? body.slice(0, 500)
        : statusText || `HTTP ${status}`;
  return {
    type: "about:blank",
    title: statusText || `HTTP ${status}`,
    status,
    detail,
    code:
      status >= 500
        ? "KITSUDEN_E_INTERNAL"
        : status === 404
          ? "KITSUDEN_E_NOT_FOUND"
          : "KITSUDEN_E_BAD_REQUEST",
    retryable: RETRYABLE_WITHOUT_PROBLEM.has(status),
    retry_after: null,
    hint: "",
    docs: "",
    error: body,
  };
}

function backoffWait(attempt: number, r: RetryPolicy, random: () => number): number {
  const ceiling = Math.min(r.maxDelayMs, r.baseDelayMs * 2 ** attempt);
  return Math.round(random() * ceiling);
}

function readJsonSafe(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export interface RawRequest {
  info: OperationInfo;
  params: Record<string, unknown>;
  body?: unknown;
  options?: CallOptions;
}

/**
 * Run one operation. Returns `ok` or `proposal_pending`; throws
 * `KitsudenApiError` / `KitsudenNetworkError` / `KitsudenDecodeError`.
 *
 * Retries ONLY when it is safe: the operation reads, is declared idempotent,
 * or carries an `Idempotency-Key` (the server replays instead of running it
 * twice). And only on a network failure or a response the server marks
 * `retryable` (429, 503…), waiting what `Retry-After` says. A 202 approval is
 * never retried.
 */
export async function execute<T>(cfg: TransportConfig, req: RawRequest): Promise<Outcome<T>> {
  const { info, params } = req;
  const o = req.options ?? {};
  const policy: RetryPolicy =
    o.retry === false ? { ...cfg.retry, maxRetries: 0 } : { ...cfg.retry, ...(o.retry ?? {}) };
  const format = o.format ?? cfg.format;
  const url = buildUrl(cfg.baseUrl, info, params);
  const write = info.method !== "GET";

  const headers: Record<string, string> = { accept: acceptFor(format), ...cfg.headers };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  if (cfg.sessionCookie) headers.cookie = cfg.sessionCookie;
  if (o.provenance ?? cfg.provenance) headers["x-kitsuden-provenance"] = "1";
  const wrapper = o.untrustedWrap ?? cfg.untrustedWrap;
  if (wrapper) headers["x-kitsuden-untrusted-wrap"] = wrapper;

  let body: BodyInit | undefined;
  if (req.body !== undefined && info.body !== null) {
    if (info.body === "multipart") {
      body = req.body as BodyInit;
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify(req.body);
    }
  }

  let key: string | null = null;
  if (write && o.idempotencyKey !== false) {
    key = typeof o.idempotencyKey === "string" ? o.idempotencyKey : cfg.newIdempotencyKey();
    headers["idempotency-key"] = key;
  }
  Object.assign(headers, o.headers ?? {});

  const secure = !write || info.idempotent || info.readOnly || key !== null;
  const withRedirect = Object.values(info.responses).includes("redirect");
  const deadline = o.timeoutMs ?? cfg.timeoutMs;

  for (let attempt = 0; ; attempt++) {
    const attempts = attempt + 1;
    const ctl = new AbortController();
    let byDeadline = false;
    const timer =
      deadline > 0 ? setTimeout(() => ((byDeadline = true), ctl.abort()), deadline) : undefined;
    const onAbort = () => ctl.abort();
    o.signal?.addEventListener("abort", onAbort, { once: true });

    let res: Response;
    try {
      res = await cfg.fetch(url, {
        method: info.method,
        headers,
        body,
        signal: ctl.signal,
        ...(cfg.credentials ? { credentials: cfg.credentials } : {}),
        ...(withRedirect ? { redirect: "manual" as const } : {}),
      });
    } catch (err) {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      if (o.signal?.aborted) throw err;
      if (secure && attempt < policy.maxRetries) {
        await cfg.sleep(backoffWait(attempt, policy, cfg.random));
        continue;
      }
      throw new KitsudenNetworkError(
        `${info.method} ${url}: ${byDeadline ? `no response in ${deadline} ms` : ((err as Error)?.message ?? String(err))}`,
        { cause: err, operation: info, attempts, timedOut: byDeadline }
      );
    }

    try {
      const meta = metaOf(res, info, key, attempts);
      const type = (meta.contentType ?? "").toLowerCase();

      // ── 202: pending human approval. Never retried. ──
      // Recognized by its `code`, not by the media type: the API has sent it
      // both as application/problem+json and as application/json (measured
      // against a live API), and a client that asked for TOON/TRON may get it
      // in that format.
      if (res.status === 202 && (meta.format !== null || type.includes("json"))) {
        const t = await res.text();
        let p: unknown;
        try {
          p = decodeBody(t, type.includes("problem+json") ? "json" : meta.format);
        } catch {
          p = t;
        }
        const possible = p as (Problem & { proposal?: Proposal }) | null;
        if (
          possible &&
          typeof possible === "object" &&
          possible.code === "KITSUDEN_E_APPROVAL_REQUIRED"
        ) {
          return {
            kind: "proposal_pending",
            ok: false,
            status: 202,
            proposal: possible.proposal as Proposal,
            problem: possible,
            meta,
          };
        }
        return { kind: "ok", ok: true, status: 202, data: p as T, meta };
      }

      // ── Errors ──
      if (res.status >= 400 || (res.status >= 300 && !withRedirect)) {
        const raw = await res.text();
        const problem = problemOf(res.status, readJsonSafe(raw), res.statusText);
        const header = parseRetryAfter(res.headers.get("retry-after"));
        const wait =
          header ?? (typeof problem.retry_after === "number" ? problem.retry_after : null);
        const retryable = problem.retryable === true;
        if (retryable && secure && attempt < policy.maxRetries) {
          const ms = wait !== null ? wait * 1000 : backoffWait(attempt, policy, cfg.random);
          if (ms <= policy.maxRetryAfterMs) {
            await cfg.sleep(ms);
            continue;
          }
        }
        throw new KitsudenApiError(problem, meta, wait);
      }

      // ── Success ──
      const kind = info.responses[String(res.status)];
      if (
        kind === "redirect" ||
        (res.status >= 300 && res.status < 400) ||
        res.type === "opaqueredirect"
      ) {
        return {
          kind: "ok",
          ok: true,
          status: res.status,
          data: { status: res.status, location: res.headers.get("location") } as T,
          meta,
        };
      }
      if (res.status === 204 || kind === "empty") {
        return { kind: "ok", ok: true, status: res.status, data: null as T, meta };
      }
      const isText =
        meta.format !== null || type.startsWith("text/") || type.includes("javascript");
      if (kind === "binary" || (!isText && kind !== "json" && kind !== "text")) {
        return {
          kind: "ok",
          ok: true,
          status: res.status,
          data: (await res.arrayBuffer()) as T,
          meta,
        };
      }
      const t = await res.text();
      if (kind === "text" || (meta.format === null && !type.includes("json"))) {
        return { kind: "ok", ok: true, status: res.status, data: t as T, meta };
      }
      let data: unknown;
      try {
        data = decodeBody(t, meta.format);
      } catch (err) {
        throw new KitsudenDecodeError(
          `${info.operationId}: could not decode the ${meta.format ?? "json"} body`,
          meta,
          err
        );
      }
      return { kind: "ok", ok: true, status: res.status, data: data as T, meta };
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    }
  }
}
