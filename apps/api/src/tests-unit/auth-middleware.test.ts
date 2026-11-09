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

import { requireAuth, requireRole, optionalAuth } from "../middleware/auth";

afterAll(() => {
  mock.restore();
});

function createMockContext() {
  const vars = new Map<string, any>();
  return {
    get: (k: string) => vars.get(k),
    set: (k: string, v: any) => vars.set(k, v),
    req: { raw: { headers: new Headers() } },
    json: (body: any, status?: number) => Promise.resolve({ body, status }),
  } as any;
}

const next = createMockFn(() => Promise.resolve());

describe("requireAuth", () => {
  beforeEach(() => {
    getSession.mockReset();
    next.mockReset();
  });

  it("returns 401 when no session", async () => {
    getSession.mockResolvedValue(null);
    const c = createMockContext();
    const result = await requireAuth(c, next);
    expect(result as any).toEqual({
      body: { error: "Unauthorized - Authentication required" },
      status: 401,
    });
    expect(next.mock.calls.length).toBe(0);
  });

  it("injects user/session and calls next when session exists", async () => {
    const session = { user: { id: "u1", role: "admin" }, session: { id: "s1" } };
    getSession.mockResolvedValue(session);
    const c = createMockContext();
    await requireAuth(c, next);
    expect(c.get("user")).toEqual(session.user);
    expect(c.get("session")).toEqual(session.session);
    expect(next.mock.calls.length).toBe(1);
  });
});

describe("requireRole", () => {
  beforeEach(() => {
    getSession.mockReset();
    next.mockReset();
  });

  it("returns 401 when no session", async () => {
    getSession.mockResolvedValue(null);
    const c = createMockContext();
    const result = await requireRole(["admin"])(c, next);
    expect(result as any).toEqual({
      body: { error: "Unauthorized - Authentication required" },
      status: 401,
    });
  });

  it("returns 403 when role not allowed", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", role: "user" }, session: { id: "s1" } });
    const c = createMockContext();
    const result = await requireRole(["admin"])(c, next);
    expect(result as any).toEqual({
      body: { error: "Forbidden - Insufficient permissions", required: ["admin"], current: "user" },
      status: 403,
    });
  });

  it("calls next when role is allowed", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", role: "admin" }, session: { id: "s1" } });
    const c = createMockContext();
    await requireRole(["admin", "editor"])(c, next);
    expect(next.mock.calls.length).toBe(1);
  });
});

describe("optionalAuth", () => {
  beforeEach(() => {
    getSession.mockReset();
    next.mockReset();
  });

  it("sets user/session when available", async () => {
    const session = { user: { id: "u1" }, session: { id: "s1" } };
    getSession.mockResolvedValue(session);
    const c = createMockContext();
    await optionalAuth(c, next);
    expect(c.get("user")).toEqual(session.user);
    expect(next.mock.calls.length).toBe(1);
  });

  it("calls next even without session", async () => {
    getSession.mockResolvedValue(null);
    const c = createMockContext();
    await optionalAuth(c, next);
    expect(c.get("user")).toBeUndefined();
    expect(next.mock.calls.length).toBe(1);
  });
});
