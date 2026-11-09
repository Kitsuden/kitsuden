/**
 * Limiter with Valkey DOWN (earlier audit).
 *
 * `getValkeyClient()` does not return null when Valkey is not there: it throws. The
 * call was outside the `try` of `checkRateLimit`, the exception reached the
 * middleware's `catch {}` —which lets requests through— and login, signup,
 * password recovery and the magic link were left WITHOUT a brake: unlimited brute
 * force and email bombing while Valkey was down.
 * The `failClosed` kon routes (shop orders, newsletter) too.
 *
 * Here the middleware is executed for real with a Valkey that refuses the
 * connection. It goes in vitest and not in bun test because `vi.mock` is per file;
 * bun's `mock.module` would leak to the whole suite (see the test suite caveats).
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../apps/api/src/lib/valkey", () => ({
  // Valkey CONFIGURED and down (without a URL, the limiter always counts in memory:
  // tests/unit/rate-limiter-without-valkey.test.ts).
  valkeyConfigured: () => true,
  getValkeyClient: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:6379")),
}));

const { globalRateLimit, rateLimit, RATE_LIMIT_CONFIGS, clearInMemoryReserve } =
  await import("../../apps/api/src/lib/rate-limiter");

function appGlobal() {
  const app = new Hono();
  app.use("/api/*", globalRateLimit());
  app.all("/api/*", (c) => c.json({ ok: true }));
  return app;
}

/** Hono reads the IP from the socket's `env.ip` (what bun sets in production). */
const from = (ip: string) => ({ ip: { address: ip, family: "IPv4", port: 4000 } });

const post = (app: Hono, path: string, ip = "203.0.113.9") =>
  app.request(path, { method: "POST" }, from(ip));

beforeEach(() => {
  clearInMemoryReserve();
  delete process.env.RATE_LIMIT_MEMORY_MAX_KEYS;
});
afterEach(() => {
  delete process.env.RATE_LIMIT_MEMORY_MAX_KEYS;
});

describe("routes that send mail or check passwords: they fail CLOSED", () => {
  const SENSITIVE = [
    "/api/auth/sign-in/email",
    "/api/auth/sign-up/email",
    "/api/auth/request-password-reset",
    "/api/auth/forget-password",
    "/api/auth/send-verification-email",
    "/api/auth/change-password",
    "/api/auth/change-email",
    "/api/auth/delete-user",
    "/api/auth/reset-password",
    "/api/members/signin",
  ];

  it.each(SENSITIVE)("%s marks failClosed", (path) => {
    expect(RATE_LIMIT_CONFIGS[path]?.failClosed).toBe(true);
  });

  it("login is still throttled without Valkey: the 11th attempt in 5 min gives 429", async () => {
    const app = appGlobal();
    for (let i = 0; i < 10; i++) {
      expect((await post(app, "/api/auth/sign-in/email")).status).toBe(200);
    }
    const res = await post(app, "/api/auth/sign-in/email");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("the quota is per client: another IP does not inherit the block", async () => {
    const app = appGlobal();
    for (let i = 0; i < 11; i++) await post(app, "/api/auth/sign-in/email", "203.0.113.1");
    expect((await post(app, "/api/auth/sign-in/email", "203.0.113.2")).status).toBe(200);
  });

  it("if it cannot be counted in memory either: 503 with Retry-After and a generic message", async () => {
    process.env.RATE_LIMIT_MEMORY_MAX_KEYS = "2";
    const app = appGlobal();
    expect((await post(app, "/api/auth/sign-up/email", "198.51.100.1")).status).toBe(200);
    expect((await post(app, "/api/auth/sign-up/email", "198.51.100.2")).status).toBe(200);

    const res = await post(app, "/api/auth/sign-up/email", "198.51.100.3");
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = JSON.stringify(await res.json());
    // Generic: neither the part that fails nor the internal error.
    expect(body).not.toMatch(/valkey|redis|ECONNREFUSED|6379/i);
  });
});

describe("the rest of the routes still fail OPEN", () => {
  it("a normal read passes even if Valkey is down", async () => {
    process.env.RATE_LIMIT_MEMORY_MAX_KEYS = "1";
    const app = appGlobal();
    for (let i = 0; i < 400; i++) {
      // Above the global 300/min: without a counter nothing is throttled.
      if (i % 100 === 0) expect((await post(app, "/api/posts")).status).toBe(200);
    }
    expect((await post(app, "/api/posts", "192.0.2.77")).status).toBe(200);
  });
});

describe("limits declared by kons (rateLimit) with failClosed", () => {
  it("they throttle without Valkey and do not let anything through unlimited", async () => {
    const app = new Hono();
    app.use("/api/shop/orders", rateLimit({ limit: 2, window: 60, failClosed: true }));
    app.post("/api/shop/orders", (c) => c.json({ ok: true }));

    expect((await post(app, "/api/shop/orders")).status).toBe(200);
    expect((await post(app, "/api/shop/orders")).status).toBe(200);
    expect((await post(app, "/api/shop/orders")).status).toBe(429);
  });

  it("without failClosed, the kon fails open", async () => {
    const app = new Hono();
    app.use("/api/x/unsubscribe", rateLimit({ limit: 1, window: 60 }));
    app.post("/api/x/unsubscribe", (c) => c.json({ ok: true }));
    for (let i = 0; i < 3; i++) expect((await post(app, "/api/x/unsubscribe")).status).toBe(200);
  });
});
