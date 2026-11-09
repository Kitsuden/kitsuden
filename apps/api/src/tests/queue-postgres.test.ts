/**
 * The Postgres queue (transactional outbox) against REAL Postgres
 * ============================================================================
 * What it has to satisfy:
 *
 *   1. Atomicity: a job dispatched in a request that ends in
 *      ROLLBACK does not exist; if it commits, it is ready and the worker runs it.
 *   2. Retries with backoff and «dead letter»; `PermanentError` dies
 *      immediately; retrying from the panel puts it back in motion.
 *   3. Orphans: a `running` job with an expired lease goes back to the queue (or
 *      dies if it has used up its attempts).
 *   4. The actor is re-read: an account that no longer exists = it does not run.
 *   5. The handler runs with the actor's RLS (`app.current_user_id`).
 *   6. Permissions: the application role only INSERTS; the rest goes through the
 *      SECURITY DEFINER functions.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { Hono } from "hono";

import { PermanentError, queue } from "../../../../packages/engine/src/queue";
import { runInRequestScope } from "../../../../packages/engine/src/request-scope";
import {
  theRequestDb,
  rlsTransaction,
  type TransactionalConnection,
} from "../../../../packages/engine/src/rls-request";
import { db } from "../db";
import {
  sweepNow,
  pauseWorker,
  processPending,
  retryJob,
  setRereadActor,
  setupWorkers,
  shutdownQueues,
  deadJobs,
} from "../lib/queue";

import { isDatabaseAvailable } from "./setup";

const QUEUE = "test-queue";
let available = false;
const executed: Array<{ name: string; payload: unknown; user: unknown; rls: unknown }> = [];
const instance = theRequestDb(db);
let failUntil = 0;

function rows(r: unknown): Array<Record<string, unknown>> {
  return ((r as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>;
}

async function statusOf(id: string): Promise<Record<string, unknown> | undefined> {
  return rows(await db.execute(sql`SELECT * FROM kitsuden_outbox WHERE id = ${id}::uuid`))[0];
}

/** An app with each request's RLS transaction, like the host. */
const app = new Hono();
app.use("*", async (c, next) => {
  const id = c.req.header("x-user");
  c.set("user" as never, (id ? { id, role: "user" } : null) as never);
  await runInRequestScope({ requestId: `req-${Date.now()}` }, () => next());
});
app.use("*", rlsTransaction(db as unknown as TransactionalConnection));
app.post("/commits", async (c) => {
  const r = await queue.dispatch(QUEUE, "ok", { n: 1 });
  return c.json(r, 201);
});
app.post("/rolls-back", async (c) => {
  const r = await queue.dispatch(QUEUE, "ok", { n: 2 });
  return c.json(r, 500);
});

beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available) return;
  queue.handle(QUEUE, async (job) => {
    // With `theRequestDb`, the job's transaction: the actor's RLS.
    const [ctx] = rows(
      await instance.execute(sql`SELECT current_setting('app.current_user_id', true) AS uid`)
    );
    if (job.name === "fails" && job.attempt <= failUntil) throw new Error("failure on purpose");
    if (job.name === "permanent") throw new PermanentError("it has no fix");
    executed.push({
      name: job.name,
      payload: job.payload,
      user: job.actor?.id ?? null,
      rls: ctx?.uid ?? null,
    });
  });
  // No automatic wake-ups: the tests drive it with processPending().
  await setupWorkers();
  pauseWorker(true);
});

beforeEach(async () => {
  if (!available) return;
  executed.length = 0;
  failUntil = 0;
  setRereadActor(null);
  await db.execute(sql`DELETE FROM kitsuden_outbox WHERE queue = ${QUEUE}`);
});

afterAll(async () => {
  if (!available) return;
  await db.execute(sql`DELETE FROM kitsuden_outbox WHERE queue = ${QUEUE}`);
  await shutdownQueues();
});

describe("Postgres queue: atomicity with the request", () => {
  it("ROLLBACK: the job of a request that ends in 500 does not exist", async () => {
    if (!available) return;
    const res = await app.request("/rolls-back", { method: "POST" });
    expect(res.status).toBe(500);
    const { id } = (await res.json()) as { id: string };
    expect(await statusOf(id)).toBeUndefined();
  });

  it("COMMIT: the job stays pending and the worker runs it once", async () => {
    if (!available) return;
    const res = await app.request("/commits", { method: "POST" });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect((await statusOf(id))?.status).toBe("pending");
    await processPending();
    expect((await statusOf(id))?.status).toBe("done");
    expect(executed).toHaveLength(1);
    await processPending();
    expect(executed).toHaveLength(1);
  });

  it("stores the request's actor and re-reads it on execution", async () => {
    if (!available) return;
    const seen: string[] = [];
    setRereadActor(async (row) => {
      seen.push(String(row.user_id));
      return { ok: true, actor: { id: String(row.user_id), role: "user" } };
    });
    const res = await app.request("/commits", {
      method: "POST",
      headers: { "x-user": "u-queue-1" },
    });
    const { id } = (await res.json()) as { id: string };
    expect((await statusOf(id))?.user_id).toBe("u-queue-1");
    await processPending();
    expect(seen).toEqual(["u-queue-1"]);
    expect(executed[0]?.user).toBe("u-queue-1");
    // And the handler's transaction carries its RLS context.
    expect(executed[0]?.rls).toBe("u-queue-1");
  });
});

