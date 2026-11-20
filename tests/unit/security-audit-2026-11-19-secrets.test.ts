/**
 * Security audit 2026-11-19: an agent does not change agent limits through the
 * secrets manager.
 *
 * An agent key with `admin` could `POST /api/admin/secrets
 * {"key":"QUEUE_AGENT_JOB_COST","value":"0"}`: the value went into
 * `process.env` and switched off every agent's job budget. Now the queue and
 * rate-limit knobs are reserved keys, and every write route of the secrets
 * manager refuses agents.
 *
 * The database is faked and THROWS if touched: a refused write is a 403 with no
 * query.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../apps/api/src/db", () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error("the database is not available in this test");
      },
    }
  ),
  isLiteMode: false,
}));

const { secretsRoutes } = await import("../../apps/api/src/routes/secrets");
const { isValidSecretKey } = await import("../../apps/api/src/services/secrets");

function appAs(who: { agent?: Record<string, unknown>; user: Record<string, unknown> }) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set as (k: string, v: unknown) => void;
    if (who.agent) set("agent", who.agent);
    set("user", who.user);
    await next();
  });
  app.route("/api/admin/secrets", secretsRoutes);
  return app;
}

describe("reserved keys", () => {
  it("queue, rate-limit and agent-key knobs cannot be stored", () => {
    for (const k of [
      "QUEUE_AGENT_JOB_COST",
      "QUEUE_BUDGET_EXHAUSTED",
      "QUEUE_WORKER",
      "RATE_LIMIT_ENABLED",
      "AGENT_KEY_DEFAULT_EXPIRY_DAYS",
    ]) {
      expect(isValidSecretKey(k), k).toBe(false);
    }
    expect(isValidSecretKey("OPENAI_API_KEY")).toBe(true);
  });
});

describe("secrets write routes", () => {
  const agent = appAs({
    agent: { id: "a1", scopes: ["admin"] },
    user: { id: "u1", role: "admin" },
  });

  it("refuse an admin-scoped agent on every write route", async () => {
    for (const [method, path, body] of [
      ["POST", "/api/admin/secrets", { key: "OPENAI_API_KEY", value: "x" }],
      ["POST", "/api/admin/secrets/reload", undefined],
      ["POST", "/api/admin/secrets/OPENAI_API_KEY/inject", undefined],
      ["DELETE", "/api/admin/secrets/OPENAI_API_KEY", undefined],
    ] as const) {
      const res = await agent.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it("a person with a reserved key gets a 400, not a write", async () => {
    const human = appAs({ user: { id: "u2", role: "admin" } });
    const res = await human.request("/api/admin/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "QUEUE_AGENT_JOB_COST", value: "0" }),
    });
    expect(res.status).toBe(400);
  });
});
