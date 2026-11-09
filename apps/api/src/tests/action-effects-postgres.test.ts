/**
 * `ctx.effect()` against REAL Postgres
 * ============================================================================
 * What it has to satisfy:
 *
 *   1. A queue action that sends and then throws is retried, and the send
 *      happens once.
 *   2. A done effect returns its stored result without running again.
 *   3. A failed effect runs again on the next call.
 *   4. An effect left running: `busy` while recent, `unknown` (PermanentError)
 *      once stale, and run again only with `retryUnknown`.
 *   5. The record survives a rollback of the transaction it ran in.
 *   6. The application role cannot read the table, only call the functions.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { Hono } from "hono";

import { defineAction } from "../../../../packages/engine/src/actions";
import { EffectBusyError, runEffect } from "../../../../packages/engine/src/effects";
import { PermanentError, queue } from "../../../../packages/engine/src/queue";
import { runInRequestScope } from "../../../../packages/engine/src/request-scope";
import {
  rlsTransaction,
  type TransactionalConnection,
} from "../../../../packages/engine/src/rls-request";
import { db } from "../db";
import { pauseWorker, processPending, setupWorkers, shutdownQueues } from "../lib/queue";

import { isDatabaseAvailable } from "./setup";

const QUEUE = "test-effects";
const TRIGGER = `event:${QUEUE}`;
const SCOPE = "test-direct-effects";
let available = false;
let sent = 0;

/**
 * The error a promise rejects with. `expect(promise).rejects` has hung in
 * bun:test before (see the conta tests): a plain try/catch does not.
 */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function rows(r: unknown): Array<Record<string, unknown>> {
  return ((r as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>;
}

async function effectRow(scope: string, key: string): Promise<Record<string, unknown> | undefined> {
  return rows(
    await db.execute(
      sql`SELECT * FROM kitsuden_action_effects WHERE scope = ${scope} AND key = ${key}`
    )
  )[0];
}

async function jobStatus(id: string): Promise<string | undefined> {
  const [row] = rows(
    await db.execute(sql`SELECT status FROM kitsuden_outbox WHERE id = ${id}::uuid`)
  );
  return row?.status as string | undefined;
}

/** An app with each request's RLS transaction, like the host. */
const app = new Hono();
app.use("*", async (_c, next) => {
  await runInRequestScope({ requestId: `req-${Date.now()}` }, () => next());
});
app.use("*", rlsTransaction(db as unknown as TransactionalConnection));
app.post("/effect-then-500", async (c) => {
  await runEffect(SCOPE, "rollback", () => ({ ok: true }));
  return c.json({ error: "after the effect" }, 500);
});

beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available) return;
  defineAction({
    trigger: TRIGGER,
    run: async (ctx) => {
      const receipt = await ctx.effect("mail:welcome", () => {
        sent++;
        return { messageId: `m-${sent}` };
      });
      // Fails AFTER the effect on the first attempt, as a timeout would.
      if (ctx.event?.attempt === 1) throw new Error("failure after the send");
      return receipt;
    },
  });
  await setupWorkers();
  pauseWorker(true);
});

beforeEach(async () => {
  if (!available) return;
  sent = 0;
  await db.execute(sql`DELETE FROM kitsuden_outbox WHERE queue = ${QUEUE}`);
  await db.execute(sql`DELETE FROM kitsuden_action_effects WHERE scope IN (${TRIGGER}, ${SCOPE})`);
});

afterAll(async () => {
  if (!available) return;
  await db.execute(sql`DELETE FROM kitsuden_outbox WHERE queue = ${QUEUE}`);
  await db.execute(sql`DELETE FROM kitsuden_action_effects WHERE scope IN (${TRIGGER}, ${SCOPE})`);
  await shutdownQueues();
});

