/**
 * Per-agent quotas
 * ============================================================================
 *
 * Three limits per agent, configured in the panel:
 *
 *   rate_limit            requests per MINUTE (already existed: 60 by default)
 *   writes_per_day        writes per UTC day (POST/PUT/PATCH/DELETE; in
 *                         MCP, the tools that write). NULL = no limit
 *   budget_units_per_day  budget in UNITS per UTC day: each operation
 *                         costs 1, or whatever its `cost` declares in the kon
 *                         SDK. NULL = no limit
 *
 * When exceeded: 429 problem+json with `retry_after` (seconds until the
 * window opens: the next minute or UTC midnight):
 *
 *   KITSUDEN_E_RATE_LIMITED     the per-minute limit
 *   KITSUDEN_E_QUOTA_EXCEEDED   writes or the day's budget
 *
 * ── WHERE IT IS COUNTED ────────────────────────────────────────────────────
 *
 *   1. Valkey (INCR + EXPIRE). The normal case, and the only one that shares the count
 *      across replicas.
 *   2. Without Valkey: the minute in process MEMORY (it is short and per replica,
 *      like the global limiter) and the day in POSTGRES (`agent_quota_usage`,
 *      migration 0047), which survives restarts.
 *   3. If there is no database for the day either, it lets the request through (fail-open) and warns:
 *      a quota must not take the API down, and the per-minute limit stays in place.
 *
 * It is counted on ENTRY (after authenticating): an attempt rejected for permission
 * also spends. This way an agent that keeps pushing against a 403 is slowed down all the same.
 *
 * …except for an idempotency REPLAY (owner
 * decision): if the response goes out with `Idempotent-Replayed: true` (the one
 * stored from the first time, or the "not repeatable" 409), nothing was executed and
 * what was charged on entry (minute, write and units) is REFUNDED. It is charged
 * on entry and refunded afterwards, instead of charging after
 * idempotency, so as not to lose the above: a 403 still spends.
 *
 * It is called by the global middleware (`agentQuotas`, for REST) and the MCP
 * server for each `tools/call` (`consumeQuota`). The HTTP request that carries
 * the MCP JSON-RPC only counts for the minute: what spends is the
 * tool, not the envelope.
 */

import { buildProblem, operationCost, type KitsudenErrorCode } from "@kitsuden/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Context, Next } from "hono";

import { routeOperation } from "../../../../packages/engine/src/operations";
import { db } from "../db";
import { agentQuotaUsage } from "../db/schema";

import { VALID_IDEMPOTENCY_KEY, requestFingerprint, savedRepetition } from "./idempotency";
import { defaultStores } from "./idempotency-stores";
import { logger } from "./logger";
import { getValkeyClient } from "./valkey";

export interface AgentLimits {
  agentId: string;
  /** Requests per minute (0 or null = no limit). */
  rateLimit: number | null;
  writesPerDay: number | null;
  budgetUnitsPerDay: number | null;
}

export interface RequestedUsage {
  /** Does it count as a minute request? */
  request: boolean;
  /** Is it a write? */
  write: boolean;
  /** Budget units (0 = spends nothing). */
  units: number;
}

export type QuotaResult =
  | {
      allowed: true;
      /**
       * Refunds what was charged (minute, write and units). human approval,
       * owner decision: a response REPLAYED by idempotency
       * (`Idempotent-Replayed: true`) executes nothing and spends no quota.
       */
      giveBack: () => Promise<void>;
    }
  | {
      allowed: false;
      code: Extract<KitsudenErrorCode, "KITSUDEN_E_RATE_LIMITED" | "KITSUDEN_E_QUOTA_EXCEEDED">;
      limit: "requests_per_minute" | "writes_per_day" | "budget_units_per_day";
      max: number;
      retryAfter: number;
    };

export interface AgentUsage {
  day: string;
  requestsThisMinute: number;
  writesToday: number;
  unitsToday: number;
  store: "valkey" | "postgres" | "memory";
}

// ── Time ───────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` en UTC. */
export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function secondsUntilMidnightUtc(now = Date.now()): number {
  const d = new Date(now);
  const tomorrow = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((tomorrow - now) / 1000));
}

function currentMinute(now = Date.now()): number {
  return Math.floor(now / 60_000);
}

function secondsUntilNextMinute(now = Date.now()): number {
  return Math.max(1, Math.ceil(((currentMinute(now) + 1) * 60_000 - now) / 1000));
}

// ── Stores ─────────────────────────────────────────────────────────────────

