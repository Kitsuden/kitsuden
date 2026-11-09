/**
 * The request's RLS transaction with the pg pool: lazy, queued and
 * with no COMMIT that lies (the three risks of A2)
 * ============================================================================
 *
 * Without Postgres: a real `pg.Pool` (Drizzle decides from it that it is a pool)
 * whose `connect` returns a fake client that records each statement,
 * how many run at once and when it is returned. That way the exact ORDER of
 * what reaches the driver is visible, which is what matters here:
 *
 *   · a route that does not query does not request a connection (nor BEGIN);
 *   · a `Promise.all` reaches the driver one at a time;
 *   · a SAVEPOINT and `asSystem` do not mix with what runs in parallel;
 *   · a COMMIT that Postgres turns into a ROLLBACK does not come out as success;
 *   · a late query (outside `background`) fails clearly, it does not go to another
 *     connection.
 *
 * With real Postgres: apps/api/src/tests/request-transaction.test.ts.
 */

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asSystem,
  withLazyTransactions,
  theRequestDb,
  attemptSql,
  rlsTransaction,
  type LostConfirmation,
} from "../../packages/engine/src/rls-request";

interface Statement {
  text: string;
  values: unknown[];
}

let statements: Statement[];
let connections: number;
let refunds: unknown[];
let atOnce: number;
let maxAtOnce: number;
let commitResponse: string;
let failConnection: Error | null;
let lost: LostConfirmation[];

function fakeClient() {
  connections++;
  return {
    async query(config: unknown, values?: unknown[]) {
      const text = String(
        typeof config === "string" ? config : (config as { text: string }).text
      ).trim();
      atOnce++;
      maxAtOnce = Math.max(maxAtOnce, atOnce);
      try {
        statements.push({ text, values: values ?? [] });
        // A real breather: if two queries could overlap, here they would.
        await new Promise((r) => setTimeout(r, 2));
        if (text.startsWith("select failing")) {
          throw Object.assign(new Error('relation "not_found" does not exist'), {
            code: "42P01",
          });
        }
        const command = text === "commit" ? commitResponse : text.split(" ")[0].toUpperCase();
        return { command, rowCount: 0, rows: [], fields: [] };
      } finally {
        atOnce--;
      }
    },
    release(err?: unknown) {
      refunds.push(err);
    },
  };
}

const pool = new pg.Pool({ connectionString: "postgres://nobody@127.0.0.1:1/none" });
(pool as unknown as { connect: () => Promise<unknown> }).connect = async () => {
  if (failConnection) throw failConnection;
  return fakeClient();
};
withLazyTransactions(pool);
const db = drizzle(pool);
const instance = theRequestDb(db);

const texts = () => statements.map((s) => s.text);
const isContext = (s: Statement) => s.text.startsWith("SELECT set_config");

let late: Promise<unknown> | null = null;

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("user" as never, { id: "ana", role: "user" } as never);
  await next();
});
app.use(
  "*",
  rlsTransaction(db, {
    onLosingConfirmation: (_c, info) => lost.push(info),
  })
);
app.get("/nothing", (c) => c.json({ ok: true }));
app.get("/one", async (c) => {
  await instance.execute(sql`select 1`);
  return c.json({ ok: true });
});
app.get("/parallel", async (c) => {
  const r = await Promise.all(
    Array.from({ length: 8 }, (_, i) => instance.execute(sql`select ${i}`))
  );
  return c.json({ n: r.length });
});
app.get("/savepoint-in-parallel", async (c) => {
  await Promise.all([
    instance.transaction(async (t) => {
      await t.execute(sql`select 'inside-1'`);
      await t.execute(sql`select 'inside-2'`);
    }),
    instance.execute(sql`select 'outside'`),
    instance.execute(sql`select 'outside-2'`),
  ]);
  return c.json({ ok: true });
});
app.get("/system-in-parallel", async (c) => {
  await Promise.all([
    asSystem(async () => {
      await instance.execute(sql`select 'system-1'`);
      await instance.execute(sql`select 'system-2'`);
    }),
    instance.execute(sql`select 'user'`),
  ]);
  return c.json({ ok: true });
});
app.on(["GET", "POST"], "/swallowed", async (c) => {
  await instance.execute(sql`insert 'something'`);
  try {
    await instance.execute(sql`select failing`);
  } catch {
    // swallowed: the transaction is left aborted
  }
  return c.json({ ok: true }, 201);
});
app.post("/swallowed-with-savepoint", async (c) => {
  await instance.execute(sql`insert 'something'`);
  const r = await attemptSql<unknown>(() => instance.execute(sql`select failing`), "by-default");
  await instance.execute(sql`select 'after'`);
  return c.json({ r }, 201);
});
app.get("/fails-without-querying", (c) => c.json({ error: "x" }, 500));
app.get("/fails-after-querying", async (c) => {
  await instance.execute(sql`insert 'something'`);
  return c.json({ error: "x" }, 500);
});
app.get("/late", async (c) => {
  await instance.execute(sql`select 1`);
  // It is taken INSIDE the request (it resolves to its transaction) and used afterwards
  // after responding, without background: the classic `void task()` mistake.
  const runLater = instance.execute;
  late = new Promise((r) => setTimeout(r, 30)).then(() => runLater(sql`select 'late'`));
  return c.json({ ok: true });
});

