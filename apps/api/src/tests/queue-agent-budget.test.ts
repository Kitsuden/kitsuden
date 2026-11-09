/**
 * The agent pays for its queued work — against REAL Postgres
 * ============================================================================
 *
 *   1. A job queued by an agent charges its cost to the agent's daily budget
 *      when it RUNS (`cost` per dispatch, else QUEUE_AGENT_JOB_COST = 1).
 *   2. With the budget spent: `postpone` (default) puts it back to pending for
 *      the next UTC day without using an attempt; `fail` sends it to the dead
 *      letter with the reason. Both are audited for the agent.
 *   3. Jobs of people and of `kitsuden-*` queues are never charged.
 *   4. Each attempt pays: a job that fails and is retried is charged again.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { queue } from "../../../../packages/engine/src/queue";
import { runInRequestScope } from "../../../../packages/engine/src/request-scope";
import { db } from "../db";
import { agentAuditLogs, agentQuotaUsage } from "../db/schema";
import { setQuotaValkey, utcDay } from "../lib/agent-quotas";
import {
  chargeJobBudget,
  pauseWorker,
  processPending,
  setRereadActor,
  setupWorkers,
  shutdownQueues,
  type JobRow,
} from "../lib/queue";
import { createAgent } from "../services/agent-auth";

import { generateTestId, isDatabaseAvailable } from "./setup";

const QUEUE = "test-budget";
let available = false;
const ran: string[] = [];
/** Names whose next run throws once (a transient failure, then a retry). */
const failOnce = new Set<string>();
let budget = 2;

function rows(r: unknown): Array<Record<string, unknown>> {
  return ((r as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>;
}

async function job(id: string): Promise<Record<string, unknown> | undefined> {
  return rows(await db.execute(sql`SELECT * FROM kitsuden_outbox WHERE id = ${id}::uuid`))[0];
}

/** One claim round per job (concurrency 1). */
async function drain(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await processPending();
}

async function agent(): Promise<string> {
  const { agent: a } = await createAgent({ name: `budget-${generateTestId()}`, scopes: [] });
  return a.id;
}

/** Dispatch as that agent (what a request with its key does). */
function asAgent(agentId: string, fn: () => Promise<{ id: string }>) {
  return runInRequestScope(
    { requestId: `req-${generateTestId()}`, user: { id: agentId, role: "agent" } },
    fn
  );
}

beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available) return;
  // The day's count in Postgres (agent_quota_usage), not in a Valkey that may be absent.
  setQuotaValkey(async () => null);
  // One at a time, in order: each charge sees the previous one.
  queue.handle(
    QUEUE,
    async (j) => {
      if (failOnce.delete(j.name)) throw new Error("transient failure");
      ran.push(j.name);
    },
    { concurrency: 1 }
  );
  await setupWorkers();
  pauseWorker(true);
});

beforeEach(async () => {
  if (!available) return;
  ran.length = 0;
  failOnce.clear();
  budget = 2;
  delete process.env.QUEUE_BUDGET_EXHAUSTED;
  delete process.env.QUEUE_AGENT_JOB_COST;
  setRereadActor(async (row) => ({
    ok: true,
    actor: row.agent_id ? { id: row.agent_id, role: "agent", scopes: [] } : null,
    limits: row.agent_id
      ? { agentId: row.agent_id, rateLimit: null, writesPerDay: null, budgetUnitsPerDay: budget }
      : undefined,
  }));
  await db.execute(sql`DELETE FROM kitsuden_outbox WHERE queue = ${QUEUE}`);
});

afterAll(async () => {
  if (!available) return;
  setRereadActor(null);
  await db.execute(sql`DELETE FROM kitsuden_outbox WHERE queue = ${QUEUE}`);
  await shutdownQueues();
});

