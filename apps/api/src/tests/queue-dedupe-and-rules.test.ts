/**
 * The queue: not twice, and jobs from automation rules
 * ============================================================================
 *
 * On the real Postgres queue (migration 0085). What has to hold:
 *
 *   · with `dedupeKey`, a second dispatch while the first job waits or runs
 *     queues nothing and answers the first job's id; the key is per queue, and
 *     free again once the job is done or dead;
 *   · two dispatches at the same instant leave one job;
 *   · retrying a dead job whose key was taken in the meantime is refused;
 *   · a lane is a queue: a blocked one does not hold another back;
 *   · the rule step `core:enqueue` reaches only queues that opened themselves
 *     to rules, queues as the rule's owner, fills the payload and the key from
 *     the event, and a dry run queues nothing.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { sql } from "drizzle-orm";

import { PermanentError, queue, ruleQueues } from "../../../../packages/engine/src/queue";
import { db } from "../db";
import { dryRunAction, executeRuleAction, ruleProblem } from "../lib/actions/rules";
import type { Action, ActionContext } from "../lib/actions/types";
import { pauseWorker, processPending, retryJob, setupWorkers, shutdownQueues } from "../lib/queue";

import { generateTestId, isDatabaseAvailable } from "./setup";

setDefaultTimeout(60_000);

const tag = `qd${generateTestId()
  .replace(/[^a-z0-9]/gi, "")
  .slice(0, 10)}`;
const FAST = `${tag}-fast`;
const SLOW = `${tag}-slow`;
const OPEN = `${tag}-open`;
const CLOSED = `${tag}-closed`;

let available = false;
const ran: Array<{ queue: string; name: string; payload: unknown; actor: unknown }> = [];
let failNext = false;
let releaseSlow: (() => void) | null = null;

function rows(r: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<
    Record<string, unknown>
  >;
}

const jobsOf = async (name: string) =>
  rows(
    await db.execute(
      sql`SELECT id::text AS id, status, dedupe_key, user_id, payload, name FROM kitsuden_outbox WHERE queue = ${name} ORDER BY created_at`
    )
  );

async function until(check: () => Promise<boolean> | boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

const rule = (steps: unknown[], createdById: string | null = null): Action =>
  ({
    id: "00000000-0000-4000-8000-0000000000aa",
    name: "Identify new contacts",
    slug: `${tag}-rule`,
    type: "rule",
    config: { steps },
    createdById,
  }) as unknown as Action;

const eventContext = (data: Record<string, unknown>): ActionContext =>
  ({ event: { name: "crm.contact.created", data } }) as unknown as ActionContext;

describe("the queue: dedupe keys, lanes and rules", () => {
  beforeAll(async () => {
    available = await isDatabaseAvailable();
    if (!available) return;
    const record =
      (name: string) => async (job: { name: string; payload: unknown; actor: unknown }) => {
        if (failNext) {
          failNext = false;
          throw new PermanentError("refused by the test");
        }
        ran.push({ queue: name, name: job.name, payload: job.payload, actor: job.actor });
      };
    queue.handle(FAST, record(FAST), { concurrency: 2 });
    queue.handle(
      SLOW,
      async () => {
        await new Promise<void>((r) => (releaseSlow = r));
      },
      { concurrency: 1 }
    );
    queue.handle(OPEN, record(OPEN), {
      concurrency: 1,
      rules: {
        label: "Identify a contact",
        description: "Looks a contact up and fills its name.",
        payload: { contactId: "id of the contact" },
      },
    });
    queue.handle(CLOSED, record(CLOSED));
    await setupWorkers();
    pauseWorker(true);
  });

  afterAll(async () => {
    releaseSlow?.();
    if (!available) return;
    pauseWorker(false);
    await shutdownQueues();
    await db.execute(sql`DELETE FROM kitsuden_outbox WHERE queue LIKE ${`${tag}%`}`);
  });

  it("a second dispatch with the same key queues nothing and answers the first job", async () => {
    if (!available) return;
    const first = await queue.dispatch(FAST, "identify", { n: 1 }, { dedupeKey: "contact:1" });
    expect(first.deduplicated).toBe(false);
    const second = await queue.dispatch(FAST, "identify", { n: 2 }, { dedupeKey: "contact:1" });
    expect(second).toEqual({ id: first.id, deduplicated: true });
    // Another key, another queue and no key at all are not the same work.
    const other = await queue.dispatch(FAST, "identify", { n: 3 }, { dedupeKey: "contact:2" });
    const elsewhere = await queue.dispatch(CLOSED, "identify", {}, { dedupeKey: "contact:1" });
    const plainA = await queue.dispatch(FAST, "plain", {});
    const plainB = await queue.dispatch(FAST, "plain", {});
    expect(new Set([first.id, other.id, elsewhere.id, plainA.id, plainB.id]).size).toBe(5);
    expect(plainA.deduplicated).toBeUndefined();
    expect(await jobsOf(FAST)).toHaveLength(4);
    expect((await jobsOf(FAST))[0]!.payload).toEqual({ n: 1 });
  });

  it("two dispatches at the same instant leave one job", async () => {
    if (!available) return;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        queue.dispatch(FAST, "identify", {}, { dedupeKey: "contact:race" })
      )
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.deduplicated === false)).toHaveLength(1);
  });

  it("the key is free again once the job is done", async () => {
    if (!available) return;
    pauseWorker(false);
    await processPending();
    expect(await until(async () => (await jobsOf(FAST)).every((j) => j.status === "done"))).toBe(
      true
    );
    pauseWorker(true);
    const again = await queue.dispatch(FAST, "identify", { n: 9 }, { dedupeKey: "contact:1" });
    expect(again.deduplicated).toBe(false);
  });

  it("retrying a dead job whose key was taken since is refused", async () => {
    if (!available) return;
    await db.execute(sql`DELETE FROM kitsuden_outbox WHERE queue = ${FAST}`);
    failNext = true;
    const dead = await queue.dispatch(FAST, "identify", {}, { dedupeKey: "contact:dead" });
    pauseWorker(false);
    await processPending();
    expect(
      await until(async () =>
        (await jobsOf(FAST)).some((j) => j.id === dead.id && j.status === "dead")
      )
    ).toBe(true);
    pauseWorker(true);

    // Dead: the key is free, and another job takes it.
    const next = await queue.dispatch(FAST, "identify", {}, { dedupeKey: "contact:dead" });
    expect(next.deduplicated).toBe(false);
    expect(await retryJob(dead.id)).toBe(false);
    expect((await jobsOf(FAST)).find((j) => j.id === dead.id)!.status).toBe("dead");

    // Once that one is done, the dead job can be retried.
    pauseWorker(false);
    await processPending();
    expect(
      await until(async () =>
        (await jobsOf(FAST)).some((j) => j.id === next.id && j.status === "done")
      )
    ).toBe(true);
    expect(await retryJob(dead.id)).toBe(true);
    expect(await until(async () => (await jobsOf(FAST)).every((j) => j.status === "done"))).toBe(
      true
    );
    pauseWorker(true);
  });

  it("a lane is a queue: a blocked one does not hold another back", async () => {
    if (!available) return;
    ran.length = 0;
    pauseWorker(false);
    await queue.dispatch(SLOW, "model", {});
    await queue.dispatch(SLOW, "model", {});
    expect(await until(() => releaseSlow !== null)).toBe(true);
    for (let i = 0; i < 5; i++) await queue.dispatch(FAST, "plain", { i });
    expect(await until(() => ran.filter((r) => r.queue === FAST).length === 5)).toBe(true);
    // The slow lane is still on its first job, one at a time.
    const slow = await jobsOf(SLOW);
    expect(slow.map((j) => j.status).sort()).toEqual(["pending", "running"]);
    releaseSlow?.();
    pauseWorker(true);
  });

  it("only a queue that opened itself is offered to rules", async () => {
    if (!available) return;
    const offered = ruleQueues().filter((q) => q.queue.startsWith(tag));
    expect(offered).toEqual([
      {
        queue: OPEN,
        label: "Identify a contact",
        description: "Looks a contact up and fills its name.",
        payload: { contactId: "id of the contact" },
      },
    ]);
    const step = (config: Record<string, unknown>) => ({
      steps: [{ handler: "core:enqueue", config }],
    });
    expect(await ruleProblem(step({ queue: OPEN }))).toBeNull();
    expect(await ruleProblem(step({ queue: CLOSED }))).toContain("does not accept jobs from rules");
    expect(await ruleProblem(step({ queue: "kitsuden-email" }))).toContain("does not accept");
    expect(await ruleProblem(step({ queue: "no-such-queue" }))).toContain("does not accept");
    expect(await ruleProblem(step({}))).toContain("queue is required");
    // The event must not choose the queue or the job.
    expect(await ruleProblem(step({ queue: "{{event.queue}}" }))).toContain("not a valid queue");
    expect(await ruleProblem(step({ queue: OPEN, job: "{{event.job}}" }))).toContain("job must be");
    expect(await ruleProblem(step({ queue: OPEN, payload: "x" }))).toContain("payload");
    expect(await ruleProblem(step({ queue: OPEN, attempts: 99 }))).toContain("attempts");
    expect(await ruleProblem(step({ queue: OPEN, delaySeconds: -1 }))).toContain("delaySeconds");
  });

  it("core:enqueue queues once per record, as the rule's owner, with the event's data", async () => {
    if (!available) return;
    ran.length = 0;
    const steps = [
      {
        handler: "core:enqueue",
        config: {
          queue: OPEN,
          job: "identify",
          payload: { contactId: "{{event.contactId}}" },
          dedupeKey: "identify:{{event.contactId}}",
        },
      },
    ];
    const first = await executeRuleAction(
      rule(steps, "owner-1"),
      eventContext({ contactId: "c-42" })
    );
    expect(first.success).toBe(true);
    const outcome = (first.result as { steps: Array<{ result: Record<string, unknown> }> })
      .steps[0]!;
    expect(outcome.result).toMatchObject({ deduplicated: false });

    // The same contact again (an update right after the creation): nothing new.
    const second = await executeRuleAction(
      rule(steps, "owner-1"),
      eventContext({ contactId: "c-42" })
    );
    const again = (second.result as { steps: Array<{ result: Record<string, unknown> }> })
      .steps[0]!;
    expect(again.result).toEqual({ jobId: outcome.result.jobId, deduplicated: true });
    // Another contact is other work.
    await executeRuleAction(rule(steps, "owner-1"), eventContext({ contactId: "c-43" }));

    const queued = await jobsOf(OPEN);
    expect(queued).toHaveLength(2);
    expect(queued[0]).toMatchObject({
      name: "identify",
      user_id: "owner-1",
      dedupe_key: "identify:c-42",
      payload: { contactId: "c-42" },
    });

    // Without `payload`, the handler gets the event's data.
    const whole = await executeRuleAction(
      rule([{ handler: "core:enqueue", config: { queue: OPEN } }]),
      eventContext({ contactId: "c-44", source: "form" })
    );
    expect(whole.success).toBe(true);
    const last = (await jobsOf(OPEN)).at(-1)!;
    expect(last).toMatchObject({ name: "rule", user_id: null, dedupe_key: null });
    expect(last.payload).toEqual({ contactId: "c-44", source: "form" });
  });

  it("a queue that is not open fails the step, and a dry run queues nothing", async () => {
    if (!available) return;
    const before = (await jobsOf(CLOSED)).length;
    const refused = await executeRuleAction(
      rule([{ handler: "core:enqueue", config: { queue: CLOSED } }]),
      eventContext({ contactId: "c-1" })
    );
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("does not accept jobs from rules");
    expect(await jobsOf(CLOSED)).toHaveLength(before);

    const open = (await jobsOf(OPEN)).length;
    const dry = await dryRunAction(
      rule([
        {
          handler: "core:enqueue",
          config: {
            queue: OPEN,
            payload: { contactId: "{{event.contactId}}" },
            dedupeKey: "k:{{event.contactId}}",
          },
        },
      ]),
      { payload: { contactId: "c-77" } }
    );
    expect(JSON.stringify(dry)).toContain("c-77");
    expect(JSON.stringify(dry)).toContain("k:c-77");
    expect(await jobsOf(OPEN)).toHaveLength(open);
  });
});
