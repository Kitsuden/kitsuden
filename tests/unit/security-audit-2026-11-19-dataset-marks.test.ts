/**
 * Security audit 2026-11-19: an agent does not strip a dataset's customer-data
 * marks through a generic writer.
 *
 * `PUT /api/data-sets/:id` refuses an agent that removes a field's
 * `sensitivity` mark. The explorer (`PATCH /api/explorer/datasets/:id`), items,
 * GraphQL and inline relations wrote the same `data_sets` row without that
 * check. Now an agent never writes `data_sets` through them; a person still can.
 *
 * The database is faked and THROWS if touched: a refused write is a 403 with no
 * query; a write that gets through reaches the database and fails as a 500.
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

vi.mock("../../apps/api/src/lib/auth", () => ({
  auth: { api: { getSession: vi.fn(async () => null) } },
}));

const { explorerRoutes } = await import("../../apps/api/src/routes/data-explorer");
const { whyNativeTableIsNotWritable, agentWriteNeedsOwnRoute } =
  await import("../../apps/api/src/lib/explorable-tables");

function appAs(who: { agent?: Record<string, unknown>; user: Record<string, unknown> }) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set as (k: string, v: unknown) => void;
    if (who.agent) set("agent", who.agent);
    set("user", who.user);
    await next();
  });
  app.route("/api/explorer", explorerRoutes);
  return app;
}

const unmarked = JSON.stringify({ schema: [{ key: "email", type: "text" }] });

describe("explorer writes to datasets", () => {
  const agent = appAs({
    agent: { id: "a1", scopes: ["admin"] },
    user: { id: "u1", role: "admin" },
  });

  it("refuses an admin-scoped agent's PATCH, POST and DELETE with 403 before the database", async () => {
    for (const [method, path, body] of [
      ["PATCH", "/api/explorer/datasets/ds1", unmarked],
      ["POST", "/api/explorer/datasets", unmarked],
      ["DELETE", "/api/explorer/datasets/ds1", undefined],
    ] as const) {
      const res = await agent.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(((await res.json()) as { message?: string }).message).toMatch(/\/api\/data-sets/);
    }
  });

  it("lets a human admin through to the write (it reaches the faked database)", async () => {
    const human = appAs({ user: { id: "u2", role: "admin" } });
    const res = await human.request("/api/explorer/datasets/ds1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: unmarked,
    });
    expect(res.status).not.toBe(403);
  });
});

describe("the shared rule for generic writers", () => {
  it("an agent may not write data_sets; a person may", () => {
    expect(agentWriteNeedsOwnRoute("data_sets")).toBe(true);
    expect(whyNativeTableIsNotWritable("data_sets", false, true)).toBe("only-via-own-route");
    expect(whyNativeTableIsNotWritable("data_sets", true, false)).toBeNull();
    expect(whyNativeTableIsNotWritable("media", false, true)).toBeNull();
  });
});
