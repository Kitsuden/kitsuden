/**
 * A kon's `rateLimits` are not counted twice.
 *
 * `applyKonRateLimits` mounts `rateLimit()` on the kon's route, and the API already
 * passes EVERY `/api/*` request through `globalRateLimit()`. Both generated the
 * same Valkey key (`ratelimit:<route>:<client>`), so each request
 * left two entries in the same zset: a kon that declared `limit: 4`
 * cut off at the third request. Now the kon's limit counts in its own
 * space (`ratelimit:kon:<id>:…`).
 *
 * Valkey here is an in-memory zset with the four operations the
 * limiter uses; the middleware and the mounting are the real ones.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const zsets = new Map<string, Array<{ score: number; value: string }>>();

vi.mock("../../apps/api/src/lib/valkey", () => ({
  // With Valkey configured (without it, the limiter counts in the process's memory).
  valkeyConfigured: () => true,
  getValkeyClient: async () => ({
    zRemRangeByScore: async (k: string, _min: number, max: number) => {
      zsets.set(
        k,
        (zsets.get(k) ?? []).filter((e) => e.score > max)
      );
    },
    zCard: async (k: string) => (zsets.get(k) ?? []).length,
    zAdd: async (k: string, e: { score: number; value: string }) => {
      zsets.set(k, [...(zsets.get(k) ?? []), e]);
    },
    pExpire: async () => true,
  }),
}));

const { globalRateLimit } = await import("../../apps/api/src/lib/rate-limiter");
const { applyKonRateLimits } = await import("../../apps/api/src/lib/module-loader");

const from = (ip: string) => ({ ip: { address: ip, family: "IPv4", port: 4000 } });

function appWithKon() {
  const app = new Hono();
  app.use("/api/*", globalRateLimit());
  applyKonRateLimits(
    app,
    { id: "kon-test", rateLimits: [{ path: "/send", limit: 4, window: 60 }] } as never,
    "/api/test"
  );
  app.post("/api/test/send", (c) => c.json({ ok: true }));
  return app;
}

beforeEach(() => zsets.clear());

describe("kon limits", () => {
  it("a limit: 4 lets 4 requests through, not 2", async () => {
    const app = appWithKon();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push(
        (await app.request("/api/test/send", { method: "POST" }, from("203.0.113.7"))).status
      );
    }
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
  });

  it("the kon's counter and the global one are different keys, one entry per request in each", async () => {
    const app = appWithKon();
    await app.request("/api/test/send", { method: "POST" }, from("203.0.113.8"));
    const keys = [...zsets.keys()].sort();
    expect(keys).toEqual([
      "ratelimit:/api/test/send:203.0.113.8",
      "ratelimit:kon:kon-test:/api/test/send:203.0.113.8",
    ]);
    for (const k of keys) expect(zsets.get(k)).toHaveLength(1);
  });
});
