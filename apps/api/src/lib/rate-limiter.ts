/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * RATE LIMITER - Protection against API abuse
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Implementation based on Valkey (Redis) with a sliding window.
 * Supports limits differentiated by endpoint and authentication type.
 *
 * Without `VALKEY_URL` (single instance, plan B1b) ALL routes
 * count in process memory. Deliberately NOT in a Postgres table:
 * every request would write to the database, whose pool was already exhausted before by
 * parallel reads. With several replicas, Valkey.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { readEnv } from "@kitsuden/shared";

import { isInternalCall, limiterIdentity } from "./client-ip";
import { getValkeyClient, valkeyConfigured } from "./valkey";

import type { Context, Next } from "hono";

/**
 * ── THE PUBLIC SITE IS NOT ONE CLIENT, IT IS MANY ──────────────────────────
 *
 * The site's server (Astro) asks the API on behalf of each visitor,
 * from ITS own IP and without `x-forwarded-for`: all visits fell into the
 * same bucket («unknown»). At 300 pages per minute on a hot route
 * (`/api/wiki/wikis`, `/api/settings`) the API answered 429 and the site served
 * 404 to everyone.
 *
 * With the shared key (`SITE_API_KEY`, on the site and on the API) the
 * site says which visitor is behind (`x-kitsuden-client`) and the quota is
 * counted per visitor. Without the key, that header is ignored: anyone
 * could write a different IP on each request and never exhaust anything.
 *
 * Returns the visitor identifier, or `null` if the request is not
 * signed by the site (or no key is configured).
 */
