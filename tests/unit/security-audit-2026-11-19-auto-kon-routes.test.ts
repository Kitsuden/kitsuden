/**
 * Audit 2026-11-19: an engine auto-kon's REST routes are admin-only and take no raw SQL
 * ============================================================================
 *
 * `defineKon` mounts generic CRUD at /api/<id>/<table> on the db handed over at
 * startup (system context, outside RLS). The routes answered anyone without a
 * session, put the `orderBy` query parameter into `sql.raw`, and wrote the whole
 * request body (any column) on create and update. Now: a human admin or an agent
 * that opens the whole kon; column keys only; `id` never written from the body.
 */

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { autoRouteRefusal, defineKon } from "../../packages/engine/src/kon";

const notes = pgTable("auditnotes", {
  id: text("id").primaryKey(),
  title: text("title"),
  ownerId: text("owner_id"),
  createdAt: timestamp("created_at"),
});

/** A drizzle-shaped fake that records what each call received. */
function fakeDb() {
  const calls: { op: string; arg: unknown }[] = [];
  const chain: Record<string, unknown> = {};
  const rows = [{ id: "n1", title: "t" }];
  for (const m of ["select", "from", "limit", "offset", "where", "values", "set"]) {
    chain[m] = (arg: unknown) => {
      calls.push({ op: m, arg });
      return chain;
    };
  }
  chain.orderBy = (arg: unknown) => {
    calls.push({ op: "orderBy", arg });
    return chain;
  };
  chain.insert = (arg: unknown) => (calls.push({ op: "insert", arg }), chain);
  chain.update = (arg: unknown) => (calls.push({ op: "update", arg }), chain);
  chain.delete = (arg: unknown) => (calls.push({ op: "delete", arg }), chain);
  chain.returning = () => Promise.resolve(rows);
  chain.then = (resolve: (v: unknown) => unknown) => resolve(rows.map((r) => ({ ...r, total: 1 })));
  return { db: chain, calls };
}

function appWith(user: unknown) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const kon = defineKon({ id: "auditkon", models: [notes], mcp: { enabled: false } });
  const { db, calls } = fakeDb();
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (user) (c.set as (k: string, v: unknown) => void)("user", user);
    await next();
  });
  kon.initialize({ db: { instance: db } } as never, app as never);
  return { app, calls };
}

describe("auto-kon routes require an administrator", () => {
  it("no session: 401 and the database is not touched", async () => {
    const { app, calls } = appWith(null);
    const list = await app.request("/api/auditkon/auditnotes");
    expect(list.status).toBe(401);
    const del = await app.request("/api/auditkon/auditnotes/n1", { method: "DELETE" });
    expect(del.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("a signed-in non-admin and a narrow agent get 403", async () => {
    expect(
      (await appWith({ id: "u", role: "user" }).app.request("/api/auditkon/auditnotes")).status
    ).toBe(403);
    const agent = { id: "a", role: "agent", scopes: ["kon:auditkon:list"] };
    expect((await appWith(agent).app.request("/api/auditkon/auditnotes")).status).toBe(403);
  });

  it("the refusal rule: admin, whole-kon agent, denial wins", () => {
    expect(autoRouteRefusal("crm", { role: "admin" })).toBeNull();
    expect(autoRouteRefusal("crm", { role: "agent", scopes: ["crm:*"] })).toBeNull();
    expect(autoRouteRefusal("crm", { role: "agent", scopes: ["admin", "!crm:*"] })?.status).toBe(
      403
    );
    expect(
      autoRouteRefusal(
        "crm",
        { role: "agent", scopes: ["crm:*"] },
        { requiredScopes: ["crm:export"] }
      )
    ).toBeNull();
    expect(
      autoRouteRefusal(
        "crm",
        { role: "agent", scopes: ["crm:*", "!crm:export"] },
        { requiredScopes: ["crm:export"] }
      )?.status
    ).toBe(403);
  });
});

describe("auto-kon routes take column keys, never raw SQL", () => {
  it("an orderBy expression is not passed through", async () => {
    const { app, calls } = appWith({ id: "adm", role: "admin" });
    const res = await app.request("/api/auditkon/auditnotes?orderBy=(SELECT%201)");
    expect(res.status).toBe(200);
    const order = calls.find((c) => c.op === "orderBy");
    expect(order).toBeDefined();
    // It falls back to the createdAt column; the raw text is nowhere in the clause.
    const chunks = (order!.arg as { queryChunks: unknown[] }).queryChunks;
    expect(chunks).toContain(notes.createdAt);
    const text = chunks
      .map((ch) =>
        ch && typeof ch === "object" && "value" in ch
          ? String((ch as { value: unknown }).value)
          : ""
      )
      .join(" ");
    expect(text).not.toContain("SELECT 1");
  });

  it("update writes only model columns and never the id", async () => {
    const { app, calls } = appWith({ id: "adm", role: "admin" });
    const res = await app.request("/api/auditkon/auditnotes/n1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "new", id: "other", evil: "x" }),
    });
    expect(res.status).toBe(200);
    const set = calls.find((c) => c.op === "set")!.arg as Record<string, unknown>;
    expect(set).toEqual({ title: "new" });
  });

  it("create drops keys that are not columns", async () => {
    const { app, calls } = appWith({ id: "adm", role: "admin" });
    const res = await app.request("/api/auditkon/auditnotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "n2", title: "t", "1=1; --": "x" }),
    });
    expect(res.status).toBe(201);
    expect(calls.find((c) => c.op === "values")!.arg).toEqual({ id: "n2", title: "t" });
  });
});
