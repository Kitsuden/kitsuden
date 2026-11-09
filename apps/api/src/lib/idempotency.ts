/**
 * Write idempotency: stores and rules
 * ============================================================================
 *
 * An agent that gets no response (timeout, dropped connection, 503) does not know
 * whether its `POST` was executed. If it retries blindly, it duplicates; if it
 * does not retry, it loses. The standard way out is the `Idempotency-Key` header:
 * the client generates one key per OPERATION and repeats it on each retry; the
 * server executes the first one and returns the same response to the others.
 *
 * This file holds what does not depend on Hono (stores, fingerprints, what is
 * saved and what is not); the middleware is in `middleware/idempotency.ts`.
 *
 * ── WHERE IT IS STORED ─────────────────────────────────────────────────────
 *
 *   1. Valkey (fast, with native TTL): `SET … NX PX` reserves the key
 *      atomically, so two simultaneous requests cannot both
 *      execute.
 *   2. If Valkey does not respond: a Postgres table (`kitsuden_idempotency`),
 *      with `INSERT … ON CONFLICT` as the atomic reservation. It creates itself
 *      the first time it is needed (`CREATE TABLE IF NOT EXISTS`).
 *   3. If there is no table either (or the database does not respond): see `failureMode`.
 *
 * Known limit: the fallback is per request. If Valkey goes down BETWEEN the
 * first attempt and the retry, the retry looks at the table and does not see the
 * reservation made in Valkey. This only happens during an outage, and a client
 * that retries within that window may see the operation executed twice.
 *
 * ── WHAT IS NEVER STORED ──────────────────────────────────────────────────
 *
 *   - Headers: only an allowlist (type, location, ETag…). No
 *     `Set-Cookie`, no `Authorization`, nothing that is not on the list.
 *   - Bodies with secrets (freshly created agent keys, tokens,
 *     passwords): the response is not stored. Only the fact that the
 *     operation WAS already done is stored, and the retry gets a 409
 *     `KITSUDEN_E_IDEMPOTENCY_NOT_REPLAYABLE` instead of running again.
 *   - Responses larger than `IDEMPOTENCY_MAX_RESPONSE_BYTES`: same as above.
 *
 * ── WHAT IS REPLAYED AND WHAT IS NOT ──────────────────────────────────────
 *
 *   - 2xx, 3xx and deterministic 4xx (400, 404, 422…): stored and
 *     replayed as is.
 *   - 5xx, 401, 403, 408, 409, 423, 425, 429: NOT stored; the key is released
 *     and the retry runs again. These are state failures
 *     (session, permissions, load, the world changed) that a retry may
 *     resolve, and the operation did not actually happen.
 */
import { createHash, randomUUID } from "node:crypto";

// ── Configuration ───────────────────────────────────────────────────────────

export type FailureMode = "closed" | "open";

export interface IdempotencyConfig {
  /** How long a response is remembered (ms). `IDEMPOTENCY_TTL_SECONDS`, 24 h. */
  lifetimeMs: number;
  /** How long the reservation lasts while the request runs (ms). `IDEMPOTENCY_LOCK_SECONDS`, 60 s. */
  blockingMs: number;
  /** Largest response that is stored. `IDEMPOTENCY_MAX_RESPONSE_BYTES`, 1 MiB. */
  maxResponseBytes: number;
  /** With no store at all: `closed` (503, the default) or `open` (run unprotected). */
  failureMode: FailureMode;
}

export function idempotencyConfig(
  env: Record<string, string | undefined> = process.env
): IdempotencyConfig {
  const integer = (value: string | undefined, defaultValue: number, min: number, max: number) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= min && n <= max ? n : defaultValue;
  };
  return {
    lifetimeMs: integer(env.IDEMPOTENCY_TTL_SECONDS, 86_400, 60, 30 * 86_400) * 1000,
    blockingMs: integer(env.IDEMPOTENCY_LOCK_SECONDS, 60, 1, 3600) * 1000,
    maxResponseBytes: integer(env.IDEMPOTENCY_MAX_RESPONSE_BYTES, 1_048_576, 1024, 16_777_216),
    failureMode: env.IDEMPOTENCY_FAIL_MODE === "open" ? "open" : "closed",
  };
}

