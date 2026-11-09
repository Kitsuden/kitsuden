/**
 * Per-agent quotas: the counting logic, with no real database or Valkey
 * ============================================================================
 *
 * The full HTTP path (real Valkey and reservation in Postgres) is in
 * apps/api/src/tests/fine-grained-agent-permissions.test.ts. Here: what is counted,
 * when it is rejected, what `retry_after` comes out and that what is rejected by
 * the daily quota is not charged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../apps/api/src/db", () => ({ db: {} }));
vi.mock("../../apps/api/src/db/schema", () => ({ agentQuotaUsage: {} }));
vi.mock("../../apps/api/src/lib/valkey", () => ({
  getValkeyClient: async () => {
    throw new Error("no valkey in this test");
  },
}));

import {
  consumeQuota,
  requestUsage,
  utcDay,
  quotaProblem,
  secondsUntilMidnightUtc,
  setQuotaValkey,
  clearQuotaMemory,
} from "../../apps/api/src/lib/agent-quotas";

/** A fake Valkey: INCR/INCRBY/DECRBY/GET/EXPIRE over a Map. */
function fakeValkey() {
  const m = new Map<string, number>();
  return {
    data: m,
    client: {
      incr: async (k: string) => (m.set(k, (m.get(k) ?? 0) + 1), m.get(k)!),
      incrBy: async (k: string, n: number) => (m.set(k, (m.get(k) ?? 0) + n), m.get(k)!),
      decrBy: async (k: string, n: number) => (m.set(k, (m.get(k) ?? 0) - n), m.get(k)!),
      expire: async () => 1,
      get: async (k: string) => (m.has(k) ? String(m.get(k)) : null),
    },
  };
}

const NOW = Date.UTC(2026, 9, 24, 23, 59, 30); // 30 s before UTC midnight

describe("time", () => {
  it("UTC day and seconds until midnight", () => {
    expect(utcDay(NOW)).toBe("2026-10-24");
    expect(secondsUntilMidnightUtc(NOW)).toBe(30);
  });
});

describe("consumeQuota with Valkey", () => {
  let v: ReturnType<typeof fakeValkey>;
  beforeEach(() => {
    v = fakeValkey();
    setQuotaValkey(async () => v.client);
  });

  it("per minute: the (n+1)th is KITSUDEN_E_RATE_LIMITED with retry_after until the next minute", async () => {
    const lim = { agentId: "a", rateLimit: 2, writesPerDay: null, budgetUnitsPerDay: null };
    const request = { request: true, write: false, units: 0 };
    expect((await consumeQuota(lim, request, NOW)).allowed).toBe(true);
    expect((await consumeQuota(lim, request, NOW)).allowed).toBe(true);
    const r = await consumeQuota(lim, request, NOW);
    expect(r).toMatchObject({
      allowed: false,
      code: "KITSUDEN_E_RATE_LIMITED",
      max: 2,
      retryAfter: 30,
    });
  });

  it("writes per day: rejects and does NOT charge what was rejected", async () => {
    const lim = { agentId: "b", rateLimit: null, writesPerDay: 1, budgetUnitsPerDay: null };
    const w = { request: true, write: true, units: 1 };
    expect((await consumeQuota(lim, w, NOW)).allowed).toBe(true);
    const r = await consumeQuota(lim, w, NOW);
    expect(r).toMatchObject({
      allowed: false,
      code: "KITSUDEN_E_QUOTA_EXCEEDED",
      limit: "writes_per_day",
    });
    expect(v.data.get("kitsuden:quota:b:w:2026-10-24")).toBe(1);
    // Reading is not writing
    expect((await consumeQuota(lim, { request: true, write: false, units: 1 }, NOW)).allowed).toBe(
      true
    );
  });

  it("budget: adds up the declared cost", async () => {
    const lim = { agentId: "c", rateLimit: null, writesPerDay: null, budgetUnitsPerDay: 10 };
    expect((await consumeQuota(lim, { request: true, write: false, units: 7 }, NOW)).allowed).toBe(
      true
    );
    const r = await consumeQuota(lim, { request: true, write: false, units: 5 }, NOW);
    expect(r).toMatchObject({
      allowed: false,
      limit: "budget_units_per_day",
      max: 10,
      retryAfter: 30,
    });
    expect(v.data.get("kitsuden:quota:c:u:2026-10-24")).toBe(7);
  });

  it("the problem+json carries code, retry_after, quota and limit", () => {
    const p = quotaProblem(
      {
        allowed: false,
        code: "KITSUDEN_E_QUOTA_EXCEEDED",
        limit: "writes_per_day",
        max: 5,
        retryAfter: 120,
      },
      "/api/blog"
    );
    expect(p).toMatchObject({
      status: 429,
      code: "KITSUDEN_E_QUOTA_EXCEEDED",
      retryable: true,
      retry_after: 120,
      quota: "writes_per_day",
      limit: 5,
    });
  });
});

describe("without Valkey", () => {
  beforeEach(() => {
    clearQuotaMemory();
    setQuotaValkey(async () => null);
  });

  it("the minute is counted in memory", async () => {
    const lim = { agentId: "d", rateLimit: 1, writesPerDay: null, budgetUnitsPerDay: null };
    const request = { request: true, write: true, units: 1 };
    expect((await consumeQuota(lim, request, NOW)).allowed).toBe(true);
    expect((await consumeQuota(lim, request, NOW)).allowed).toBe(false);
    // Another minute: it lets through again
    expect((await consumeQuota(lim, request, NOW + 60_000)).allowed).toBe(true);
  });
});

describe("requestUsage", () => {
  it("writes by method, and the MCP envelope only counts the minute", () => {
    expect(requestUsage("GET", "/api/blog")).toEqual({ request: true, write: false, units: 1 });
    expect(requestUsage("DELETE", "/api/x/1")).toEqual({ request: true, write: true, units: 1 });
    expect(requestUsage("POST", "/api/mcp")).toEqual({ request: true, write: false, units: 0 });
    expect(requestUsage("OPTIONS", "/api/blog").request).toBe(false);
  });
});
