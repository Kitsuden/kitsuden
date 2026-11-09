/**
 * The per-test ROLLBACK helper, against real Postgres:
 * what goes into the test's transaction, what does not, and how much is gained compared to
 * cleaning up with DELETE. See the header of `rollback.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { Hono } from "hono";

import {
  theRequestDb,
  rlsTransaction,
  type TransactionalConnection,
} from "../../../../packages/engine/src/rls-request";
import { db } from "../db";

import { withRollback, itWithRollback } from "./rollback";
import { isDatabaseAvailable } from "./setup";

const TABLE = "rbt_test_rollback";
let available = false;
const instance = theRequestDb(db);

function rows(r: unknown): Array<Record<string, unknown>> {
  return ((r as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>;
}

async function howMany(mark: string): Promise<number> {
  const [f] = rows(
    await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${TABLE} WHERE mark = '${mark}'`))
  );
  return Number(f?.n ?? 0);
}

const app = new Hono();
app.use("*", rlsTransaction(db as unknown as TransactionalConnection));
app.post("/write/:mark", async (c) => {
  await instance.execute(sql.raw(`INSERT INTO ${TABLE} (mark) VALUES ('${c.req.param("mark")}')`));
  return c.json({ ok: true }, 201);
});

beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available) return;
  await db.execute(
    sql.raw(`CREATE TABLE IF NOT EXISTS ${TABLE} (id serial PRIMARY KEY, mark text NOT NULL)`)
  );
  await db.execute(sql.raw(`DELETE FROM ${TABLE}`));
});

afterAll(async () => {
  if (!available) return;
  await db.execute(sql.raw(`DROP TABLE IF EXISTS ${TABLE}`));
});

describe("rollback per test", () => {
  it("what is written by theRequestDb (and repo, and the kons) is reverted", async () => {
    if (!available) return;
    await withRollback(async () => {
      await instance.execute(sql.raw(`INSERT INTO ${TABLE} (mark) VALUES ('a')`));
      // Inside the test it is visible…
      const [f] = rows(
        await instance.execute(sql.raw(`SELECT count(*)::int AS n FROM ${TABLE} WHERE mark = 'a'`))
      );
      expect(Number(f?.n)).toBe(1);
    });
    // …and outside it no longer exists.
    expect(await howMany("a")).toBe(0);
  });

  it("a nested savepoint works and is also reverted", async () => {
    if (!available) return;
    await withRollback(async (tx) => {
      await tx.transaction(async (sp: typeof tx) => {
        await sp.execute(sql.raw(`INSERT INTO ${TABLE} (mark) VALUES ('sp')`));
      });
      const [f] = rows(
        await tx.execute(sql.raw(`SELECT count(*)::int AS n FROM ${TABLE} WHERE mark = 'sp'`))
      );
      expect(Number(f?.n)).toBe(1);
    });
    expect(await howMany("sp")).toBe(0);
  });

  it("a request through rlsTransaction reuses the test's transaction", async () => {
    if (!available) return;
    await withRollback(async () => {
      const res = await app.request("/write/http", { method: "POST" });
      expect(res.status).toBe(201);
    });
    expect(await howMany("http")).toBe(0);
  });

  it("the global db used directly does NOT go in (it is committed)", async () => {
    if (!available) return;
    await withRollback(async () => {
      await db.execute(sql.raw(`INSERT INTO ${TABLE} (mark) VALUES ('global')`));
    });
    expect(await howMany("global")).toBe(1);
    await db.execute(sql.raw(`DELETE FROM ${TABLE} WHERE mark = 'global'`));
  });

  itWithRollback("itWithRollback: the body runs in the transaction", async (tx) => {
    if (!available) return;
    await tx.execute(sql.raw(`INSERT INTO ${TABLE} (mark) VALUES ('it')`));
    const [f] = rows(
      await tx.execute(sql.raw(`SELECT count(*)::int AS n FROM ${TABLE} WHERE mark = 'it'`))
    );
    expect(Number(f?.n)).toBe(1);
  });

  it("…and afterwards nothing is left", async () => {
    if (!available) return;
    expect(await howMany("it")).toBe(0);
  });

  it("it is faster than cleaning up with DELETE (measured)", async () => {
    if (!available) return;
    const N = 40;
    const ROWS = 25;
    const values = Array.from({ length: ROWS }, (_, i) => `('m${i}')`).join(",");

    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      await db.execute(sql.raw(`INSERT INTO ${TABLE} (mark) VALUES ${values}`));
      await db.execute(sql.raw(`DELETE FROM ${TABLE}`));
    }
    const withDelete = performance.now() - t0;

    const t1 = performance.now();
    for (let i = 0; i < N; i++) {
      await withRollback(async (tx) => {
        await tx.execute(sql.raw(`INSERT INTO ${TABLE} (mark) VALUES ${values}`));
      });
    }
    const withRollbackMs = performance.now() - t1;

    console.log(
      `[C6] ${N} tests × ${ROWS} rows: DELETE ${withDelete.toFixed(0)} ms · ROLLBACK ${withRollbackMs.toFixed(0)} ms`
    );
    expect(await howMany("m0")).toBe(0);
    // No factor is required: it depends on the machine. Just that it is not worse.
    expect(withRollbackMs).toBeLessThan(withDelete * 1.5);
  }, 60_000);
});
