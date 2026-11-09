import { describe, it, expect, mock, beforeAll, afterAll, beforeEach } from "bun:test";

const executed: { sql: any; params: any[] }[] = [];

function createTx(overrides: any = {}) {
  return {
    execute: mock(async (sql: any, ...params: any[]) => {
      executed.push({ sql, params });
      if (typeof overrides.execute === "function") {
        return overrides.execute(sql, ...params);
      }
      return { rows: [] };
    }),
  };
}

const db = {
  execute: mock(async (sql: any, ...params: any[]) => {
    executed.push({ sql, params });
    return { rows: [] };
  }),
  transaction: mock(async (fn: any) => {
    const tx = createTx();
    return fn(tx);
  }),
};

mock.module("drizzle-orm", () => ({
  // `sql` MUST keep `.raw` (mock.module is global in bun).
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => ({
      text: strings.reduce(
        (acc, s, i) => acc + s + (values[i] !== undefined ? `$${i + 1}` : ""),
        ""
      ),
      values,
    }),
    { raw: (s: string) => s }
  ),
}));

mock.module("../db", () => ({
  db,
  DatabaseTransaction: {},
}));

import {
  setRLSContext,
  clearRLSContext,
  getRLSContext,
  withTransactionalRLS,
  withRLSContext,
} from "../middleware/transactional-rls";

afterAll(() => {
  mock.restore();
});

beforeAll(() => {
  executed.length = 0;
});

function makeContext(user?: any) {
  const store = new Map<string, any>();
  if (user) store.set("user", user);
  return {
    get: (k: string) => store.get(k),
    set: (k: string, v: any) => store.set(k, v),
  } as any;
}

const next = mock(async () => {});

describe("transactional-rls", () => {
  beforeEach(() => {
    executed.length = 0;
    db.execute.mockClear?.();
    db.transaction.mockClear?.();
    next.mockClear?.();
  });

  it("setRLSContext injects user_id and role", async () => {
    const tx = createTx();
    await setRLSContext(tx as any, { id: "u1", role: "admin" });
    // A single round trip: both `set_config` calls in the same statement.
    expect(executed.length).toBe(1);
    expect(executed[0].sql.text).toContain("set_config");
    expect(executed[0].sql.values).toContain("u1");
    expect(executed[0].sql.values).toContain("admin");
  });

  /**
   * The third argument of `set_config` is `is_local`. With `false` the value
   * stays in the SESSION, and here sessions are pool connections: the next
   * request that reuses that connection and does not set a context inherits the
   * previous user. Nothing fails; you simply see what you should not.
   */
  it("the context is LOCAL to the transaction, not the session", async () => {
    const tx = createTx();
    await setRLSContext(tx as any, { id: "u1", role: "admin" });
    for (const q of executed) expect(q.sql.text).toContain("true)");
    executed.length = 0;
    await clearRLSContext(tx as any);
    for (const q of executed) expect(q.sql.text).toContain("true)");
  });

  it("setRLSContext defaults to anonymous", async () => {
    const tx = createTx();
    await setRLSContext(tx as any, null);
    expect(executed[0].sql.values).toContain("");
    expect(executed[0].sql.values).toContain("anonymous");
  });

  it("setRLSContext: an account without a role is `user`, not `anonymous`", async () => {
    const tx = createTx();
    await setRLSContext(tx as any, { id: "u3" } as any);
    expect(executed[0].sql.values).toContain("u3");
    expect(executed[0].sql.values).toContain("user");
  });

  it("clearRLSContext resets session variables", async () => {
    const tx = createTx();
    await clearRLSContext(tx as any);
    expect(executed.length).toBe(2);
    expect(executed[0].sql.text).toContain("app.current_user_id");
    expect(executed[1].sql.text).toContain("app.current_user_role");
  });

  it("getRLSContext reads current settings and detects admin", async () => {
    const tx = createTx({
      execute: async (sql: any) => {
        const setting = sql.text.includes("user_id") ? "u2" : "admin";
        return { rows: [{ current_setting: setting }] };
      },
    });
    const ctx = await getRLSContext(tx as any);
    expect(ctx.userId).toBe("u2");
    expect(ctx.userRole).toBe("admin");
    expect(ctx.isAdmin).toBe(true);
  });

  it("withTransactionalRLS runs next inside a transaction", async () => {
    const c = makeContext({ id: "u3", role: "user" });
    await withTransactionalRLS()(c, next);
    expect(db.transaction.mock.calls.length).toBe(1);
    expect(next.mock.calls.length).toBe(1);
    expect(c.get("rlsUser")).toEqual({ id: "u3", role: "user" });
  });

  it("withTransactionalRLS handles anonymous users", async () => {
    const c = makeContext();
    await withTransactionalRLS()(c, next);
    expect(c.get("rlsUser")).toEqual({ id: null, role: "anonymous" });
  });

  it("withRLSContext helper runs function in a transaction", async () => {
    const fn = mock(async (tx: any) => "result");
    const result = await withRLSContext({ id: "u5", role: "user" }, fn);
    expect(result).toBe("result");
    expect(db.transaction.mock.calls.length).toBe(1);
    expect(fn.mock.calls.length).toBe(1);
  });
});
