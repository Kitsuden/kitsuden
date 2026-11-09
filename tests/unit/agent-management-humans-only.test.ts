/**
 * Agent management by people only, fresh role in `requireAuth` and the audit IP
 * of `agentAuthWithRBAC` (security review 2026-11-04)
 * ============================================================================
 *
 *   · An agent with `admin` (and `!pattern` denials) could rewrite its own
 *     scopes over REST (`PUT /api/v1/agents/<itself>/scopes`), create another
 *     admin agent, mint itself keys, or run another agent through the
 *     playground. Now every WRITE by an agent on agent management is a 403 on
 *     each router (index.ts also refuses it by path); reads keep their usual
 *     gate. And `requireRole` does not let an `admin` agent through when one of
 *     its denials covers the route.
 *   · `requireAuth` must not leave the cookie-cached (stale) role in place of
 *     the fresh one: a privileged role is re-read from the database.
 *   · `agentAuthWithRBAC` stored the raw `x-forwarded-for` as the audit IP.
 *
 * The database is faked and THROWS if anything touches it: a route the gate
 * should have cut that reaches its handler shows up as a 500, never as a query.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeSession = { user: Record<string, unknown>; session: Record<string, unknown> };

const sessions = vi.hoisted(() => ({
  /** What `getSession` returns from the cookie cache. */
  fromCookie: null as null | FakeSession,
  /** What `getSession` returns with `disableCookieCache` (the database). */
  fromDatabase: null as null | FakeSession,
  calls: [] as Array<{ noCache: boolean }>,
}));

vi.mock("../../apps/api/src/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(async (opts: { query?: { disableCookieCache?: boolean } }) => {
        const noCache = opts?.query?.disableCookieCache === true;
        sessions.calls.push({ noCache });
        return noCache ? sessions.fromDatabase : sessions.fromCookie;
      }),
    },
  },
}));

vi.mock("../../apps/api/src/db", () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error("the database is not available in this test");
      },
    }
  ),
}));

const authentications = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../../apps/api/src/services/agent-auth", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    authenticateAgent: vi.fn(async (_key: string, opts: Record<string, unknown>) => {
      authentications.push(opts);
      return { success: false, error: "Invalid API key", code: "INVALID_KEY" };
    }),
  };
});

import { forgetKonRouters, registerKonRouter } from "../../apps/api/src/lib/kon-routes";
import { agentAuthWithRBAC } from "../../apps/api/src/middleware/agent-rbac";
import { requireAuth } from "../../apps/api/src/middleware/auth";
import {
  noAgentsInAgentManagement,
  requireAdminRole,
  setSessionRefresh,
} from "../../apps/api/src/middleware/auth-guard";
import { agentNotificationsRoutes } from "../../apps/api/src/routes/agent-notifications";
import { agentPermissionsRoutes } from "../../apps/api/src/routes/agent-permissions";
import agentPlaygroundRoutes from "../../apps/api/src/routes/agent-playground";
import agentRoutes from "../../apps/api/src/routes/agents";
import { agentsV1Routes } from "../../apps/api/src/routes/agents-v1";

registerKonRouter("kon-denytest", "/api/denytest", { routes: [] });
afterAll(() => forgetKonRouters());

beforeEach(() => {
  sessions.fromCookie = null;
  sessions.fromDatabase = null;
  sessions.calls.length = 0;
  authentications.length = 0;
  setSessionRefresh(async () => ({ role: "admin" }));
});
afterEach(() => setSessionRefresh(async () => ({ role: "admin" })));

// ── Who is calling ──────────────────────────────────────────────────────────

const TRIMMED_ADMIN_AGENT = ["admin", "!datasets:payroll:*"];

function asAgent(scopes: string[], id = "ag_me"): MiddlewareHandler {
  return async (c, next) => {
    c.set("agent" as never, { agentId: id, scopes, sponsor: null } as never);
    c.set("user" as never, { id, role: "agent", scopes } as never);
    c.set("session" as never, null as never);
    await next();
  };
}

function asPerson(role: string): MiddlewareHandler {
  return async (c, next) => {
    c.set("user" as never, { id: "u_admin", role } as never);
    c.set("session" as never, { id: "s_1" } as never);
    await next();
  };
}

function asLegacyKey(): MiddlewareHandler {
  return async (c, next) => {
    c.set("user" as never, { id: "machine-k1", role: "admin" } as never);
    c.set("session" as never, null as never);
    await next();
  };
}

/** The app with the agent-management routers mounted as in index.ts / rpc.ts. */
function managementApp(who: MiddlewareHandler) {
  const a = new Hono();
  a.use("*", who);
  a.route("/api/admin/agents", agentNotificationsRoutes);
  a.route("/api/admin/agents", agentRoutes);
  a.route("/api/v1", agentsV1Routes);
  a.route("/api/v1", agentPermissionsRoutes);
  a.route("/api/admin/agents", agentPlaygroundRoutes);
  return a;
}