interface ValkeyClient {
  incr(k: string): Promise<number>;
  incrBy(k: string, n: number): Promise<number>;
  decrBy(k: string, n: number): Promise<number>;
  expire(k: string, s: number): Promise<unknown>;
  get(k: string): Promise<string | null>;
}

/** Injectable in tests: `null` = Valkey is not there. */
let getValkey: () => Promise<ValkeyClient | null> = async () => {
  try {
    return (await getValkeyClient()) as unknown as ValkeyClient;
  } catch {
    return null;
  }
};

export function setQuotaValkey(fn: () => Promise<ValkeyClient | null>): void {
  getValkey = fn;
}

const key = (agentId: string, that: string) => `kitsuden:quota:${agentId}:${that}`;

// In-memory minute (reservation without Valkey).
const minutesInMemory = new Map<string, { minute: number; n: number }>();
const MAX_AGENTS_IN_MEMORY = 50_000;

function countMinuteInMemory(agentId: string, now: number): number {
  const m = currentMinute(now);
  const e = minutesInMemory.get(agentId);
  if (!e || e.minute !== m) {
    if (minutesInMemory.size >= MAX_AGENTS_IN_MEMORY) cleanQuotaMemory(now);
    minutesInMemory.set(agentId, { minute: m, n: 1 });
    return 1;
  }
  e.n++;
  return e.n;
}

/** Clears minute windows that are already closed (the test uses it too). */
export function cleanQuotaMemory(now = Date.now()): void {
  const m = currentMinute(now);
  for (const [k, e] of minutesInMemory) if (e.minute !== m) minutesInMemory.delete(k);
}

/** For tests. */
export function clearQuotaMemory(): void {
  minutesInMemory.clear();
}

async function addDayInPostgres(
  agentId: string,
  day: string,
  writes: number,
  units: number
): Promise<{ writes: number; units: number }> {
  const [row] = await db
    .insert(agentQuotaUsage)
    .values({ agentId, day, writes, units })
    .onConflictDoUpdate({
      target: [agentQuotaUsage.agentId, agentQuotaUsage.day],
      set: {
        writes: sql`${agentQuotaUsage.writes} + ${writes}`,
        units: sql`${agentQuotaUsage.units} + ${units}`,
        updatedAt: new Date(),
      },
    })
    .returning({ writes: agentQuotaUsage.writes, units: agentQuotaUsage.units });
  return { writes: row?.writes ?? writes, units: row?.units ?? units };
}

async function subtractDayInPostgres(agentId: string, day: string, writes: number, units: number) {
  await db
    .update(agentQuotaUsage)
    .set({
      writes: sql`greatest(0, ${agentQuotaUsage.writes} - ${writes})`,
      units: sql`greatest(0, ${agentQuotaUsage.units} - ${units})`,
    })
    .where(and(eq(agentQuotaUsage.agentId, agentId), eq(agentQuotaUsage.day, day)));
}

// ── Consume ────────────────────────────────────────────────────────────────

const withLimit = (n: number | null | undefined): n is number => typeof n === "number" && n > 0;

/**
 * The same as the `consumeQuota` steps with Valkey, in ONE script (one round
 * trip, and atomic):
 *
 *   1. minute (if it counts and there is a limit): INCR, EXPIRE 120 the first time; if
 *      exceeded, it returns without touching the day.
 *   2. day (if there is a write or units): INCR/GET of writes, INCRBY/GET
 *      of units, EXPIRE 2 days of what was added.
 *
 * Returns `{minute, writes, units, step}`: `step` 0 = the minute was
 * exceeded (and the day was not touched), 1 = there is nothing from the day to count, 2 = the
 * day was counted.
 */
const QUOTA_SCRIPT = `
local n = 0
if ARGV[1] == '1' then
  n = redis.call('INCR', KEYS[1])
  if n == 1 then redis.call('EXPIRE', KEYS[1], 120) end
  if n > tonumber(ARGV[2]) then return {n, 0, 0, 0} end
end
local w = tonumber(ARGV[3])
local u = tonumber(ARGV[4])
if w == 0 and u == 0 then return {n, 0, 0, 1} end
local writes
if w > 0 then
  writes = redis.call('INCR', KEYS[2])
  redis.call('EXPIRE', KEYS[2], 172800)
else
  writes = tonumber(redis.call('GET', KEYS[2]) or '0')
end
local units
if u > 0 then
  units = redis.call('INCRBY', KEYS[3], u)
  redis.call('EXPIRE', KEYS[3], 172800)
else
  units = tonumber(redis.call('GET', KEYS[3]) or '0')
end
return {n, writes, units, 2}`;

/** `false` after an EVAL failure that is not a connection one: separate steps from then on. */
let quotaScriptAvailable = true;