describe("ctx.effect in a queue action", () => {
  it("a retry after the send does not send again", async () => {
    if (!available) return;
    const { id } = await queue.dispatch(QUEUE, "welcome", {}, { attempts: 3 });
    await processPending();
    expect(await jobStatus(id)).toBe("pending");
    expect(sent).toBe(1);

    // The retry backoff puts it in the future: it is moved forward for the test.
    await db.execute(sql`UPDATE kitsuden_outbox SET run_at = now() WHERE id = ${id}::uuid`);
    await processPending();
    expect(await jobStatus(id)).toBe("done");
    expect(sent).toBe(1);

    const row = await effectRow(TRIGGER, "mail:welcome");
    expect(row?.status).toBe("done");
    expect(row?.result).toEqual({ messageId: "m-1" });
    expect(Number(row?.attempts)).toBe(1);
  });
});

describe("runEffect", () => {
  it("returns the stored result of a done effect without running it", async () => {
    if (!available) return;
    expect(await runEffect(SCOPE, "k", () => "first")).toBe("first");
    let ran = false;
    const again = await runEffect(SCOPE, "k", () => {
      ran = true;
      return "second";
    });
    expect(again).toBe("first");
    expect(ran).toBe(false);
  });

  it("runs a failed effect again", async () => {
    if (!available) return;
    const failure = await rejection(
      runEffect(SCOPE, "flaky", () => {
        throw new Error("down");
      })
    );
    expect((failure as Error).message).toBe("down");
    expect((await effectRow(SCOPE, "flaky"))?.status).toBe("failed");

    expect(await runEffect(SCOPE, "flaky", () => 7)).toBe(7);
    const row = await effectRow(SCOPE, "flaky");
    expect(row?.status).toBe("done");
    expect(Number(row?.attempts)).toBe(2);
  });

  it("an effect left running is busy, then unknown, and runs again only if asked", async () => {
    if (!available) return;
    await db.execute(
      sql`INSERT INTO kitsuden_action_effects (scope, key, status) VALUES (${SCOPE}, 'half', 'running')`
    );
    expect(await rejection(runEffect(SCOPE, "half", () => 1))).toBeInstanceOf(EffectBusyError);

    await db.execute(sql`
      UPDATE kitsuden_action_effects SET started_at = now() - interval '1 hour'
       WHERE scope = ${SCOPE} AND key = 'half'
    `);
    expect(await rejection(runEffect(SCOPE, "half", () => 1))).toBeInstanceOf(PermanentError);
    expect((await effectRow(SCOPE, "half"))?.status).toBe("running");

    expect(await runEffect(SCOPE, "half", () => 2, { retryUnknown: true })).toBe(2);
    expect((await effectRow(SCOPE, "half"))?.status).toBe("done");
  });

  it("the record survives a rollback of the request it ran in", async () => {
    if (!available) return;
    const res = await app.request("/effect-then-500", { method: "POST" });
    expect(res.status).toBe(500);
    expect((await effectRow(SCOPE, "rollback"))?.status).toBe("done");
  });

  it("rejects an empty key", async () => {
    expect(await rejection(runEffect(SCOPE, "", () => 1))).toBeInstanceOf(TypeError);
  });
});

describe("ctx.effect: permissions of the application role", () => {
  const ROLE = "kitsuden_effects_probe";

  beforeAll(async () => {
    if (!available) return;
    await db.execute(
      sql.raw(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE ${ROLE} NOLOGIN; END IF;
    END $$`)
    );
    await db.execute(
      sql.raw(
        `GRANT EXECUTE ON FUNCTION kitsuden_effect_begin(text, text, text, integer, boolean) TO ${ROLE}`
      )
    );
  });

  it("can call the functions, but cannot read the table", async () => {
    if (!available) return;
    const r = await db
      .transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE ${ROLE}`));
        const begun = await tx.execute(
          sql`SELECT * FROM kitsuden_effect_begin(${SCOPE}, 'role', NULL, 60000, false)`
        );
        const read = await tx.execute(sql`SELECT result FROM kitsuden_action_effects LIMIT 1`).then(
          () => "read",
          (e: unknown) => String((e as { cause?: { code?: string } }).cause?.code ?? e)
        );
        return { decision: rows(begun)[0]?.decision, read };
      })
      .catch((e: unknown) => ({ error: String(e) }));
    expect(r).toMatchObject({ decision: "run" });
    expect((r as { read?: string }).read).toContain("42501");
  });
});