function send(a: Hono, method: string, path: string, body?: unknown) {
  return a.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const WRITES: Array<[string, string, unknown]> = [
  ["PUT", "/api/v1/agents/ag_me/scopes", { scopes: ["admin"] }],
  ["POST", "/api/v1/agents/ag_me/keys", {}],
  ["POST", "/api/v1/agents/ag_me/keys/k1/rotate", {}],
  ["POST", "/api/v1/agents/ag_me/keys/k1/revoke", {}],
  ["PUT", "/api/v1/agents/ag_me/quotas", { writesPerDay: null }],
  ["PUT", "/api/v1/agents/ag_me/sponsor", { userId: null }],
  ["PUT", "/api/v1/agents/ag_me/mcp-settings", { toolset: null }],
  ["POST", "/api/v1/agents/ag_me/versions/1/restore", {}],
  ["POST", "/api/v1/agents", { name: "other", scopes: ["admin"] }],
  ["PATCH", "/api/v1/agents/ag_me", { scopes: ["admin"] }],
  ["DELETE", "/api/v1/agents/ag_other", undefined],
  ["POST", "/api/v1/agents/ag_other/token", {}],
  ["POST", "/api/v1/agents/ag_other/playground", { message: "hello" }],
  ["POST", "/api/v1/identities", { name: "other", scopes: ["admin"] }],
  ["PATCH", "/api/v1/identities/ag_me", { scopes: ["admin"] }],
  ["DELETE", "/api/v1/identities/ag_other", undefined],
  ["POST", "/api/admin/agents", { name: "other", scopes: ["admin"] }],
  ["PUT", "/api/admin/agents/ag_me", { scopes: ["admin"] }],
  ["DELETE", "/api/admin/agents/ag_other", undefined],
  ["POST", "/api/admin/agents/ag_me/keys", {}],
  ["DELETE", "/api/admin/agents/ag_me/keys/k1", undefined],
  ["POST", "/api/admin/agents/ag_other/chat", { message: "hello" }],
  ["PUT", "/api/admin/agents/ag_me/notify", { url: null }],
  ["POST", "/api/admin/agents/ag_me/notify/rotate", {}],
];

// ── Agent management ────────────────────────────────────────────────────────

describe("agent management is not written by an agent", () => {
  it.each(WRITES)("admin agent with denials: %s %s → 403", async (method, path, body) => {
    const r = await send(managementApp(asAgent(TRIMMED_ADMIN_AGENT)), method, path, body);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { message?: string }).message ?? "").toMatch(
      /Agents cannot manage agents/
    );
  });

  it("nor a plain `admin` agent, nor against another agent", async () => {
    const a = managementApp(asAgent(["admin"]));
    expect(
      (await send(a, "PUT", "/api/v1/agents/ag_other/scopes", { scopes: ["admin"] })).status
    ).toBe(403);
    expect((await send(a, "POST", "/api/admin/agents", { name: "x" })).status).toBe(403);
  });

  it("nor a legacy `kitsuden_sk_*` key (synthetic user `machine-…`)", async () => {
    // Without a cookie session, `requireAuth` already stops it (401); the middleware, if reached, 403.
    const a = managementApp(asLegacyKey());
    expect([401, 403]).toContain(
      (await send(a, "PUT", "/api/v1/agents/ag_other/scopes", { scopes: ["admin"] })).status
    );
    const b = new Hono();
    b.use("*", asLegacyKey());
    b.use("*", noAgentsInAgentManagement);
    b.all("*", (c) => c.text("inside"));
    expect((await b.request("/x", { method: "PUT" })).status).toBe(403);
  });

  it("a human admin passes the gate (reaches the handler: here, the fake database)", async () => {
    sessions.fromCookie = { user: { id: "u_admin", role: "admin" }, session: { id: "s_1" } };
    sessions.fromDatabase = sessions.fromCookie;
    const a = managementApp(asPerson("admin"));
    const r = await send(a, "PUT", "/api/v1/agents/ag_other/scopes", { scopes: ["admin"] });
    expect(r.status).not.toBe(403);
    expect(r.status).not.toBe(401);
    const r2 = await send(a, "POST", "/api/admin/agents", { name: "new" });
    expect(r2.status).not.toBe(403);
    expect(r2.status).not.toBe(401);
  });

  it("the middleware lets reads and people through", async () => {
    const a = new Hono();
    a.use("*", asAgent(["admin"]));
    a.use("*", noAgentsInAgentManagement);
    a.all("*", (c) => c.text("inside"));
    expect((await a.request("/x", { method: "GET" })).status).toBe(200);
    expect((await a.request("/x", { method: "HEAD" })).status).toBe(200);
    expect((await a.request("/x", { method: "POST" })).status).toBe(403);

    const b = new Hono();
    b.use("*", asPerson("admin"));
    b.use("*", noAgentsInAgentManagement);
    b.all("*", (c) => c.text("inside"));
    expect((await b.request("/x", { method: "POST" })).status).toBe(200);
  });
});

