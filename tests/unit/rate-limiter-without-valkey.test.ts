/**
 * The limiter WITHOUT Valkey configured (single instance)
 * ============================================================================
 *
 * Without `VALKEY_URL` all routes count in the process's memory —not just
 * the `failClosed` ones, as with Valkey down— and never in Postgres. If the key
 * cap fills up, normal routes let requests through and `failClosed` ones reject
 * with 503 (the same criterion as with Valkey down).
 */

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const attempts = vi.hoisted(() => ({ n: 0 }));

vi.mock("../../apps/api/src/lib/valkey", () => ({
  valkeyConfigured: () => false,
  getValkeyClient: () => {
    attempts.n++;
    return Promise.reject(new Error("should not be called without VALKEY_URL"));
  },
}));

const { globalRateLimit, clearInMemoryReserve } =
  await import("../../apps/api/src/lib/rate-limiter");

function appGlobal() {
  const app = new Hono();
  app.use("/api/*", globalRateLimit());
  app.all("/api/*", (c) => c.json({ ok: true }));
  return app;
}

const from = (ip: string) => ({ ip: { address: ip, family: "IPv4", port: 4000 } });
const get = (app: Hono, path: string, ip = "203.0.113.20") =>
  app.request(path, { method: "GET" }, from(ip));
const post = (app: Hono, path: string, ip = "203.0.113.20") =>
  app.request(path, { method: "POST" }, from(ip));

beforeEach(() => {
  clearInMemoryReserve();
  attempts.n = 0;
  delete process.env.RATE_LIMIT_MEMORY_MAX_KEYS;
});
afterEach(() => {
  delete process.env.RATE_LIMIT_MEMORY_MAX_KEYS;
});

describe("limiter without VALKEY_URL", () => {
  it("a normal route IS throttled (in memory), it does not pass unlimited", async () => {
    const app = appGlobal();
    let last = 200;
    for (let i = 0; i < 400 && last === 200; i++) last = (await get(app, "/api/posts")).status;
    expect(last).toBe(429);
  });

  it("does not try to connect to Valkey", async () => {
    const app = appGlobal();
    await get(app, "/api/posts");
    await post(app, "/api/auth/sign-in/email");
    expect(attempts.n).toBe(0);
  });

  it("login is throttled the same: the 11th attempt in 5 min gives 429", async () => {
    const app = appGlobal();
    for (let i = 0; i < 10; i++)
      expect((await post(app, "/api/auth/sign-in/email")).status).toBe(200);
    expect((await post(app, "/api/auth/sign-in/email")).status).toBe(429);
  });

  it("cap full: the normal route lets through, the failClosed one rejects", async () => {
    process.env.RATE_LIMIT_MEMORY_MAX_KEYS = "1";
    const app = appGlobal();
    expect((await get(app, "/api/posts", "198.51.100.1")).status).toBe(200);
    expect((await get(app, "/api/posts", "198.51.100.2")).status).toBe(200);
    expect((await post(app, "/api/auth/sign-up/email", "198.51.100.3")).status).toBe(503);
  });
});
