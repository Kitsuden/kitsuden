/**
 * The «glass box» against real Postgres
 * ============================================================================
 *   · Each request's trace carries its transaction's measurements
 *     (queries, time in the database, rows written).
 *   · A write by id that touches nothing is logged as a block, and
 *     «not yours» is distinguished from «does not exist»… but the asker gets the
 *     SAME 404 in both cases (there is no existence oracle).
 *   · Traces are written in batches into per-day partitions, and are listed and
 *     summarized by the panel's functions.
 *   · The OTLP span (G2) goes out with the request's W3C trace_id.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { Hono } from "hono";

import { repo } from "../../../../packages/engine/src/repository";
import { runInRequestScope } from "../../../../packages/engine/src/request-scope";
import {
  rlsTransaction,
  type TransactionalConnection,
} from "../../../../packages/engine/src/rls-request";
import { db } from "../db";
import { spanOf } from "../lib/otlp";
import {
  listTraces,
  traceSummary,
  rotate,
  isSaved,
  requestTraces,
  dump,
  type Trace,
} from "../lib/traces";

import { isDatabaseAvailable } from "./setup";

const notes = pgTable("cct_test_notes", {
  id: uuid("id").primaryKey(),
  owner: text("owner").notNull(),
  title: text("title").notNull(),
});

const FOREIGN_ID = "11111111-1111-4111-8111-111111111111";
const NONEXISTENT_ID = "22222222-2222-4222-8222-222222222222";
// Unique per run: the traces of other runs are still in the database.
const ME_1 = `u-cct-1-${crypto.randomUUID().slice(0, 8)}`;
const ME_2 = `u-cct-2-${crypto.randomUUID().slice(0, 8)}`;
let available = false;

const app = new Hono();
app.use("*", async (c, next) => {
  const id = c.req.header("x-user") ?? null;
  c.set("user" as never, (id ? { id, role: "user" } : null) as never);
  c.set("requestId" as never, `cct-${crypto.randomUUID()}` as never);
  await runInRequestScope({ requestId: "cct", traceId: "0af7651916cd43dd8448eb211c80319c" }, () =>
    next()
  );
});
app.use("*", requestTraces());
app.use("*", rlsTransaction(db as unknown as TransactionalConnection));
app.patch("/notes/:id", async (c) => {
  const me = c.req.header("x-user") ?? "";
  // The handler's owner filter: the first wall.
  const rows = await repo(notes)
    .filter({ id: c.req.param("id"), owner: me })
    .update({ title: "new" });
  return rows.length ? c.json(rows[0]) : c.json({ error: "Not found" }, 404);
});
app.post("/notes", async (c) => {
  const me = c.req.header("x-user") ?? "";
  const note = await repo(notes).create({ id: crypto.randomUUID(), owner: me, title: "hello" });
  return c.json(note, 201);
});

beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available) return;
  process.env.TRACES_ENABLED = "true";
  process.env.TRACES_READ_SAMPLING = "1";
  await db.execute(
    sql.raw(
      `CREATE TABLE IF NOT EXISTS cct_test_notes (id uuid PRIMARY KEY, owner text NOT NULL, title text NOT NULL)`
    )
  );
  await db.execute(sql.raw(`DELETE FROM cct_test_notes`));
  await db.execute(
    sql`INSERT INTO cct_test_notes (id, owner, title) VALUES (${FOREIGN_ID}::uuid, 'someone-else', 'foreign')`
  );
  await rotate();
});

afterAll(async () => {
  if (!available) return;
  await db.execute(sql.raw(`DROP TABLE IF EXISTS cct_test_notes`));
  delete process.env.TRACES_ENABLED;
  delete process.env.TRACES_READ_SAMPLING;
});

async function tracesOf(actor: string) {
  await dump();
  return listTraces({
    from: new Date(Date.now() - 600_000),
    limit: 50,
    onlyBlockers: false,
    onlyErrors: false,
    actor,
  });
}

describe("glass box", () => {
  it("a write stores its trace with the transaction's measurements", async () => {
    if (!available) return;
    const res = await app.request("/notes", { method: "POST", headers: { "x-user": ME_1 } });
    expect(res.status).toBe(201);
    const [t] = await tracesOf(ME_1);
    expect(t).toBeDefined();
    expect(t?.method).toBe("POST");
    expect(t?.route).toBe("/notes");
    expect(t?.actor_type).toBe("human");
    expect(Number(t?.queries)).toBeGreaterThan(0);
    expect(Number(t?.rows_affected)).toBe(1);
    expect(t?.trace_id).toBe("0af7651916cd43dd8448eb211c80319c");
  });

  it("not yours and does not exist give the SAME 404, but the trace tells them apart", async () => {
    if (!available) return;
    const foreign = await app.request(`/notes/${FOREIGN_ID}`, {
      method: "PATCH",
      headers: { "x-user": ME_2 },
    });
    const nothing = await app.request(`/notes/${NONEXISTENT_ID}`, {
      method: "PATCH",
      headers: { "x-user": ME_2 },
    });
    expect(foreign.status).toBe(404);
    expect(nothing.status).toBe(404);
    expect(await foreign.text()).toBe(await nothing.text());

    const traces = await tracesOf(ME_2);
    const reasons = traces
      .map((t) => (t.denial_details as Array<{ reason: string }>)[0]?.reason)
      .sort();
    expect(reasons).toEqual(["not_found", "not_yours"]);
    expect(traces.every((t) => Number(t.denials) === 1 && t.route === "/notes/:id")).toBe(true);
    // The other person's note remains intact.
    const [f] = (
      await db.execute(sql`SELECT title FROM cct_test_notes WHERE id = ${FOREIGN_ID}::uuid`)
    ).rows as Array<{ title: string }>;
    expect(f?.title).toBe("foreign");
  });

  it("the summary groups by route with blocks and errors", async () => {
    if (!available) return;
    const summary = await traceSummary(new Date(Date.now() - 600_000));
    const patch = summary.find((r) => r.method === "PATCH" && r.route === "/notes/:id");
    expect(Number(patch?.denials)).toBeGreaterThanOrEqual(2);
  });

  it("sampling: writes, errors and blocks always; reads according to the rate", () => {
    process.env.TRACES_READ_SAMPLING = "0.1";
    expect(isSaved("POST", 201, 0, 0.99)).toBe(true);
    expect(isSaved("GET", 404, 0, 0.99)).toBe(true);
    expect(isSaved("GET", 200, 1, 0.99)).toBe(true);
    expect(isSaved("GET", 200, 0, 0.99)).toBe(false);
    expect(isSaved("GET", 200, 0, 0.05)).toBe(true);
    process.env.TRACES_READ_SAMPLING = "1";
  });

  it("rotating creates today's partition and the next two days'", async () => {
    if (!available) return;
    await rotate();
    const r = await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'kitsuden_request_traces'`);
    expect(Number((r.rows[0] as { n: number }).n)).toBeGreaterThanOrEqual(3);
  });
});

describe("OTLP (G2)", () => {
  it("a span carries the W3C trace_id, the route and the box's attributes", () => {
    const t: Trace = {
      createdAt: new Date("2026-10-28T12:00:00.000Z"),
      requestId: "r1",
      traceId: "0af7651916cd43dd8448eb211c80319c",
      method: "PATCH",
      route: "/notes/:id",
      status: 404,
      actorType: "agent",
      actorId: "agent-1",
      kon: "kon-blog",
      operation: "update-note",
      durationMs: 12,
      dbTimeMs: 5,
      queries: 3,
      affectedRows: 0,
      denials: 1,
      lockDetails: null,
    };
    const span = spanOf(t) as {
      traceId: string;
      name: string;
      attributes: Array<{ key: string }>;
      endTimeUnixNano: string;
      startTimeUnixNano: string;
    };
    expect(span.traceId).toBe(t.traceId as string);
    expect(span.name).toBe("PATCH /notes/:id");
    expect(span.attributes.map((a) => a.key)).toContain("kitsuden.blocked");
    expect(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)).toBe(12_000_000n);
  });
});