describe("`requireRole` does not skip the denials of an `admin` agent", () => {
  function app(scopes: string[]) {
    const a = new Hono();
    a.use("*", asAgent(scopes));
    a.use("*", requireAdminRole);
    a.all("*", (c) => c.text("inside"));
    return a;
  }

  it("`admin` + `!denytest:*` → 403 on the denied kon", async () => {
    const r = await app(["admin", "!denytest:*"]).request("/api/denytest/something");
    expect(r.status).toBe(403);
    expect(((await r.json()) as { message: string }).message).toContain("!denytest:*");
  });

  it("`admin` + a denial that does not cover the route → inside", async () => {
    expect((await app(["admin", "!otherkon:*"]).request("/api/denytest/something")).status).toBe(
      200
    );
    expect((await app(["admin"]).request("/api/denytest/something")).status).toBe(200);
  });
});

// ── Fresh role in requireAuth ───────────────────────────────────────────────

describe("`requireAuth` does not keep the stale cookie role", () => {
  function app(before?: MiddlewareHandler) {
    const a = new Hono();
    if (before) a.use("*", before);
    a.use("*", requireAuth);
    a.get("*", (c) =>
      c.json({ role: (c.get("user" as never) as { role?: string } | null)?.role ?? null })
    );
    return a;
  }

  it("session already resolved by the global middleware (fresh role: user) → stays user", async () => {
    // The cookie still says admin; the database says user.
    sessions.fromCookie = { user: { id: "u1", role: "admin" }, session: { id: "s1" } };
    sessions.fromDatabase = { user: { id: "u1", role: "user" }, session: { id: "s1" } };
    const r = await app(asPerson("user")).request("/api/graph/data_sources");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { role: string }).role).toBe("user");
  });

  it("without the global middleware (early routes): a privileged role is re-read without cache", async () => {
    sessions.fromCookie = { user: { id: "u1", role: "admin" }, session: { id: "s1" } };
    sessions.fromDatabase = { user: { id: "u1", role: "user" }, session: { id: "s1" } };
    const r = await app().request("/api/graph/data_sources");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { role: string }).role).toBe("user");
    expect(sessions.calls).toEqual([{ noCache: false }, { noCache: true }]);
  });

  it("session closed in the database → 401", async () => {
    sessions.fromCookie = { user: { id: "u1", role: "editor" }, session: { id: "s1" } };
    sessions.fromDatabase = null;
    expect((await app().request("/x")).status).toBe(401);
  });

  it("a role without privileges does not pay for the second read", async () => {
    sessions.fromCookie = { user: { id: "u1", role: "user" }, session: { id: "s1" } };
    expect((await app().request("/x")).status).toBe(200);
    expect(sessions.calls).toEqual([{ noCache: false }]);
  });

  it("no session → 401; and a legacy key (no session) still does not pass", async () => {
    expect((await app().request("/x")).status).toBe(401);
    expect((await app(asLegacyKey()).request("/x")).status).toBe(401);
  });
});

// ── Audit IP ────────────────────────────────────────────────────────────────

describe("`agentAuthWithRBAC` audits the real IP", () => {
  function app() {
    const a = new Hono();
    a.use(
      "*",
      agentAuthWithRBAC({ scopes: ["memory:read"], action: "read", resource: "memory" } as never)
    );
    a.get("*", (c) => c.text("inside"));
    return a;
  }

  it("public socket: the client's `x-forwarded-for` does not count", async () => {
    const r = await app().request(
      "/api/agent/memory",
      { headers: { Authorization: "Bearer x", "X-Forwarded-For": "203.0.113.9" } },
      { ip: { address: "198.51.100.7" } }
    );
    expect(r.status).toBe(401);
    expect(authentications).toHaveLength(1);
    expect(authentications[0]!.ipAddress).toBe("198.51.100.7");
    expect(authentications[0]!.route).toBe("/api/agent/memory");
  });

  it("behind our proxy: what the client writes on the left does not count", async () => {
    await app().request(
      "/api/agent/memory",
      { headers: { Authorization: "Bearer x", "X-Forwarded-For": "203.0.113.9, 198.51.100.20" } },
      { ip: { address: "10.0.0.2" } }
    );
    expect(authentications[0]!.ipAddress).toBe("198.51.100.20");
  });
});
