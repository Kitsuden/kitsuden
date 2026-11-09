/**
 * `Idempotency-Key` on all writes of `/api/*`
 * ============================================================================
 *
 * Optional for the client: without the header, nothing changes. With it, on
 * POST/PUT/PATCH/DELETE:
 *
 *   - first time: the key is reserved, it runs, the response is stored;
 *   - retry with the SAME request: the stored response is replayed
 *     (status, allowlisted headers and body) with
 *     `Idempotent-Replayed: true`, without executing anything;
 *   - same key with a DIFFERENT request (method, path, query or body): 422
 *     `KITSUDEN_E_IDEMPOTENCY_KEY_REUSED`;
 *   - same key while the first is still running: 409
 *     `KITSUDEN_E_IDEMPOTENCY_IN_PROGRESS` with `Retry-After: 1`;
 *   - no store (Valkey down and no table): 503
 *     `KITSUDEN_E_IDEMPOTENCY_UNAVAILABLE` WITHOUT executing (fail-closed; see
 *     below).
 *
 * The key is stored per ACTOR (agent, user or, without a session, the client's
 * IP): the same key from two actors is two different operations, and
 * nobody can read another's response by guessing their key.
 *
 * ── FAIL-CLOSED BY DEFAULT ─────────────────────────────────────────────────
 *
 * Whoever sends `Idempotency-Key` is saying "this write cannot be
 * done twice" (a charge, an order, a shipment). If there is nowhere to
 * record it, executing it anyway (fail-open) silently breaks exactly that promise:
 * the agent's retry would duplicate it. A retryable 503, on the other hand, does no
 * harm: the operation was not performed and the agent knows it must retry with
 * the same key. And it only affects requests that carry the header.
 * `IDEMPOTENCY_FAIL_MODE=open` exists for whoever prefers availability.
 *
 * ── WHAT IS LEFT OUT ───────────────────────────────────────────────────────
 *
 *   - `/api/auth/*`: logins and sign-ups set session cookies; replaying
 *     that response would be handing out a session.
 *   - `/api/mcp`: it is a JSON-RPC transport with a session; the idempotency of
 *     MCP tools will come with the operation declaration.
 *   - Streaming responses (`text/event-stream`).
 *   - Routes mounted in `index.ts` BEFORE this middleware (`/api/system`,
 *     `/api/admin/system`, admin only).
 *
 * kon-ecommerce additionally keeps its own order idempotency in the database
 * (tied to the buyer's email and without expiry): it is the durable net beneath
 * this one, which expires after 24 h.
 */
import { buildProblem } from "@kitsuden/shared";
import type { Context, Next } from "hono";

import { clientIp } from "../lib/client-ip";
import {
  StoreUnavailable,
  VALID_IDEMPOTENCY_KEY,
  repeatableHeaders,
  storageKey,
  idempotencyConfig,
  bodyWithSecret,
  requestFingerprint,
  newToken,
  reserveInChain,
  statusIsSaved,
  type IdempotencyStore,
  type IdempotencyConfig,
  type Registry,
} from "../lib/idempotency";

import { respondProblem } from "./problems-http";

const METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const EXCLUDED_FROM_IDEMPOTENCY = ["/api/auth", "/api/mcp"];