// ── Keys and fingerprints ───────────────────────────────────────────────────

/** Same as the one kon-ecommerce already validated: opaque, short, no odd characters. */
export const VALID_IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

/**
 * Where it is stored: the actor + the key, hashed. Two actors with the same
 * key do not see each other, and the key is not left in the clear in Valkey or in
 * the table.
 */
export function storageKey(actor: string, key: string): string {
  return createHash("sha256").update(`${actor}\n${key}`).digest("hex");
}

/**
 * What was requested: method + path + query + type + body. If a retry brings a
 * different fingerprint with the same key, it is a client error (422), not a
 * retry.
 */
export function requestFingerprint(p: {
  method: string;
  path: string;
  query: string;
  type: string;
  body: Uint8Array;
}): string {
  return createHash("sha256")
    .update(`${p.method.toUpperCase()}\n${p.path}\n${p.query}\n${p.type}\n`)
    .update(p.body)
    .digest("hex");
}

// ── Records ─────────────────────────────────────────────────────────────────

export interface SavedResponse {
  status: number;
  headers: Array<[string, string]>;
  /** Body in base64 (it may not be text). */
  bodyB64: string;
}

export type Registry =
  | { status: "in-progress"; token: string; fingerprint: string; createdAt: number }
  | {
      status: "done";
      token: string;
      fingerprint: string;
      createdAt: number;
      response: SavedResponse;
    }
  | {
      status: "no-replay";
      token: string;
      fingerprint: string;
      createdAt: number;
      reason: "secret" | "too-large" | "not-replayable";
    };

export type Reservation = { reservedValue: true } | { reservedValue: false; existing: Registry };

/** A place to store. Any infrastructure failure is THROWN. */
export interface IdempotencyStore {
  readonly name: string;
  /** Atomic reservation. If a live record already exists, it returns it. */
  reserve(key: string, registry: Registry, ms: number): Promise<Reservation>;
  /** Replaces the reservation with the result, only if it is still ours (token). */
  complete(key: string, token: string, registry: Registry, ms: number): Promise<void>;
  /** Deletes the reservation, only if it is still ours (token). */
  release(key: string, token: string): Promise<void>;
  /**
   * Reads the live record WITHOUT reserving (`null` if none). Quotas
   * use it to avoid charging for a replay. Optional: a store without it does
   * not allow knowing beforehand and the quota is refunded afterwards.
   */
  queryAgain?(key: string): Promise<Registry | null>;
}

/**
 * Is the response to THIS request (actor + key + fingerprint) already stored and
 * about to be REPLAYED? The first store that responds decides, as when reserving.
 */
export async function savedRepetition(
  stores: IdempotencyStore[],
  actor: string,
  key: string,
  fingerprint: string
): Promise<boolean> {
  const k = storageKey(actor, key);
  for (const store of stores) {
    if (!store.queryAgain) return false;
    try {
      const r = await store.queryAgain(k);
      return Boolean(
        r && r.fingerprint === fingerprint && (r.status === "done" || r.status === "no-replay")
      );
    } catch {
      /* the next store */
    }
  }
  return false;
}

export function newToken(): string {
  return randomUUID();
}

// ── What is stored of a response ────────────────────────────────────────────

/** Statuses that are NOT stored: a retry may turn out differently and the operation was not done. */
const NOT_SAVED = new Set([401, 403, 408, 409, 423, 425, 429]);

export function statusIsSaved(status: number): boolean {
  return status < 500 && !NOT_SAVED.has(status);
}

/**
 * ALLOW list of headers that are replayed. Everything else (`Set-Cookie`,
 * `Authorization`, `X-Agent-Id`, trace headers of the original request…)
 * is not stored.
 */
const REPEATABLE_HEADERS = new Set([
  "content-type",
  "content-language",
  "content-location",
  "location",
  "etag",
  "last-modified",
  "link",
  "cache-control",
  "vary",
  "deprecation",
  "sunset",
  "x-total-count",
  "x-kitsuden-format",
]);

