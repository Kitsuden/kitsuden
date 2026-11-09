import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

function createMockFn(defaultImpl?: (...args: any[]) => any) {
  let impl = defaultImpl;
  const calls: any[][] = [];
  const fn = (...args: any[]) => {
    calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  (fn as any).mock = { calls };
  (fn as any).mockReset = () => {
    calls.length = 0;
    impl = defaultImpl;
  };
  (fn as any).mockResolvedValue = (v: any) => {
    impl = () => Promise.resolve(v);
  };
  return fn as any;
}

const getSession = createMockFn(() => Promise.resolve(null));

mock.module("../lib/auth", () => ({
  auth: { api: { getSession } },
}));

import { registerKonRouter } from "../lib/kon-routes";
import { protectRoute, requireAdmin, requireScope } from "../middleware/auth-guard";

afterAll(() => {
  mock.restore();
});

function createMockContext(initialVars: Record<string, any> = {}, path = "/api/comments") {
  const vars = new Map<string, any>(Object.entries(initialVars));
  return {
    get: (k: string) => vars.get(k),
    set: (k: string, v: any) => vars.set(k, v),
    req: { raw: { headers: new Headers() }, path, method: "POST" },
    json: (body: any, status?: number) => Promise.resolve({ body, status }),
  } as any;
}

const next = createMockFn(() => Promise.resolve());

describe("protectRoute", () => {
  beforeEach(() => {
    getSession.mockReset();
    next.mockReset();
  });

  // Security audit (middleware/agent-as-user.ts): an agent
  // key is not an account by being one. It passes with `user:act`, `admin` or a
  // scope from the route's family; with any other scope, 403.
  it("agent with user:act → calls next()", async () => {
    const c = createMockContext({ agent: { id: "agent-1", scopes: ["user:act"] } });
    await protectRoute(c, next);
    expect(next.mock.calls.length).toBe(1);
  });

  it("agent with a scope of the route's kon → calls next()", async () => {
    // The family comes from the kon MOUNTED at that prefix (a fake one, with
    // its own prefix: it does not overwrite the registry of the real kons)
    registerKonRouter("kon-guard-test", "/api/guard-test", { routes: [] });
    const c = createMockContext(
      { agent: { id: "agent-1", scopes: ["kon:guard-test:create"] } },
      "/api/guard-test/something"
    );
    await protectRoute(c, next);
    expect(next.mock.calls.length).toBe(1);
  });

  it("agent with an unrelated scope → 403, next() not called", async () => {
    const c = createMockContext({ agent: { id: "agent-1", scopes: ["read"] } });
    const result = (await protectRoute(c, next)) as any;
    expect(result.status).toBe(403);
    expect(next.mock.calls.length).toBe(0);
  });

  it("user present → calls next()", async () => {
    const c = createMockContext({ user: { id: "user-1", role: "admin" } });
    await protectRoute(c, next);
    expect(next.mock.calls.length).toBe(1);
  });

  it("no agent/user but auth session returns user → sets user/session, calls next()", async () => {
    const session = { user: { id: "user-2", role: "user" }, session: { id: "sess-1" } };
    getSession.mockResolvedValue(session);
    const c = createMockContext();
    await protectRoute(c, next);
    expect(c.get("user")).toEqual(session.user);
    expect(c.get("session")).toEqual(session.session);
    expect(next.mock.calls.length).toBe(1);
  });

  it("no agent/user and no session → returns 401", async () => {
    getSession.mockResolvedValue(null);
    const c = createMockContext();
    const result = await protectRoute(c, next);
    expect(result as any).toEqual({
      body: { error: "Unauthorized", message: "Valid session or agent API key required" },
      status: 401,
    });
    expect(next.mock.calls.length).toBe(0);
  });
});

describe("requireAdmin", () => {
  beforeEach(() => {
    next.mockReset();
  });

  it("user with admin role → calls next()", async () => {
    const c = createMockContext({ user: { id: "user-1", role: "admin" } });
    await requireAdmin(c, next);
    expect(next.mock.calls.length).toBe(1);
  });

  it("agent with admin scope → calls next()", async () => {
    const c = createMockContext({ agent: { id: "agent-1", scopes: ["admin"] } });
    await requireAdmin(c, next);
    expect(next.mock.calls.length).toBe(1);
  });

  it("neither → returns 403", async () => {
    const c = createMockContext({ user: { id: "user-1", role: "user" } });
    const result = await requireAdmin(c, next);
    expect(result as any).toEqual({
      body: { error: "Forbidden", message: "Admin access required" },
      status: 403,
    });
    expect(next.mock.calls.length).toBe(0);
  });
});

describe("requireScope", () => {
  beforeEach(() => {
    next.mockReset();
  });

  it('agent with "read" scope → calls next()', async () => {
    const c = createMockContext({ agent: { id: "agent-1", scopes: ["read"] } });
    await requireScope("read")(c, next);
    expect(next.mock.calls.length).toBe(1);
  });

  it('agent with "admin" scope → calls next() even for "read" scope', async () => {
    const c = createMockContext({ agent: { id: "agent-1", scopes: ["admin"] } });
    await requireScope("read")(c, next);
    expect(next.mock.calls.length).toBe(1);
  });

  it("agent without scope → returns 403", async () => {
    const c = createMockContext({ agent: { id: "agent-1", scopes: ["write"] } });
    const result = await requireScope("read")(c, next);
    expect(result as any).toEqual({
      body: { error: "Forbidden", message: "Scope 'read' required", granted: ["write"] },
      status: 403,
    });
    expect(next.mock.calls.length).toBe(0);
  });

  it("no agent → returns 403", async () => {
    const c = createMockContext();
    const result = await requireScope("read")(c, next);
    expect(result as any).toEqual({
      body: { error: "Forbidden", message: "Agent authentication required" },
      status: 403,
    });
    expect(next.mock.calls.length).toBe(0);
  });
});