describe("Postgres queue: failures", () => {
  it("keeps the reason a job was queued for, and the dead letter shows it", async () => {
    if (!available) return;
    failUntil = 99;
    const reason = "follow up the contact";
    const { id } = await queue.dispatch(QUEUE, "fails", {}, { attempts: 1, reason });
    expect((await statusOf(id))?.reason).toBe(reason);
    await processPending();
    const dead = await deadJobs(50);
    expect(dead.find((j) => j.id === id)?.reason).toBe(reason);
  });

  it("retries with backoff and, once attempts are exhausted, ends up in the dead letter", async () => {
    if (!available) return;
    failUntil = 99;
    const { id } = await queue.dispatch(QUEUE, "fails", {}, { attempts: 2 });
    await processPending();
    let row = await statusOf(id);
    expect(row?.status).toBe("pending");
    expect(Number(row?.attempts)).toBe(1);
    expect(String(row?.last_error)).toContain("failure on purpose");
    // The retry backoff puts it in the future: it is moved forward for the test.
    await db.execute(sql`UPDATE kitsuden_outbox SET run_at = now() WHERE id = ${id}::uuid`);
    await processPending();
    row = await statusOf(id);
    expect(row?.status).toBe("dead");
    expect((await deadJobs()).some((m) => m.id === id)).toBe(true);
  });

  it("PermanentError: dead on the first attempt", async () => {
    if (!available) return;
    const { id } = await queue.dispatch(QUEUE, "permanent", {});
    await processPending();
    const row = await statusOf(id);
    expect(row?.status).toBe("dead");
    expect(Number(row?.attempts)).toBe(1);
  });

  it("retrying from the panel runs it again", async () => {
    if (!available) return;
    failUntil = 1;
    const { id } = await queue.dispatch(QUEUE, "fails", {}, { attempts: 1 });
    await processPending();
    expect((await statusOf(id))?.status).toBe("dead");
    expect(await retryJob(id)).toBe(true);
    failUntil = 0;
    await processPending();
    expect((await statusOf(id))?.status).toBe("done");
  });

  it("revoked actor: the job dies without running", async () => {
    if (!available) return;
    await db.execute(sql`
      INSERT INTO kitsuden_outbox (id, queue, name, payload, user_id, user_role)
      VALUES (gen_random_uuid(), ${QUEUE}, 'ok', '{}'::jsonb, 'account-that-does-not-exist', 'user')`);
    await processPending();
    const [row] = rows(await db.execute(sql`SELECT * FROM kitsuden_outbox WHERE queue = ${QUEUE}`));
    expect(row?.status).toBe("dead");
    expect(String(row?.last_error)).toContain("actor_revoked");
    expect(executed).toHaveLength(0);
  });
});

describe("Postgres queue: orphans", () => {
  it("a running job with an expired lease goes back to pending; with no attempts left, to dead", async () => {
    if (!available) return;
    const alive = await queue.dispatch(QUEUE, "ok", {}, { attempts: 3 });
    const exhausted = await queue.dispatch(QUEUE, "ok", {}, { attempts: 1 });
    await db.execute(sql`
      UPDATE kitsuden_outbox
         SET status = 'running', attempts = 1, locked_by = 'dead-worker',
             locked_until = now() - interval '1 minute'
       WHERE id IN (${alive.id}::uuid, ${exhausted.id}::uuid)`);
    await sweepNow();
    expect((await statusOf(alive.id))?.status).toBe("pending");
    expect((await statusOf(exhausted.id))?.status).toBe("dead");
    await processPending();
    expect((await statusOf(alive.id))?.status).toBe("done");
  });

  it("two claims at once do not take the same job (SKIP LOCKED)", async () => {
    if (!available) return;
    for (let i = 0; i < 6; i++) await queue.dispatch(QUEUE, "ok", { i });
    const claim = (w: string) =>
      db.execute(sql`SELECT id FROM kitsuden_queue_claim(ARRAY[${QUEUE}]::text[], 4, 60, ${w})`);
    const [a, b] = await Promise.all([claim("w-a"), claim("w-b")]);
    const ids = [...rows(a), ...rows(b)].map((f) => f.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });
});

describe("Postgres queue: permissions of the application role", () => {
  const ROLE = "kitsuden_queue_probe";

  beforeAll(async () => {
    if (!available) return;
    await db.execute(
      sql.raw(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE ${ROLE} NOLOGIN; END IF;
    END $$`)
    );
    await db.execute(sql.raw(`GRANT INSERT ON kitsuden_outbox TO ${ROLE}`));
    await db.execute(sql.raw(`GRANT EXECUTE ON FUNCTION kitsuden_queue_status() TO ${ROLE}`));
  });

  it("can insert and call the functions, but cannot read or touch the table", async () => {
    if (!available) return;
    const r = await db
      .transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE ${ROLE}`));
        await tx.execute(
          sql`INSERT INTO kitsuden_outbox (id, queue, name) VALUES (gen_random_uuid(), ${QUEUE}, 'role')`
        );
        const status = await tx.execute(sql`SELECT * FROM kitsuden_queue_status()`);
        const read = await tx.execute(sql`SELECT payload FROM kitsuden_outbox LIMIT 1`).then(
          () => "read-it",
          (e: unknown) => String((e as { cause?: { code?: string } }).cause?.code ?? e)
        );
        return { status: rows(status).length > 0, read };
      })
      .catch((e: unknown) => ({ error: String(e) }));
    expect(r).toMatchObject({ status: true });
    expect((r as { read?: string }).read).toContain("42501");
  });
});

describe("Postgres queue: NOTIFY on commit", () => {
  it("the worker wakes up on the COMMIT's NOTIFY, without waiting for polling", async () => {
    if (!available) return;
    pauseWorker(false);
    try {
      const res = await app.request("/commits", { method: "POST" });
      const { id } = (await res.json()) as { id: string };
      let status: unknown;
      for (let i = 0; i < 30; i++) {
        status = (await statusOf(id))?.status;
        if (status === "done") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(status).toBe("done");
    } finally {
      pauseWorker(true);
    }
  });
});