/**
 * `consumeQuota` with the script. `null` if this client cannot run it or
 * it fails (then it is repeated with the separate steps, which decide as before
 * what to do without Valkey). Same decisions and same returns as those steps.
 */
async function consumeWithScript(
  valkey: ValkeyClient,
  limits: AgentLimits,
  request: RequestedUsage,
  now: number
): Promise<QuotaResult | null> {
  const evaluate = (valkey as { eval?: unknown }).eval;
  if (!quotaScriptAvailable || typeof evaluate !== "function") return null;
  const { agentId } = limits;
  const minuteCount = request.request && withLimit(limits.rateLimit);
  const writesValue = request.write ? 1 : 0;
  const unitsValue = Math.max(0, Math.floor(request.units));
  const day = utcDay(now);
  const km = key(agentId, `min:${currentMinute(now)}`);
  const kw = key(agentId, `w:${day}`);
  const ku = key(agentId, `u:${day}`);

  let r: unknown;
  try {
    r = await (
      evaluate as (s: string, o: { keys: string[]; arguments: string[] }) => Promise<unknown>
    ).call(valkey, QUOTA_SCRIPT, {
      keys: [km, kw, ku],
      arguments: [
        minuteCount ? "1" : "0",
        String(limits.rateLimit ?? 0),
        String(writesValue),
        String(unitsValue),
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/unknown command|NOSCRIPT|ERR.*script|not allowed|disabled/i.test(message))
      quotaScriptAvailable = false;
    return null;
  }
  if (!Array.isArray(r) || r.length !== 4) return null;
  const [, writes, units, step] = r.map(Number) as [number, number, number, number];

  const returnMinute = async () => {
    if (minuteCount) await valkey.decrBy(km, 1);
  };
  if (step === 0) {
    return {
      allowed: false,
      code: "KITSUDEN_E_RATE_LIMITED",
      limit: "requests_per_minute",
      max: limits.rateLimit as number,
      retryAfter: secondsUntilNextMinute(now),
    };
  }
  if (step === 1) return { allowed: true, giveBack: returnMinute };

  const returnDay = async () => {
    if (writesValue) await valkey.decrBy(kw, writesValue);
    if (unitsValue) await valkey.decrBy(ku, unitsValue);
  };
  const writeCount = writesValue > 0 && withLimit(limits.writesPerDay);
  const unitCount = unitsValue > 0 && withLimit(limits.budgetUnitsPerDay);
  const passesWrites = writeCount && writes > (limits.writesPerDay as number);
  const passesUnits = unitCount && units > (limits.budgetUnitsPerDay as number);
  if (passesWrites || passesUnits) {
    await returnDay().catch(() => undefined);
    return {
      allowed: false,
      code: "KITSUDEN_E_QUOTA_EXCEEDED",
      limit: passesWrites ? "writes_per_day" : "budget_units_per_day",
      max: (passesWrites ? limits.writesPerDay : limits.budgetUnitsPerDay) as number,
      retryAfter: secondsUntilMidnightUtc(now),
    };
  }
  return {
    allowed: true,
    giveBack: async () => {
      await returnMinute().catch(() => undefined);
      await returnDay().catch(() => undefined);
    },
  };
}

/**
 * Counts the consumption and says whether it fits. If it does NOT fit, what was added for the day is
 * refunded (what is rejected by quota is not charged); the minute does count.
 */
export async function consumeQuota(
  limits: AgentLimits,
  request: RequestedUsage,
  now = Date.now()
): Promise<QuotaResult> {
  const { agentId } = limits;
  const valkey = await getValkey();

  // With Valkey: EVERYTHING in one round trip (before, up to six calls in a row).
  if (valkey) {
    const r = await consumeWithScript(valkey, limits, request, now);
    if (r) return r;
  }

  // 1. Per minute
  let returnMinute: () => Promise<void> = async () => undefined;
  if (request.request && withLimit(limits.rateLimit)) {
    let n: number;
    const k = key(agentId, `min:${currentMinute(now)}`);
    const inMemory = () => {
      const m = currentMinute(now);
      returnMinute = async () => {
        const e = minutesInMemory.get(agentId);
        if (e && e.minute === m && e.n > 0) e.n--;
      };
      return countMinuteInMemory(agentId, now);
    };
    if (valkey) {
      try {
        n = await valkey.incr(k);
        if (n === 1) await valkey.expire(k, 120);
        returnMinute = async () => {
          await valkey.decrBy(k, 1);
        };
      } catch {
        n = inMemory();
      }
    } else {
      n = inMemory();
    }
    if (n > limits.rateLimit) {
      return {
        allowed: false,
        code: "KITSUDEN_E_RATE_LIMITED",
        limit: "requests_per_minute",
        max: limits.rateLimit,
        retryAfter: secondsUntilNextMinute(now),
      };
    }
  }

  // 2. Per day (writes and units)
  const writesValue = request.write ? 1 : 0;
  const unitsValue = Math.max(0, Math.floor(request.units));
  const writeCount = writesValue > 0 && withLimit(limits.writesPerDay);
  const unitCount = unitsValue > 0 && withLimit(limits.budgetUnitsPerDay);
  // It is counted even when there is no limit (the panel shows consumption), unless there is
  // nothing to add.
  if (writesValue === 0 && unitsValue === 0) return { allowed: true, giveBack: returnMinute };
  // Without Valkey and without a daily limit nothing is written to Postgres on every request:
  // the reservation is for enforcing a quota, not for keeping statistics.
  if (!valkey && !writeCount && !unitCount) return { allowed: true, giveBack: returnMinute };

  const day = utcDay(now);
  let total: { writes: number; units: number };
  let giveBack: () => Promise<void>;
  try {
    if (valkey) {
      const kw = key(agentId, `w:${day}`);
      const ku = key(agentId, `u:${day}`);
      const writes = writesValue ? await valkey.incr(kw) : Number((await valkey.get(kw)) ?? 0);
      const units = unitsValue
        ? await valkey.incrBy(ku, unitsValue)
        : Number((await valkey.get(ku)) ?? 0);
      // 2 days: today's counter has to still be there until midnight.
      if (writesValue) await valkey.expire(kw, 2 * 86_400);
      if (unitsValue) await valkey.expire(ku, 2 * 86_400);
      total = { writes, units };
      giveBack = async () => {
        if (writesValue) await valkey.decrBy(kw, writesValue);
        if (unitsValue) await valkey.decrBy(ku, unitsValue);
      };
    } else {
      total = await addDayInPostgres(agentId, day, writesValue, unitsValue);
      giveBack = () => subtractDayInPostgres(agentId, day, writesValue, unitsValue);
    }
  } catch (err) {
    // Without a daily limit there is nothing to enforce: it passes. WITH a limit, it fails
    // CLOSED: before, a Postgres or Valkey outage removed the quota for all
    // agents.
    if (!writeCount && !unitCount) {
      logger.warn({ err, agentId }, "[quotas] could not count the day (no limit): allowed");
      return { allowed: true, giveBack: returnMinute };
    }
    logger.warn({ err, agentId }, "[quotas] could not count the day: rejected");
    await returnMinute().catch(() => undefined);
    return {
      allowed: false,
      code: "KITSUDEN_E_QUOTA_EXCEEDED",
      limit: writeCount ? "writes_per_day" : "budget_units_per_day",
      max: (writeCount ? limits.writesPerDay : limits.budgetUnitsPerDay) as number,
      retryAfter: 60,
    };
  }

  const passesWrites = writeCount && total.writes > (limits.writesPerDay as number);
  const passesUnits = unitCount && total.units > (limits.budgetUnitsPerDay as number);
  if (passesWrites || passesUnits) {
    await giveBack().catch(() => undefined);
    return {
      allowed: false,
      code: "KITSUDEN_E_QUOTA_EXCEEDED",
      limit: passesWrites ? "writes_per_day" : "budget_units_per_day",
      max: (passesWrites ? limits.writesPerDay : limits.budgetUnitsPerDay) as number,
      retryAfter: secondsUntilMidnightUtc(now),
    };
  }
  return {
    allowed: true,
    giveBack: async () => {
      await returnMinute().catch(() => undefined);
      await giveBack().catch(() => undefined);
    },
  };
}

/** The problem+json of a rejection (shared by REST and MCP). */
export function quotaProblem(r: Extract<QuotaResult, { allowed: false }>, instance?: string) {
  const that =
    r.limit === "requests_per_minute"
      ? `${r.max} requests per minute`
      : r.limit === "writes_per_day"
        ? `${r.max} writes per day (UTC)`
        : `${r.max} budget units per day (UTC)`;
  return buildProblem({
    code: r.code,
    status: 429,
    detail: `Agent quota exceeded: ${that}.`,
    retryAfter: r.retryAfter,
    instance,
    extensions: { quota: r.limit, limit: r.max },
  });
}

/** What has been spent today (for the panel). */
export async function agentUsage(agentId: string, now = Date.now()): Promise<AgentUsage> {
  const day = utcDay(now);
  const valkey = await getValkey();
  if (valkey) {
    try {
      const [min, w, u] = await Promise.all([
        valkey.get(key(agentId, `min:${currentMinute(now)}`)),
        valkey.get(key(agentId, `w:${day}`)),
        valkey.get(key(agentId, `u:${day}`)),
      ]);
      return {
        day,
        requestsThisMinute: Number(min ?? 0),
        writesToday: Number(w ?? 0),
        unitsToday: Number(u ?? 0),
        store: "valkey",
      };
    } catch {
      /* falls back to the reservation */
    }
  }
  const inMemory = minutesInMemory.get(agentId);
  const [row] = await db
    .select({ writes: agentQuotaUsage.writes, units: agentQuotaUsage.units })
    .from(agentQuotaUsage)
    .where(and(eq(agentQuotaUsage.agentId, agentId), eq(agentQuotaUsage.day, day)))
    .limit(1);
  return {
    day,
    requestsThisMinute: inMemory?.minute === currentMinute(now) ? inMemory.n : 0,
    writesToday: row?.writes ?? 0,
    unitsToday: row?.units ?? 0,
    store: "postgres",
  };
}

// ── Middleware REST ────────────────────────────────────────────────────────

const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The consumption of a REST request: its SDK operation if there is one (and its cost). */
export function requestUsage(method: string, path: string): RequestedUsage {
  const m = method.toUpperCase();
  if (m === "OPTIONS") return { request: false, write: false, units: 0 };
  // The MCP JSON-RPC envelope: the minute only. Each tool pays for its own.
  if (path === "/api/mcp" || path.startsWith("/api/mcp/")) {
    return { request: true, write: false, units: 0 };
  }
  // Recording what it chose NOT to do (lib/agent-decisions.ts): the minute only,
  // so an agent out of writes can still leave the note it is told to leave.
  if (path === "/api/agent/decisions") return { request: true, write: false, units: 0 };
  const ofRoute = routeOperation(m, path);
  return {
    request: true,
    write: WRITE.has(m),
    units: ofRoute ? operationCost(ofRoute.op) : 1,
  };
}

interface AgentWithQuotas {
  agentId: string;
  rateLimit?: number | null;
  writesPerDay?: number | null;
  budgetUnitsPerDay?: number | null;
}

/**
 * After global authentication: if the caller is an agent, it counts and, if
 * exceeded, 429. Leaves the minute's `X-RateLimit-*` headers.
 */
/**
 * Is this REST request the replay of one already made (same Idempotency-Key,
 * same fingerprint, stored response)? Then the idempotency middleware will
 * repeat it without executing anything, and it is not charged. It only looks at the store
 * if the request carries the header.
 */
async function isRepetition(c: Context, agentId: string): Promise<boolean> {
  const key = c.req.header("idempotency-key");
  if (!key || !VALID_IDEMPOTENCY_KEY.test(key) || !WRITE.has(c.req.method.toUpperCase())) {
    return false;
  }
  const path = c.req.path;
  if (!path.startsWith("/api/") || path.startsWith("/api/auth") || path.startsWith("/api/mcp"))
    return false;
  try {
    const body = new Uint8Array(await c.req.raw.clone().arrayBuffer());
    const fingerprint = requestFingerprint({
      method: c.req.method,
      path,
      query: new URL(c.req.url).search,
      type: c.req.header("content-type") ?? "",
      body,
    });
    return await savedRepetition(idempotencyStores(), `agent:${agentId}`, key, fingerprint);
  } catch {
    return false;
  }
}

/** Injectable in tests. */
let idempotencyStores = defaultStores;
export function setQuotaIdempotencyStores(fn: typeof defaultStores): void {
  idempotencyStores = fn;
}

export function agentQuotas() {
  return async (c: Context, next: Next) => {
    const agent = (c.get as (k: string) => unknown)("agent") as AgentWithQuotas | undefined;
    if (!agent?.agentId) return next();
    // An idempotency replay executes nothing: it spends nothing.
    if (await isRepetition(c, agent.agentId)) return next();
    const r = await consumeQuota(
      {
        agentId: agent.agentId,
        rateLimit: agent.rateLimit ?? null,
        writesPerDay: agent.writesPerDay ?? null,
        budgetUnitsPerDay: agent.budgetUnitsPerDay ?? null,
      },
      requestUsage(c.req.method, c.req.path)
    );
    if (!r.allowed) {
      c.header("Retry-After", String(r.retryAfter));
      return c.body(JSON.stringify(quotaProblem(r, c.req.path)), 429, {
        "Content-Type": "application/problem+json",
      });
    }
    await next();
    // An idempotency replay executed nothing: it spends nothing.
    if (c.res?.headers.get("idempotent-replayed") === "true") await r.giveBack();
  };
}