beforeEach(() => {
  statements = [];
  connections = 0;
  refunds = [];
  atOnce = 0;
  maxAtOnce = 0;
  commitResponse = "COMMIT";
  failConnection = null;
  lost = [];
  late = null;
});

describe("lazy: without queries there is no connection", () => {
  it("a route that does not touch the database requests no connection and sends no BEGIN", async () => {
    const r = await app.request("/nothing");
    expect(r.status).toBe(200);
    expect(connections).toBe(0);
    expect(statements).toEqual([]);
  });

  it("the first query opens: BEGIN, context, the query and COMMIT; one release", async () => {
    const r = await app.request("/one");
    expect(r.status).toBe(200);
    expect(connections).toBe(1);
    expect(texts()[0]).toBe("begin");
    expect(isContext(statements[1])).toBe(true);
    expect(statements[1].values).toEqual(["ana", "user"]);
    expect(texts().slice(2)).toEqual(["select 1", "commit"]);
    expect(refunds).toEqual([undefined]);
  });

  it("if the pool gives no connection, the query fails (not the middleware)", async () => {
    failConnection = new Error("timeout exceeded when trying to connect");
    const r = await app.request("/one");
    expect(r.status).toBe(500);
    expect(refunds).toEqual([]);
  });

  it("a 5xx without queries opens nothing; with queries, ROLLBACK", async () => {
    expect((await app.request("/fails-without-querying")).status).toBe(500);
    expect(connections).toBe(0);
    expect((await app.request("/fails-after-querying")).status).toBe(500);
    expect(texts().at(-1)).toBe("rollback");
  });
});

describe("queued: one query at a time", () => {
  it("a Promise.all of 8 queries reaches the driver one at a time", async () => {
    const r = await app.request("/parallel");
    expect(await r.json()).toEqual({ n: 8 });
    expect(maxAtOnce).toBe(1);
    expect(texts().filter((t) => t === "select $1")).toHaveLength(8);
  });

  it("a parallel SAVEPOINT lets nothing slip in between its opening and its closing", async () => {
    await app.request("/savepoint-in-parallel");
    const t = texts();
    const opens = t.indexOf("savepoint sp1");
    const closes = t.indexOf("release savepoint sp1");
    expect(opens).toBeGreaterThan(-1);
    expect(t.slice(opens, closes + 1)).toEqual([
      "savepoint sp1",
      "select 'inside-1'",
      "select 'inside-2'",
      "release savepoint sp1",
    ]);
    expect(t).toContain("select 'outside'");
    expect(maxAtOnce).toBe(1);
  });

  it("parallel asSystem: what is outside does NOT run as the system", async () => {
    await app.request("/system-in-parallel");
    const s = statements.filter((x) => x.text !== "begin" && x.text !== "commit");
    // Context in force on each query, rebuilt in order.
    let current: unknown[] = [];
    const views: Record<string, unknown[]> = {};
    for (const x of s) {
      if (isContext(x)) current = x.values;
      else views[x.text] = current;
    }
    expect(views["select 'system-1'"]).toEqual(["", ""]);
    expect(views["select 'system-2'"]).toEqual(["", ""]);
    expect(views["select 'user'"]).toEqual(["ana", "user"]);
  });
});

describe("swallowed errors: the COMMIT that Postgres turns into a ROLLBACK", () => {
  it("a write that answered 201 comes out as 500, and a warning is raised", async () => {
    commitResponse = "ROLLBACK";
    const r = await app.request("/swallowed", { method: "POST" });
    expect(r.status).toBe(500);
    expect((await r.json()).code).toBe("KITSUDEN_E_INTERNAL");
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({
      method: "POST",
      changedResponse: true,
      error: { code: "42P01" },
    });
  });

  it("a read does not change its response, but a warning is raised all the same", async () => {
    commitResponse = "ROLLBACK";
    const r = await app.request("/swallowed");
    expect(r.status).toBe(201);
    expect(lost[0]).toMatchObject({ method: "GET", changedResponse: false });
  });

  it("attemptSql: the failure goes in its SAVEPOINT and what comes after continues", async () => {
    const r = await app.request("/swallowed-with-savepoint", { method: "POST" });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ r: "by-default" });
    const t = texts();
    expect(t.slice(t.indexOf("savepoint sp1"), t.indexOf("savepoint sp1") + 3)).toEqual([
      "savepoint sp1",
      "select failing",
      "rollback to savepoint sp1",
    ]);
    expect(t.at(-2)).toBe("select 'after'");
    expect(lost).toEqual([]);
  });
});

describe("after responding", () => {
  it("a late query with the request's db goes to no borrowed connection", async () => {
    await app.request("/late");
    const before = statements.length;
    const error = (await late!.then(
      () => null,
      (e: unknown) => e
    )) as { message?: string; cause?: { message?: string } } | null;
    // Drizzle wraps it («Failed query…»); the reason is in `cause`.
    expect(error?.cause?.message ?? error?.message).toMatch(/background/);
    expect(statements.slice(before).map((s) => s.text)).not.toContain("select 'late'");
    expect(refunds).toHaveLength(1);
  });
});
