/**
 * The request's transaction against REAL Postgres
 * ============================================================================
 *
 * The three risks of «one request = one transaction», with the API's `db`
 * (pg pool wrapped by `withLazyTransactions`) and the pieces of the
 * engine that the host mounts in front of each kon:
 *
 *   1. a `Promise.all` does not call `client.query()` while another is in progress (what
 *      pg 8 warns about as deprecated and pg 9 removes);
 *   2. a swallowed SQL error leaves the transaction aborted: the next thing
 *      fails with 25P02 and the write is lost (and it no longer responds 201); with
 *      `attemptSql` it goes in its savepoint and everything else is saved;
 *   3. a route that waits for something external BEFORE querying does not hold
 *      an «idle in transaction» connection.
 *
 * The version without Postgres (exact statement order): tests/unit/
 * rls-lazy-transaction.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import pg from "pg";

import {
  theRequestDb,
  attemptSql,
  rlsTransaction,
  type TransactionalConnection,
} from "../../../../packages/engine/src/rls-request";
import { db } from "../db";

import { isDatabaseAvailable } from "./setup";

const TABLE = "rtx_test_transaction";
let available = false;
const instance = theRequestDb(db);

/** SQLSTATE code of a Drizzle error (it wraps it in `cause`). */
function codeOf(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code;
}

const app = new Hono();
app.use("*", rlsTransaction(db as unknown as TransactionalConnection));
app.get("/parallel", async (c) => {
  const rows = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      instance.execute(sql`SELECT ${i}::int AS n, pg_sleep(0.005)`)
    )
  );
  return c.json({ n: rows.length });
});
app.post("/swallowed/:mark", async (c) => {
  const mark = c.req.param("mark");
  await instance.execute(sql.raw(`INSERT INTO ${TABLE} (mark) VALUES ('${mark}')`));
  try {
    await instance.execute(sql`SELECT * FROM rtx_table_that_does_not_exist`);
  } catch {
    // swallowed, as several routes did: «if it is not there, carry on»
  }
  const second = await instance.execute(sql`SELECT 1`).then(
    () => "fine",
    (e: unknown) => codeOf(e)
  );
  return c.json({ second }, 201);
});
app.post("/with-savepoint/:mark", async (c) => {
  const mark = c.req.param("mark");
  await instance.execute(sql.raw(`INSERT INTO ${TABLE} (mark) VALUES ('${mark}')`));
  const optional = await attemptSql(
    () => instance.execute(sql`SELECT * FROM rtx_table_that_does_not_exist`),
    null
  );
  const second = await instance.execute(sql`SELECT 1`).then(
    () => "fine",
    (e: unknown) => codeOf(e)
  );
  return c.json({ optional, second }, 201);
});
app.get("/waits-outside", async (c) => {
  // A slow external call BEFORE the first query.
  await new Promise((r) => setTimeout(r, 400));
  await instance.execute(sql`SELECT 1`);
  return c.json({ ok: true });
});

/** How many times `client.query()` was called with another query in progress on that client. */
let overlaps = 0;
const queryOriginal = pg.Client.prototype.query;

beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available) return;
  await db.execute(
    sql.raw(`CREATE TABLE IF NOT EXISTS ${TABLE} (id serial PRIMARY KEY, mark text NOT NULL)`)
  );
  await db.execute(sql.raw(`DELETE FROM ${TABLE}`));
  const active = new WeakMap<object, number>();
  pg.Client.prototype.query = function (this: object, ...args: unknown[]) {
    const n = active.get(this) ?? 0;
    if (n > 0) overlaps++;
    active.set(this, n + 1);
    const r = (queryOriginal as (...a: unknown[]) => unknown).apply(this, args);
    const fin = () => active.set(this, (active.get(this) ?? 1) - 1);
    if (r && typeof (r as Promise<unknown>).then === "function")
      (r as Promise<unknown>).then(fin, fin);
    else fin();
    return r;
  } as typeof queryOriginal;
});

afterAll(async () => {
  pg.Client.prototype.query = queryOriginal;
  if (available) await db.execute(sql.raw(`DROP TABLE IF EXISTS ${TABLE}`));
});

async function marks(): Promise<string[]> {
  const r = (await db.execute(sql.raw(`SELECT mark FROM ${TABLE} ORDER BY id`))) as unknown as {
    rows: { mark: string }[];
  };
  return r.rows.map((f) => f.mark);
}

describe("request transaction (real Postgres)", () => {
  it("1. Promise.all of 20 queries: no client.query() with another in progress", async () => {
    if (!available) return;
    overlaps = 0;
    const r = await app.request("/parallel");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ n: 20 });
    expect(overlaps).toBe(0);
  });

  it("2a. swallowed error WITHOUT savepoint: the next one gives 25P02, nothing is saved and it does not respond 201", async () => {
    if (!available) return;
    const r = await app.request("/swallowed/without", { method: "POST" });
    // The route saw the 25P02 and answered 201; Postgres turned the COMMIT into a
    // ROLLBACK and the middleware swaps it for a 500 instead of lying.
    expect(r.status).toBe(500);
    expect(await r.json()).toMatchObject({ code: "KITSUDEN_E_INTERNAL" });
    expect(await marks()).not.toContain("without");
  });

  it("2b. the same error WITH attemptSql: the next one goes fine and the write is saved", async () => {
    if (!available) return;
    const r = await app.request("/with-savepoint/with", { method: "POST" });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ optional: null, second: "fine" });
    expect(await marks()).toContain("with");
  });

  it("3. waiting outside before querying does not leave an «idle in transaction» connection", async () => {
    if (!available) return;
    const observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await observer.connect();
    try {
      const request = app.request("/waits-outside");
      await new Promise((r) => setTimeout(r, 150));
      const { rows } = await observer.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'"
      );
      expect(rows[0].n).toBe(0);
      expect((await request).status).toBe(200);
    } finally {
      await observer.end();
    }
  });
});