export function repeatableHeaders(headers: Headers): Array<[string, string]> {
  const output: Array<[string, string]> = [];
  headers.forEach((value, name) => {
    if (REPEATABLE_HEADERS.has(name.toLowerCase())) output.push([name.toLowerCase(), value]);
  });
  return output;
}

/** Field names that carry a secret (the exact list kept from before). */
const SECRET_FIELD =
  /^(token|access_?token|refresh_?token|id_?token|session_?token|secret|client_?secret|password|passwd|api_?key|apikey|raw_?key|plain_?key|private_?key|secret_?key|signing_?key|webhook_?secret)$/i;
/** Values that are Kitsuden keys, whatever they are called. */
const SECRET_VALUE =
  /^(kitsuden_agent_|kitsuden_sk_|grm_agent_|kitsuden_oat_|kitsuden_ort_|kcs_)[A-Za-z0-9_-]{8,}/;

/**
 * Values shaped like someone else's credential (security review 2026-11-04):
 * `Bearer`/`Basic` headers, keys of well-known providers, PEM private keys.
 */
const CREDENTIAL_VALUE =
  /^(?:(?:Bearer|Basic|Token|Digest)\s+\S{8,}|sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{8,}|rk_(?:live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** The words of a name: `OPENAI_API_KEY`, `apiKey`, `x-api-key` → api, key… */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** A word that on its own says "a secret goes here". */
const SECRET_WORD = new Set([
  "secret",
  "secrets",
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "token",
  "credential",
  "credentials",
  "authorization",
  "cookie",
  "apikey",
  "privatekey",
  "secretkey",
  "accesskey",
  "signingkey",
  "dsn",
]);
/** `key` next to one of these: `api_key`, `privateKey`, `STRIPE_SECRET_KEY`… */
const KEY_QUALIFIER = new Set([
  "api",
  "private",
  "secret",
  "access",
  "signing",
  "client",
  "auth",
  "encryption",
  "master",
  "license",
  "service",
  "webhook",
  "session",
  "ssh",
  "deploy",
  "admin",
  "bot",
  "app",
]);
/**
 * Words that make the name a FACT ABOUT the secret, not the secret:
 * `tokenCount`, `apiKeyId`, `secretName`, `passwordUpdatedAt`, `tokenUrl`.
 */
const DESCRIPTIVE_WORD = new Set([
  "count",
  "counts",
  "max",
  "min",
  "limit",
  "type",
  "types",
  "usage",
  "consent",
  "expires",
  "expiry",
  "expiration",
  "ttl",
  "length",
  "url",
  "uri",
  "endpoint",
  "id",
  "ids",
  "name",
  "names",
  "hint",
  "policy",
  "label",
  "field",
  "enabled",
  "required",
  "at",
  "prefix",
  "last4",
  "masked",
]);
/** Objects whose whole content is environment values or credentials (`config.envVars`). */
const SECRET_CONTAINER = new Set(["envvars", "env", "environment", "secrets", "credentials"]);

/**
 * Does this field (or header, or variable) name carry a secret? Broader than
 * the exact list: any name with secret/password/token/credential/
 * authorization/cookie, a qualified `key` (`api`, `private`…), or an
 * environment variable `SOMETHING_KEY`. Not the names that describe the
 * secret (`tokenCount`, `apiKeyId`, `secretName`).
 */
export function secretName(name: string): boolean {
  if (typeof name !== "string" || !name) return false;
  if (SECRET_FIELD.test(name)) return true;
  const words = nameWords(name);
  if (words.some((w) => DESCRIPTIVE_WORD.has(w))) return false;
  if (words.some((w) => SECRET_WORD.has(w))) return true;
  if (words.includes("key") && words.some((w) => KEY_QUALIFIER.has(w))) return true;
  // Environment variables: `STRIPE_KEY`, `OPENAI_API_KEY`.
  return /^[A-Z][A-Z0-9_]*_KEY$/.test(name);
}

function secretText(v: string): boolean {
  return SECRET_VALUE.test(v) || CREDENTIAL_VALUE.test(v) || PEM_PRIVATE_KEY.test(v);
}

/** Does it carry any non-empty text? */
function hasText(value: unknown, depth = 0): boolean {
  if (depth > 12 || value === null || value === undefined) return false;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((v) => hasText(v, depth + 1));
  }
  return false;
}

/** Is there a secret in this JSON? Walks at any depth (with a cap). */
export function containsSecret(value: unknown, depth = 0): boolean {
  if (depth > 12 || value === null || value === undefined) return false;
  if (typeof value === "string") return secretText(value);
  if (Array.isArray(value)) return value.some((v) => containsSecret(v, depth + 1));
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    // `{ key: "OPENAI_API_KEY", value: "sk-…" }` (the Secrets Manager), `{ name: "Authorization", value: … }`.
    const label = [o.key, o.name, o.header, o.variable].find((x) => typeof x === "string") as
      | string
      | undefined;
    if (label && secretName(label) && hasText(o.value)) return true;
    for (const [key, v] of Object.entries(o)) {
      if (secretName(key) && hasText(v)) return true;
      if (SECRET_CONTAINER.has(key.toLowerCase()) && v && typeof v === "object" && hasText(v)) {
        return true;
      }
      if (containsSecret(v, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Routes whose body IS a secret, whatever the field is called: what is sent
 * there is stored encrypted and never shown. A proposal stores the body to
 * run it when approved, so it cannot be held without storing the secret: it
 * is refused (security review 2026-11-04).
 */
const SECRET_ROUTES = [/^\/api\/admin\/secrets(?:\/|$)/, /^\/api\/v1\/admin\/secrets(?:\/|$)/];

export function routeReceivesSecrets(path: string): boolean {
  const p = String(path ?? "")
    .split("?")[0]!
    .replace(/\/{2,}/g, "/");
  return SECRET_ROUTES.some((r) => r.test(p));
}

/**
 * Does this (parsed) body carry a secret, for this route? By content
 * (`containsSecret`) or by destination: what goes to the secrets store
 * (`/api/admin/secrets`) IS a secret even if the field is called `value`.
 */
export function bodyWithSecretForRoute(path: string, body: unknown): boolean {
  const empty =
    body === null ||
    body === undefined ||
    body === "" ||
    (typeof body === "object" && !Array.isArray(body) && Object.keys(body as object).length === 0);
  if (!empty && routeReceivesSecrets(path)) return true;
  return containsSecret(body);
}

/** Does the body (bytes) carry a secret? Only checked if it is JSON or text. */
export function bodyWithSecret(type: string, body: Uint8Array): boolean {
  const t = type.toLowerCase();
  if (!t.includes("json") && !t.startsWith("text/")) return false;
  const text = new TextDecoder().decode(body);
  if (t.includes("json")) {
    try {
      return containsSecret(JSON.parse(text));
    } catch {
      // broken JSON: checked as text
    }
  }
  return (
    /(kitsuden_agent_|kitsuden_sk_|grm_agent_|kitsuden_oat_|kitsuden_ort_|kcs_)[A-Za-z0-9_-]{8,}/.test(
      text
    ) ||
    PEM_PRIVATE_KEY.test(text) ||
    /(?:^|\s)(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/.test(text)
  );
}

// ── In-memory store (tests and "single process" mode) ───────────────────────

export function inMemoryStore(now: () => number = Date.now): IdempotencyStore & {
  size(): number;
} {
  const data = new Map<string, { record: Registry; expiresAt: number }>();
  const alive = (key: string) => {
    const e = data.get(key);
    if (!e) return null;
    if (e.expiresAt <= now()) {
      data.delete(key);
      return null;
    }
    return e;
  };
  return {
    name: "memory",
    async reserve(key, registry, ms) {
      const e = alive(key);
      if (e) return { reservedValue: false, existing: e.record };
      data.set(key, { record: registry, expiresAt: now() + ms });
      return { reservedValue: true };
    },
    async complete(key, token, registry, ms) {
      const e = alive(key);
      if (!e || e.record.token !== token) return;
      data.set(key, { record: registry, expiresAt: now() + ms });
    },
    async release(key, token) {
      const e = alive(key);
      if (e && e.record.token === token) data.delete(key);
    },
    async queryAgain(key) {
      return alive(key)?.record ?? null;
    },
    size: () => data.size,
  };
}

// ── Valkey ──────────────────────────────────────────────────────────────────

/** The minimum of the `redis` v5 client that is used (so it can be simulated). */
export interface MinimalValkeyClient {
  set(
    key: string,
    value: string,
    options: { condition: "NX"; expiration: { type: "PX"; value: number } }
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

const VALKEY_PREFIX = "kitsuden:idem:";

/**
 * The value is `<token>|<json>`: this way a Lua script can check that the
 * reservation is still ours without parsing JSON.
 */
const LUA_COMPLETE = `
local v = redis.call('GET', KEYS[1])
if v and string.sub(v, 1, string.len(ARGV[1]) + 1) == ARGV[1] .. '|' then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 1
end
return 0`;

const LUA_RELEASE = `
local v = redis.call('GET', KEYS[1])
if v and string.sub(v, 1, string.len(ARGV[1]) + 1) == ARGV[1] .. '|' then
  return redis.call('DEL', KEYS[1])
end
return 0`;

function decode(value: string): Registry | null {
  const cut = value.indexOf("|");
  if (cut < 0) return null;
  try {
    return JSON.parse(value.slice(cut + 1)) as Registry;
  } catch {
    return null;
  }
}

export function valkeyStore(client: () => Promise<MinimalValkeyClient>): IdempotencyStore {
  return {
    name: "valkey",
    async reserve(key, registry, ms) {
      const c = await client();
      const k = VALKEY_PREFIX + key;
      // Two passes: if the other party's reservation expires between the SET and the GET, it
      // is retried instead of returning "nothing there".
      for (let i = 0; i < 2; i++) {
        const ok = await c.set(k, `${registry.token}|${JSON.stringify(registry)}`, {
          condition: "NX",
          expiration: { type: "PX", value: ms },
        });
        if (ok) return { reservedValue: true };
        const actual = await c.get(k);
        const existing = actual ? decode(actual) : null;
        if (existing) return { reservedValue: false, existing };
      }
      throw new Error("Valkey: could not reserve or read the idempotency key");
    },
    async complete(key, token, registry, ms) {
      const c = await client();
      await c.eval(LUA_COMPLETE, {
        keys: [VALKEY_PREFIX + key],
        arguments: [token, `${token}|${JSON.stringify(registry)}`, String(ms)],
      });
    },
    async release(key, token) {
      const c = await client();
      await c.eval(LUA_RELEASE, { keys: [VALKEY_PREFIX + key], arguments: [token] });
    },
    async queryAgain(key) {
      const c = await client();
      const v = await c.get(VALKEY_PREFIX + key);
      return v ? decode(v) : null;
    },
  };
}

// ── Postgres (fallback) ─────────────────────────────────────────────────────

/** The minimum of `pg`/drizzle that is used: SQL with positional parameters. */
export type SqlQuery = (
  text: string,
  parameters: unknown[]
) => Promise<Array<Record<string, unknown>>>;

export const IDEMPOTENCY_TABLE = "kitsuden_idempotency";

/**
 * DDL of the fallback table. Deliberately not a numbered migration: the
 * fallback is optional and the store itself creates it the first time it
 * needs it. If the app role cannot create tables, there is no fallback (and
 * `IDEMPOTENCY_FAIL_MODE` rules).
 *
 * No RLS: it stores responses from any actor and only this module reads it,
 * always by the hashed key. It is not exposed in the data explorer.
 */
export const DDL_IDEMPOTENCY = `
CREATE TABLE IF NOT EXISTS ${IDEMPOTENCY_TABLE} (
  idempotency_key text PRIMARY KEY,
  record jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ${IDEMPOTENCY_TABLE}_expires_idx ON ${IDEMPOTENCY_TABLE} (expires_at);
`;

function isTableThatDoesNotExist(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: unknown }).code === "42P01") return true;
    if (/relation .*kitsuden_idempotency.* does not exist/i.test(String((e as Error).message)))
      return true;
  }
  return false;
}

export function postgresStore(query: SqlQuery): IdempotencyStore {
  let tableList = false;

  async function withTable<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (tableList || !isTableThatDoesNotExist(err)) throw err;
      for (const statement of DDL_IDEMPOTENCY.split(";")
        .map((s) => s.trim())
        .filter(Boolean)) {
        await query(statement, []);
      }
      tableList = true;
      return fn();
    }
  }

  return {
    name: "postgres",
    async reserve(key, registry, ms) {
      return withTable(async () => {
        for (let i = 0; i < 2; i++) {
          // Inserts, or overwrites ONLY an expired record. Atomic: two simultaneous
          // requests cannot both get a returned row.
          const inserted = await query(
            `INSERT INTO ${IDEMPOTENCY_TABLE} (idempotency_key, record, expires_at)
             VALUES ($1, $2::jsonb, now() + ($3::bigint * interval '1 millisecond'))
             ON CONFLICT (idempotency_key) DO UPDATE
               SET record = EXCLUDED.record, expires_at = EXCLUDED.expires_at
               WHERE ${IDEMPOTENCY_TABLE}.expires_at <= now()
             RETURNING idempotency_key`,
            [key, JSON.stringify(registry), ms]
          );
          if (inserted.length > 0) {
            // Lazy cleanup of expired rows: 1 out of every 50 reservations.
            if (Math.random() < 0.02) {
              await query(`DELETE FROM ${IDEMPOTENCY_TABLE} WHERE expires_at <= now()`, []).catch(
                () => {}
              );
            }
            return { reservedValue: true } as const;
          }
          const rows = await query(
            `SELECT record FROM ${IDEMPOTENCY_TABLE} WHERE idempotency_key = $1 AND expires_at > now()`,
            [key]
          );
          const row = rows[0]?.record;
          if (row) {
            const existing = (typeof row === "string" ? JSON.parse(row) : row) as Registry;
            return { reservedValue: false, existing } as const;
          }
        }
        throw new Error("Postgres: could not reserve or read the idempotency key");
      });
    },
    async complete(key, token, registry, ms) {
      await withTable(() =>
        query(
          `UPDATE ${IDEMPOTENCY_TABLE}
             SET record = $3::jsonb, expires_at = now() + ($4::bigint * interval '1 millisecond')
           WHERE idempotency_key = $1 AND record->>'token' = $2`,
          [key, token, JSON.stringify(registry), ms]
        )
      );
    },
    async release(key, token) {
      await withTable(() =>
        query(
          `DELETE FROM ${IDEMPOTENCY_TABLE} WHERE idempotency_key = $1 AND record->>'token' = $2`,
          [key, token]
        )
      );
    },
    async queryAgain(key) {
      const rows = await withTable(() =>
        query(
          `SELECT record FROM ${IDEMPOTENCY_TABLE} WHERE idempotency_key = $1 AND expires_at > now()`,
          [key]
        )
      );
      const row = rows[0]?.record;
      if (!row) return null;
      return (typeof row === "string" ? JSON.parse(row) : row) as Registry;
    },
  };
}

// ── Chain: Valkey → Postgres ────────────────────────────────────────────────

export class StoreUnavailable extends Error {
  constructor(readonly causes: string[]) {
    super(`No idempotency store available: ${causes.join("; ")}`);
    this.name = "StoreUnavailable";
  }
}

/**
 * Tries the stores in order. Also returns WHICH one reserved: the result
 * must be written to that same one, not to the first one that responds later.
 */
export async function reserveInChain(
  stores: IdempotencyStore[],
  key: string,
  registry: Registry,
  ms: number
): Promise<{ store: IdempotencyStore; reservation: Reservation }> {
  const causes: string[] = [];
  for (const store of stores) {
    try {
      return { store, reservation: await store.reserve(key, registry, ms) };
    } catch (err) {
      causes.push(`${store.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new StoreUnavailable(causes);
}