describe("queue: the agent's budget pays for its jobs", () => {
  it("charges each job's cost when it runs; with the budget spent it is postponed", async () => {
    if (!available) return;
    const a = await agent();
    const first = await asAgent(a, () => queue.dispatch(QUEUE, "one", {}));
    const second = await asAgent(a, () => queue.dispatch(QUEUE, "two", {}, { cost: 1 }));
    const third = await asAgent(a, () => queue.dispatch(QUEUE, "three", {}));
    expect((await job(first.id))?.agent_id).toBe(a);

    await drain(3);
    expect(ran).toEqual(["one", "two"]);
    const [usage] = await db
      .select({ units: agentQuotaUsage.units })
      .from(agentQuotaUsage)
      .where(and(eq(agentQuotaUsage.agentId, a), eq(agentQuotaUsage.day, utcDay())));
    expect(usage?.units).toBe(2);

    const postponed = await job(third.id);
    expect(postponed?.status).toBe("pending");
    expect(Number(postponed?.attempts)).toBe(0); // the attempt was given back
    expect(String(postponed?.last_error)).toContain("budget_exhausted");
    // To the next UTC day.
    expect(new Date(String(postponed?.run_at)).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(String(postponed?.run_at)).toISOString().slice(0, 10) >= utcDay()).toBe(true);

    const audited = await db
      .select()
      .from(agentAuditLogs)
      .where(and(eq(agentAuditLogs.agentId, a), eq(agentAuditLogs.action, "job_budget_exhausted")));
    expect(audited).toHaveLength(1);
    expect(audited[0]!.resourceId).toBe(third.id);
  });

  it("each attempt pays: a job that fails and is retried is charged again", async () => {
    if (!available) return;
    const a = await agent();
    budget = 10;
    failOnce.add("flaky");
    const flaky = await asAgent(a, () => queue.dispatch(QUEUE, "flaky", {}, { cost: 2 }));
    await drain(1);
    expect(ran).toEqual([]);
    expect((await job(flaky.id))?.status).toBe("pending"); // waiting for its retry
    // Do not wait for the backoff.
    await db.execute(sql`UPDATE kitsuden_outbox SET run_at = now() WHERE id = ${flaky.id}::uuid`);
    await drain(1);
    expect(ran).toEqual(["flaky"]);
    const [usage] = await db
      .select({ units: agentQuotaUsage.units })
      .from(agentQuotaUsage)
      .where(and(eq(agentQuotaUsage.agentId, a), eq(agentQuotaUsage.day, utcDay())));
    expect(usage?.units).toBe(4); // two attempts × cost 2
  });

  it("onBudgetExhausted: fail sends it to the dead letter with the reason", async () => {
    if (!available) return;
    const a = await agent();
    budget = 3;
    const big = await asAgent(a, () =>
      queue.dispatch(QUEUE, "expensive", {}, { cost: 5, onBudgetExhausted: "fail" })
    );
    expect(Number((await job(big.id))?.cost)).toBe(5);
    await drain(1);
    expect(ran).toEqual([]);
    const dead = await job(big.id);
    expect(dead?.status).toBe("dead");
    expect(String(dead?.last_error)).toContain("budget_exhausted");
  });

  it("QUEUE_BUDGET_EXHAUSTED=fail is the default policy; cost 0 is free", async () => {
    if (!available) return;
    process.env.QUEUE_BUDGET_EXHAUSTED = "fail";
    const a = await agent();
    budget = 1;
    const free = await asAgent(a, () => queue.dispatch(QUEUE, "free", {}, { cost: 0 }));
    const paid = await asAgent(a, () => queue.dispatch(QUEUE, "paid", {}, { cost: 2 }));
    await drain(2);
    expect(ran).toEqual(["free"]);
    expect((await job(free.id))?.status).toBe("done");
    expect((await job(paid.id))?.status).toBe("dead");
  });

  it("people's jobs and system queues are never charged", async () => {
    if (!available) return;
    const a = await agent();
    const limits = { agentId: a, rateLimit: null, writesPerDay: null, budgetUnitsPerDay: 1 };
    const base: JobRow = {
      id: "x",
      queue: "kitsuden-email",
      name: "n",
      payload: {},
      user_id: null,
      user_role: "agent",
      agent_id: a,
      request_id: null,
      attempts: 1,
      max_attempts: 3,
      cost: 100,
    };
    expect(await chargeJobBudget(base, limits)).toEqual({ run: true, units: 0 });
    expect(
      await chargeJobBudget({ ...base, queue: QUEUE, agent_id: null, user_id: "u1" }, undefined)
    ).toEqual({ run: true, units: 0 });
    // An agent without a daily budget: it runs (nothing to enforce).
    expect(
      await chargeJobBudget({ ...base, queue: QUEUE }, { ...limits, budgetUnitsPerDay: null })
    ).toEqual({ run: true, units: 100 });
  });
});