function excluded(path: string, excludedOnes: string[]): boolean {
  return excludedOnes.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Who makes the request, to keep their keys apart from everyone else's. */
export function actorOf(c: Context): string {
  const get = c.get as (k: string) => unknown;
  const agent = get("agent") as { agentId?: string } | undefined;
  if (agent?.agentId) return `agent:${agent.agentId}`;
  const user = get("user") as { id?: string } | null | undefined;
  if (user?.id) return `user:${user.id}`;
  return `anon:${clientIp(c)}`;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(text: string): ArrayBuffer {
  const b = Buffer.from(text, "base64");
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export interface IdempotencyOptions {
  /** Stores in order of preference (default: Valkey → Postgres). */
  stores: () => IdempotencyStore[];
  config?: IdempotencyConfig;
  excludedOnes?: string[];
  /** To warn in the log when there is no store (without coupling to the logger). */
  notify?: (message: string, data: Record<string, unknown>) => void;
}

export function idempotency(options: IdempotencyOptions) {
  const config = options.config ?? idempotencyConfig();
  const excludedOnes = options.excludedOnes ?? EXCLUDED_FROM_IDEMPOTENCY;

  return async (c: Context, next: Next) => {
    if (!METHODS.has(c.req.method)) return next();
    const path = c.req.path;
    if (!path.startsWith("/api/") || excluded(path, excludedOnes)) return next();

    const key = c.req.header("idempotency-key");
    if (key === undefined) return next();

    const get = c.get as (k: string) => unknown;
    const requestId = (get("requestId") as string | undefined) ?? null;

    if (!VALID_IDEMPOTENCY_KEY.test(key)) {
      return respondProblem(
        c,
        buildProblem({
          code: "KITSUDEN_E_IDEMPOTENCY_KEY_INVALID",
          detail: "The Idempotency-Key header must be 8-128 characters from [A-Za-z0-9_.:-].",
          instance: path,
          requestId,
          extensions: {
            details: [
              { field: "Idempotency-Key", problem: "8-128 characters: letters, numbers, _ . : -" },
            ],
          },
        })
      );
    }

    // A COPY of the body is read: the original stays intact for the handler.
    const body = new Uint8Array(await c.req.raw.clone().arrayBuffer());
    const url = new URL(c.req.url);
    const fingerprint = requestFingerprint({
      method: c.req.method,
      path,
      query: url.search,
      type: c.req.header("content-type") ?? "",
      body,
    });
    const storeKey = storageKey(actorOf(c), key);
    const token = newToken();
    const inProgress: Registry = {
      status: "in-progress",
      token,
      fingerprint,
      createdAt: Date.now(),
    };

    let store: IdempotencyStore;
    try {
      const r = await reserveInChain(options.stores(), storeKey, inProgress, config.blockingMs);
      store = r.store;

      if (!r.reservation.reservedValue) {
        const existing = r.reservation.existing;
        if (existing.fingerprint !== fingerprint) {
          return respondProblem(
            c,
            buildProblem({
              code: "KITSUDEN_E_IDEMPOTENCY_KEY_REUSED",
              detail:
                "This Idempotency-Key was already used with a different method, path, query or body.",
              instance: path,
              requestId,
            })
          );
        }
        if (existing.status === "in-progress") {
          return respondProblem(
            c,
            buildProblem({
              code: "KITSUDEN_E_IDEMPOTENCY_IN_PROGRESS",
              detail: "A request with this Idempotency-Key is still being processed.",
              instance: path,
              requestId,
            })
          );
        }
        if (existing.status === "no-replay") {
          return respondProblem(
            c,
            buildProblem({
              code: "KITSUDEN_E_IDEMPOTENCY_NOT_REPLAYABLE",
              detail:
                existing.reason === "secret"
                  ? "The original request already succeeded; its response contained a secret and was not stored."
                  : "The original request already succeeded; its response was not stored.",
              instance: path,
              requestId,
            }),
            { "idempotent-replayed": "true" }
          );
        }
        // Replay
        const headers = new Headers(existing.response.headers);
        headers.set("idempotent-replayed", "true");
        headers.set("idempotency-key", key);
        const original = existing.response;
        const savedBody = fromBase64(original.bodyB64);
        return new Response([101, 204, 205, 304].includes(original.status) ? null : savedBody, {
          status: original.status,
          headers,
        });
      }
    } catch (err) {
      if (!(err instanceof StoreUnavailable)) throw err;
      options.notify?.("[idempotency] no store", { causes: err.causes, mode: config.failureMode });
      if (config.failureMode === "open") {
        c.header("idempotency-status", "unavailable");
        return next();
      }
      return respondProblem(
        c,
        buildProblem({
          code: "KITSUDEN_E_IDEMPOTENCY_UNAVAILABLE",
          detail:
            "The idempotency store is unavailable, so the request was not executed. Retry with the same Idempotency-Key.",
          instance: path,
          requestId,
        })
      );
    }

    // ── First time: execute and store ───────────────────────────────────────
    try {
      await next();
    } catch (err) {
      // `onError` will already have responded; this is in case something slips through.
      await store.release(storeKey, token).catch(() => {});
      throw err;
    }

    const res = c.res;
    const type = res.headers.get("content-type") ?? "";
    try {
      if (!statusIsSaved(res.status) || type.includes("text/event-stream")) {
        await store.release(storeKey, token);
      } else {
        const bytes = new Uint8Array(await res.clone().arrayBuffer());
        let registry: Registry;
        if (bytes.byteLength > config.maxResponseBytes) {
          registry = {
            status: "no-replay",
            token,
            fingerprint,
            createdAt: inProgress.createdAt,
            reason: "too-large",
          };
        } else if (bodyWithSecret(type, bytes)) {
          registry = {
            status: "no-replay",
            token,
            fingerprint,
            createdAt: inProgress.createdAt,
            reason: "secret",
          };
        } else {
          registry = {
            status: "done",
            token,
            fingerprint,
            createdAt: inProgress.createdAt,
            response: {
              status: res.status,
              headers: repeatableHeaders(res.headers),
              bodyB64: base64(bytes),
            },
          };
        }
        await store.complete(storeKey, token, registry, config.lifetimeMs);
      }
    } catch (err) {
      // The operation HAS been performed: it is not turned into an error because it could not
      // be recorded. The reservation expires on its own (`IDEMPOTENCY_LOCK_SECONDS`).
      options.notify?.("[idempotency] could not store the result", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    c.header("idempotency-key", key);
  };
}