export function siteVisitor(c: Context<any>): string | null {
  const key = readEnv("SITE_API_KEY") ?? "";
  const received = c.req.header("x-kitsuden-site") ?? c.req.header("x-kitsuden-site") ?? "";
  if (!key || !received) return null;
  // Constant-time comparison over digests of equal length
  const a = createHash("sha256").update(key).digest();
  const b = createHash("sha256").update(received).digest();
  if (!timingSafeEqual(a, b)) return null;
  const client = (c.req.header("x-kitsuden-client") ?? c.req.header("x-kitsuden-client") ?? "")
    .trim()
    .slice(0, 64);
  return `site:${client || "no-ip"}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface RateLimitConfig {
  /** Requests allowed per window */
  limit: number;
  /** Time window in seconds */
  window: number;
  /** Custom error message */
  message?: string;
  /** Custom key to identify the client */
  keyGenerator?: (c: Context<{ Variables: AppVariables }>) => string;
  /**
   * The counter's own namespace in Valkey. Without it, the key is
   * `ratelimit:<route>:<client>`, the SAME one `globalRateLimit` uses for that
   * route: a kon limit and the global one pointed at the same zset and every request
   * was counted twice (a kon `limit: 10` cut off at 5). Kon limits
   * set it to `kon:<id>`.
   */
  space?: string;
  /** Whether rate limiting should be skipped */
  skip?: (c: Context<{ Variables: AppVariables }>) => boolean;
  /**
   * Deny if the counter is unavailable (Valkey down).
   *
   * Default `false` — the limiter FAILS OPEN so that a Valkey outage
   * does not take down the whole API. It is the right choice for 99% of
   * routes: serving too much is better than not serving.
   *
   * But there are endpoints where it is not. One that sends mail to unverified
   * addresses, or that charges, prefers to reject the request rather than be left with
   * no brake at all: with Valkey down and fail-open, an attacker sends unlimited
   * mail from your domain. Those set `failClosed: true`.
   */
  failClosed?: boolean;
}

/** Default configuration */
const DEFAULT_CONFIG: RateLimitConfig = {
  limit: 100,
  window: 60,
  message: "Rate limit exceeded. Please try again later.",
};

/** Route-specific configurations */
export const RATE_LIMIT_CONFIGS: Record<string, RateLimitConfig> = {
  // Auth - stricter to prevent brute force.
  //
  // With better-auth's REAL paths. Here it used to say `/api/auth/login`,
  // `/register` and `/forgot-password`, which do not exist: sign-in
  // (`/sign-in/email`) ran with the general limit of 300/min.
  "/api/auth/sign-in/email": {
    limit: 10,
    window: 300,
    message: "Too many login attempts. Try again in 5 minutes.",
    failClosed: true,
  },
  "/api/auth/sign-up/email": {
    limit: 5,
    window: 3600,
    message: "Too many registration attempts. Try again later.",
    failClosed: true,
  },
  "/api/auth/request-password-reset": {
    limit: 3,
    window: 3600,
    message: "Too many password reset attempts.",
    failClosed: true,
  },
  "/api/auth/forget-password": {
    limit: 3,
    window: 3600,
    message: "Too many password reset attempts.",
    failClosed: true,
  },
  "/api/auth/send-verification-email": {
    limit: 3,
    window: 3600,
    message: "Too many verification emails requested.",
    failClosed: true,
  },

  // The rest of better-auth's paths that check a password or send
  // an email. With a session, yes, but a stolen session without the current
  // password must not be able to try passwords without a brake (`change-password`,
  // `delete-user`), nor use the domain to send mail (`change-email`).
  // `reset-password` consumes the email token and sets the new password.
  "/api/auth/change-password": {
    limit: 10,
    window: 300,
    message: "Too many attempts. Try again in 5 minutes.",
    failClosed: true,
  },
  "/api/auth/change-email": {
    limit: 3,
    window: 3600,
    message: "Too many email change requests.",
    failClosed: true,
  },
  "/api/auth/delete-user": {
    limit: 5,
    window: 300,
    message: "Too many attempts. Try again in 5 minutes.",
    failClosed: true,
  },
  "/api/auth/reset-password": {
    limit: 10,
    window: 3600,
    message: "Too many password reset attempts.",
    failClosed: true,
  },

  // Magic links (better-auth `magicLink`, lib/auth.ts): anonymous and sends an
  // email to whatever address is given, like the reset. The verify consumes a
  // single-use token, so a modest bucket only slows down guessing.
  "/api/auth/sign-in/magic-link": {
    limit: 5,
    window: 3600,
    message: "Too many sign-in links requested. Try again later.",
    failClosed: true,
  },
  "/api/auth/magic-link/verify": {
    limit: 20,
    window: 300,
    message: "Too many sign-in link attempts. Try again in 5 minutes.",
    failClosed: true,
  },

  // Two-factor sign-in (better-auth `twoFactor`). A six-digit code is guessable
  // without a brake: better-auth also locks the challenge after 5 wrong codes,
  // this caps the attempts per IP across challenges.
  "/api/auth/two-factor/verify-totp": {
    limit: 10,
    window: 300,
    message: "Too many two-factor attempts. Try again in 5 minutes.",
    failClosed: true,
  },
  "/api/auth/two-factor/verify-backup-code": {
    limit: 10,
    window: 300,
    message: "Too many two-factor attempts. Try again in 5 minutes.",
    failClosed: true,
  },
  // Enrol, disable, show the secret again, new backup codes: with a session, but
  // they check the password, so the same brake as change-password.
  "/api/auth/two-factor/enable": {
    limit: 10,
    window: 300,
    message: "Too many attempts. Try again in 5 minutes.",
    failClosed: true,
  },
  "/api/auth/two-factor/disable": {
    limit: 10,
    window: 300,
    message: "Too many attempts. Try again in 5 minutes.",
    failClosed: true,
  },
  "/api/auth/two-factor/get-totp-uri": {
    limit: 10,
    window: 300,
    message: "Too many attempts. Try again in 5 minutes.",
    failClosed: true,
  },
  "/api/auth/two-factor/generate-backup-codes": {
    limit: 10,
    window: 300,
    message: "Too many attempts. Try again in 5 minutes.",
    failClosed: true,
  },

  // Members' magic link: anonymous, creates the member row and sends an
  // email to whatever address is given. Without this, 300/min per IP of emails to
  // third parties (mailbox bombing and damage to the sending domain's reputation).
  "/api/members/signin": {
    limit: 5,
    window: 3600,
    message: "Too many sign-in links requested. Try again later.",
    failClosed: true,
  },

  // MCP - moderate because of heavy AI use
  "/api/mcp": { limit: 200, window: 60, message: "MCP rate limit exceeded." },

  // Agents playground - heavy use
  "/api/agents/playground": { limit: 50, window: 60, message: "Playground rate limit exceeded." },

  // Batch operations - more permissive but controlled
  "/api/datasets/batch": {
    limit: 30,
    window: 60,
    message: "Batch operations limited to 30/minute.",
  },

  // Import/Export - very permissive but trackable
  "/api/datasets/export": {
    limit: 10,
    window: 60,
    message: "Export operations limited to 10/minute.",
  },
  "/api/datasets/import": {
    limit: 10,
    window: 60,
    message: "Import operations limited to 10/minute.",
  },

  // Search - moderate
  "/api/search": { limit: 120, window: 60, message: "Search rate limit exceeded." },

  // GraphQL - moderate
  "/api/graphql": { limit: 100, window: 60, message: "GraphQL rate limit exceeded." },
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  reset: number;
  limit: number;
  retryAfter?: number;
  /**
   * Counting was not possible (neither in Valkey nor in the in-memory reserve) and the
   * route fails closed: a 503 is returned, not 429 — it is not that the client
   * went over, it is that right now we cannot know.
   */
  unavailable?: boolean;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
  retryAfter?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generates the rate limiting key based on the client
 */
export function generateKey(
  c: Context<{ Variables: AppVariables }>,
  config: RateLimitConfig
): string {
  const space = config.space ? `${config.space}:` : "";
  if (config.keyGenerator) {
    return `ratelimit:${space}${config.keyGenerator(c)}`;
  }

  // Site visitor (signed with SITE_API_KEY) > real client IP.
  //
  // Neither `Authorization` nor `x-forwarded-for` as is: the client writes them, and
  // with a different value on each request each one fell into a new bucket — the
  // limit did not exist. A `Bearer <garbage>` that is not an agent's does not even give
  // 401: it continues as an anonymous request. The user is no use here either, because the
  // limiter runs BEFORE authentication and `user` is not set yet.
  // See `client-ip.ts`.
  const identifier = siteVisitor(c) || limiterIdentity(c);
  const route = normalizedPath(c.req.path);

  return `ratelimit:${space}${route}:${identifier}`;
}

/**
 * Dataset row reads over the API (`GET /api/data-sets/:id/entries`,
 * `/api/datasets/:id/entries`…): ONE bucket per client for ALL datasets.
 *
 * Audit: the site hides `/data` and throttles bots (403/429), but the API
 * served the same rows at 100 requests/min PER DATASET and client — a sweep
 * of 50 datasets was 5,000 per minute. Here the bucket is per client (signed
 * site visitor or real IP), not per route, and lower.
 *
 * Internal calls (the sites' SSR on the Docker network: private socket and no
 * forwarding header) do not count: without `SITE_API_KEY` they would all arrive as a
 * single client and the whole site would be left without data (an earlier incident).
 * A request a proxy forwarded always counts, even when its address came out
 * private (IPv6 behind docker-proxy): see `isInternalCall` in client-ip.ts.
 */
export const INPUT_READ: RateLimitConfig = {
  limit: 120,
  window: 60,
  message: "Too many dataset reads. Slow down.",
  keyGenerator: (c) => `entries:${siteVisitor(c) || limiterIdentity(c)}`,
  skip: (c) => !siteVisitor(c) && isInternalCall(c),
};

const ENTRIES_PATTERN = /^\/api\/(data-sets|datasets)\/[^/]+\/entries(\/|$)/;

export function configByPattern(method: string, path: string): RateLimitConfig | null {
  if (method.toUpperCase() === "GET" && ENTRIES_PATTERN.test(path)) return INPUT_READ;
  return null;
}

/**
 * The bucket above, for whoever calls the API directly. A visit to a website
 * (signed with the site key) reads several datasets per page, and the site has
 * its own guard for crawlers: at 120 a minute a crawler would start getting 503s
 * and lose pages from search engines. Those requests, and internal ones with no
 * signature, keep the general per-route limit.
 */
function directReadBucket(c: Context<{ Variables: AppVariables }>): RateLimitConfig | null {
  const config = configByPattern(c.req.method, normalizedPath(c.req.path));
  if (!config || siteVisitor(c) || config.skip?.(c)) return null;
  return config;
}

/**
 * The sliding window in a Valkey script: removes what has expired, counts and,
 * if there is room, records this request and renews the expiry. Returns the count
 * BEFORE recording it (the same as `zCard` used to read).
 */
const WINDOW_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, tonumber(ARGV[1]) - tonumber(ARGV[2]))
local n = redis.call('ZCARD', KEYS[1])
if n < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], tonumber(ARGV[1]), ARGV[4])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return n`;

/** `false` after an EVAL failure that is not a connection one: it is not retried. */
let availableScripts = true;

/**
 * The count with the script, or `null` if this client cannot run it
 * (then counting is done with the separate steps). A CONNECTION failure propagates:
 * it is the same case as before (open or closed depending on the route).
 */
async function countWithScript(
  valkey: unknown,
  key: string,
  now: number,
  windowMs: number,
  limit: number,
  member: string
): Promise<number | null> {
  const evaluate = (valkey as { eval?: unknown }).eval;
  if (!availableScripts || typeof evaluate !== "function") return null;
  try {
    const n = await (
      evaluate as (s: string, o: { keys: string[]; arguments: string[] }) => Promise<unknown>
    ).call(valkey, WINDOW_SCRIPT, {
      keys: [key],
      arguments: [String(now), String(windowMs), String(limit), member],
    });
    return Number(n);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // NOSCRIPT / unknown command / scripts disabled: separate steps.
    if (/unknown command|NOSCRIPT|ERR.*script|not allowed|disabled/i.test(message)) {
      availableScripts = false;
      return null;
    }
    throw err;
  }
}

/**
 * Checks whether the request is within the rate limit (sliding window)
 */
export async function checkRateLimit(
  c: Context<{ Variables: AppVariables }>,
  config: RateLimitConfig = DEFAULT_CONFIG
): Promise<RateLimitResult> {
  const key = generateKey(c, config);
  const now = Date.now();
  const windowMs = config.window * 1000;
  const reset = now + windowMs;

  // `getValkeyClient()` does not return null when Valkey is down: it THROWS
  // (connection refused or timeout). Before, the call was outside the `try`, the
  // exception went up to the middleware's `catch {}` —which lets through— and the
  // `failClosed` routes failed OPEN in exactly the case they existed for.
  // Single instance without Valkey: the counter IS the process memory, for
  // all routes. If the key cap fills up, normal routes let
  // through (as with Valkey down) and the `failClosed` ones reject.
  if (!valkeyConfigured()) {
    return countInMemory(key, config, now, !config.failClosed);
  }

  let valkey: Awaited<ReturnType<typeof getValkeyClient>> | null;
  try {
    valkey = await getValkeyClient();
  } catch {
    valkey = null;
  }

  // Without Valkey there is no counter. By default it is allowed (fail open) so that
  // a cache outage does not take down the API; routes marked `failClosed`
  // count in the in-memory reserve and, if that is not possible either, reject.
  if (!valkey) {
    if (config.failClosed) {
      return countInMemory(key, config, now);
    }
    return { allowed: true, remaining: config.limit, reset, limit: config.limit };
  }

  try {
    // Use a sorted set for the sliding window
    const windowStart = now - windowMs;
    const member = `${now}-${Math.random()}`;

    // A single round trip: the script does the same as the four steps
    // below, and also ATOMICALLY (with four separate calls, N
    // simultaneous requests read the same count and all passed).
    let currentCount = await countWithScript(valkey, key, now, windowMs, config.limit, member);
    if (currentCount === null) {
      // Without EVAL (a test client, a Valkey with scripts
      // disabled): the usual four steps.
      // Remove old entries outside the window
      await valkey.zRemRangeByScore(key, 0, windowStart);

      // Count current entries
      currentCount = await valkey.zCard(key);

      if (currentCount < config.limit) {
        // Add current entry
        await valkey.zAdd(key, { score: now, value: member });
        // Set expiry
        await valkey.pExpire(key, windowMs);
      }
    }

    // Check whether it is within the limit
    const allowed = currentCount < config.limit;

    const remaining = Math.max(0, config.limit - currentCount - 1);

    return {
      allowed,
      remaining,
      reset,
      limit: config.limit,
      retryAfter: allowed ? undefined : Math.ceil(config.window / 2),
    };
  } catch (error) {
    console.error("Rate limiter error:", error);
    // Same criterion as above: open by default, closed if the route asks for it.
    if (config.failClosed) {
      return countInMemory(key, config, now);
    }
    return { allowed: true, remaining: config.limit, reset, limit: config.limit };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// IN-MEMORY COUNTER (without Valkey: all routes; with Valkey down: the failClosed ones)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * With Valkey down, a `failClosed` route (login, sign-up, password recovery,
 * magic link…) counts here, in process memory, instead of rejecting
 * EVERYTHING. Why this way:
 *
 *   · Always rejecting (a bare 503) closes the door to everyone: a
 *     Valkey hiccup and nobody can get into the panel. Counting in memory still
 *     slows down brute force and mail bombing with the same limit.
 *   · It is PER PROCESS: with N API replicas the real quota is N times the
 *     configured one. A Kitsuden deployment is a single replica; with several
 *     it is still a bounded brake, which is what is asked.
 *   · It has a key cap. An attacker rotating IPs creates one key per
 *     request; without a cap that is unbounded memory. With the cap full (after
 *     sweeping the expired ones) a new client can no longer be counted and the
 *     route really fails closed: 503 with Retry-After.
 *
 * Routes that do not set `failClosed` do NOT go through here: they keep failing
 * open, as always.
 */
interface InMemoryBucket {
  hits: number[];
  windowMs: number;
}

const inMemoryReserve = new Map<string, InMemoryBucket>();

/** Retry hint given when counting is not possible. */
export const RETRY_WITHOUT_COUNTER_S = 30;

function maxKeysInMemory(): number {
  const n = Number(process.env.RATE_LIMIT_MEMORY_MAX_KEYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10_000;
}

function sweepExpired(now: number): void {
  for (const [key, bucket] of inMemoryReserve) {
    const last = bucket.hits[bucket.hits.length - 1] ?? 0;
    if (last <= now - bucket.windowMs) inMemoryReserve.delete(key);
  }
}

function countInMemory(
  key: string,
  config: RateLimitConfig,
  now: number,
  openIfFull = false
): RateLimitResult {
  const windowMs = config.window * 1000;
  const reset = now + windowMs;
  let bucket = inMemoryReserve.get(key);

  if (!bucket) {
    if (inMemoryReserve.size >= maxKeysInMemory()) sweepExpired(now);
    if (inMemoryReserve.size >= maxKeysInMemory()) {
      if (openIfFull) {
        return { allowed: true, remaining: config.limit, reset, limit: config.limit };
      }
      return {
        allowed: false,
        unavailable: true,
        remaining: 0,
        reset,
        limit: config.limit,
        retryAfter: RETRY_WITHOUT_COUNTER_S,
      };
    }
    bucket = { hits: [], windowMs };
    inMemoryReserve.set(key, bucket);
  }

  const from = now - windowMs;
  bucket.hits = bucket.hits.filter((t) => t > from);
  const current = bucket.hits.length;
  const allowed = current < config.limit;
  if (allowed) bucket.hits.push(now);

  return {
    allowed,
    remaining: Math.max(0, config.limit - current - 1),
    reset,
    limit: config.limit,
    retryAfter: allowed ? undefined : Math.ceil(config.window / 2),
  };
}

/** Tests only: empties the in-memory reserve. */
export function clearInMemoryReserve(): void {
  inMemoryReserve.clear();
}

/** Generic 503 message: it does not reveal which internal piece is missing. */
const UNAVAILABLE_MESSAGE = "This action is temporarily unavailable. Please try again shortly.";

/**
 * Response common to both middlewares when the request does not pass. Returns
 * `null` if it may continue.
 */
function limitResponse(c: Context, result: RateLimitResult, message?: string) {
  if (result.allowed) return null;
  if (result.unavailable) {
    c.header("Retry-After", String(result.retryAfter ?? RETRY_WITHOUT_COUNTER_S));
    return c.json({ error: "Service Unavailable", message: UNAVAILABLE_MESSAGE }, 503);
  }
  c.header("Retry-After", String(result.retryAfter || 60));
  return c.json(
    {
      error: "Rate Limit Exceeded",
      message: message || "Too many requests. Please slow down.",
      retryAfter: result.retryAfter,
    },
    429
  );
}

/** The counter blew up in an unforeseen way: same as having no counter. */
function withoutCounter(c: Context) {
  c.header("Retry-After", String(RETRY_WITHOUT_COUNTER_S));
  return c.json({ error: "Service Unavailable", message: UNAVAILABLE_MESSAGE }, 503);
}

/**
 * Rate limiting middleware for Hono
 */
/**
 * The route without trailing or double slashes: `/api/auth/sign-in/email/` fell into the
 * general bucket (300/min) instead of the login one (an earlier audit).
 */
function normalizedPath(route: string): string {
  const cleans = route.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return cleans === "" ? "/" : cleans;
}

/**
 * `RATE_LIMIT_ENABLED`: on unless it says something other than `true` (the
 * same rule as `lib/config.ts`). It is read from the environment and not from `config` so
 * that `module-loader` does not pull in the whole configuration validation.
 */
export function limiterEnabled(): boolean {
  return (process.env.RATE_LIMIT_ENABLED ?? "true") === "true";
}

export function rateLimit(config?: Partial<RateLimitConfig>) {
  return async (c: Context<{ Variables: AppVariables }>, next: Next) => {
    const path = normalizedPath(c.req.path);

    // Look up the specific configuration or use the default
    const pathConfig =
      RATE_LIMIT_CONFIGS[path] || configByPattern(c.req.method, path) || DEFAULT_CONFIG;
    const finalConfig = { ...pathConfig, ...config };

    // Check whether it should be skipped
    if (finalConfig.skip?.(c)) {
      return await next();
    }

    try {
      const result = await checkRateLimit(c, finalConfig);

      // Headers always present
      c.header("X-RateLimit-Limit", String(result.limit));
      c.header("X-RateLimit-Remaining", String(result.remaining));
      c.header("X-RateLimit-Reset", String(result.reset));

      const blocking = limitResponse(c, result, finalConfig.message);
      if (blocking) return blocking;
    } catch {
      // `checkRateLimit` no longer throws because of Valkey; this is the unforeseen. Open
      // by default, closed if the route asks for it.
      if (finalConfig.failClosed) return withoutCounter(c);
    }

    await next();
  };
}

/**
 * Global rate limiting middleware (to apply to all routes)
 */
export function globalRateLimit() {
  return async (c: Context<{ Variables: AppVariables }>, next: Next) => {
    // Skip for health checks and static assets
    if (
      c.req.path.startsWith("/health") ||
      c.req.path.startsWith("/assets") ||
      c.req.path === "/"
    ) {
      return await next();
    }

    // Look up the specific config or use a conservative default
    const pathConfig = RATE_LIMIT_CONFIGS[c.req.path] || directReadBucket(c);
    const config: RateLimitConfig = pathConfig || { limit: 300, window: 60 }; // 300 req/min default

    try {
      const result = await checkRateLimit(c, config);

      c.header("X-RateLimit-Limit", String(result.limit));
      c.header("X-RateLimit-Remaining", String(result.remaining));
      c.header("X-RateLimit-Reset", String(Math.ceil(result.reset / 1000)));

      const blocking = limitResponse(c, result, config.message);
      if (blocking) return blocking;
    } catch {
      // See `rateLimit()`: open by default, closed if the route asks for it.
      if (config.failClosed) return withoutCounter(c);
    }

    await next();
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINTS DE ADMIN
// ═══════════════════════════════════════════════════════════════════════════════

import { Hono } from "hono";

import { requireAuth } from "../middleware/auth";
import type { AppVariables } from "../types/hono";

export const rateLimitRoutes = new Hono<{ Variables: AppVariables }>();

/**
 * GET /api/admin/rate-limits - View rate limiting statistics
 */
rateLimitRoutes.get("/", requireAuth, async (c) => {
  if (!valkeyConfigured()) {
    // Single instance: the counters are in this process's memory.
    const stats: Record<string, { active: number; totalRequests: number }> = {};
    for (const [key, bucket] of inMemoryReserve) {
      const parts = key.split(":");
      const route = (parts[1] === "kon" ? parts.slice(1, 4).join(":") : parts[1]) || "unknown";
      stats[route] ??= { active: 0, totalRequests: 0 };
      stats[route].active++;
      stats[route].totalRequests += bucket.hits.length;
    }
    return c.json({
      store: "memory",
      activeKeys: inMemoryReserve.size,
      routes: stats,
      configs: RATE_LIMIT_CONFIGS,
    });
  }

  let valkey: Awaited<ReturnType<typeof getValkeyClient>>;
  try {
    valkey = await getValkeyClient();
  } catch {
    return c.json({ error: "Valkey not available" }, 503);
  }

  try {
    // Scan the rate-limit keys
    const keys: string[] = [];
    let cursor = "0";

    do {
      const result = await valkey.scan(cursor, { MATCH: "ratelimit:*", COUNT: 100 });
      cursor = result.cursor;
      keys.push(...result.keys);
    } while (cursor !== "0");

    // Group by route
    const stats: Record<string, { active: number; totalRequests: number }> = {};

    for (const key of keys.slice(0, 100)) {
      // Limit to 100 keys
      const parts = key.split(":");
      // Kon limits carry their namespace in front: `ratelimit:kon:<id>:<route>:…`.
      const route = (parts[1] === "kon" ? parts.slice(1, 4).join(":") : parts[1]) || "unknown";
      const count = await valkey.zCard(key);

      if (!stats[route]) {
        stats[route] = { active: 0, totalRequests: 0 };
      }
      stats[route].active++;
      stats[route].totalRequests += count;
    }

    return c.json({
      activeKeys: keys.length,
      routes: stats,
      configs: RATE_LIMIT_CONFIGS,
    });
  } catch (error) {
    console.error("Rate limit stats error:", error);
    return c.json({ error: "Failed to fetch rate limit stats" }, 500);
  }
});

/**
 * DELETE /api/admin/rate-limits/:key - Reset a specific rate limit
 */
rateLimitRoutes.delete("/:key", requireAuth, async (c) => {
  const key = c.req.param("key");
  if (!valkeyConfigured()) {
    inMemoryReserve.delete(`ratelimit:${key}`);
    return c.json({ success: true, message: `Rate limit cleared for ${key}` });
  }

  let valkey: Awaited<ReturnType<typeof getValkeyClient>>;
  try {
    valkey = await getValkeyClient();
  } catch {
    return c.json({ error: "Valkey not available" }, 503);
  }

  try {
    await valkey.del(`ratelimit:${key}`);
    return c.json({ success: true, message: `Rate limit cleared for ${key}` });
  } catch (error) {
    return c.json({ error: "Failed to clear rate limit" }, 500);
  }
});
