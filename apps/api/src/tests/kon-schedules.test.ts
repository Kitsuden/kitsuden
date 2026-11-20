/**
 * Kons' periodic tasks run once per tick across replicas (lib/kon-schedules.ts, migration 0091)
 *
 * Two "replicas" are two calls that fire the same tick at the same instant: one claims it, the other
 * skips. The work goes to the durable queue, runs from there with the tick's instant, and a schedule a
 * kon no longer declares is a permanent failure, not a retry loop.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { PermanentError } from "../../../../packages/engine/src/queue";
import { db } from "../db";
import { app } from "../index";
import {
  fireTick,
  KON_SCHEDULES_QUEUE,
  listKonSchedules,
  registerKonSchedules,
  resetKonSchedulesForTests,
  runScheduleJob,
  scheduleProblem,
} from "../lib/kon-schedules";
import { claimTick, tickOf } from "../lib/schedule-claim";

import { generateTestId, isDatabaseAvailable } from "./setup";

let dbAvailable = false;
const KON = `kon-sched-${generateTestId()
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "")}`.slice(0, 40);
const runs: Date[] = [];
const ctx = {} as never;

function rows<T>(r: unknown): T[] {
  return (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
}

describe("kon schedules", () => {
  beforeAll(async () => {
    void app; // the API's startup configures the queue
    dbAvailable = await isDatabaseAvailable();
  });

  afterAll(async () => {
    resetKonSchedulesForTests();
    if (!dbAvailable) return;
    await db.execute(
      sql`DELETE FROM kitsuden_outbox WHERE queue = ${KON_SCHEDULES_QUEUE} AND payload->>'konId' = ${KON}`
    );
  });

  it("refuses a bad declaration and keeps the good ones", () => {
    const problems = registerKonSchedules(
      {
        id: KON,
        schedules: [
          { id: "Bad Id", cron: "* * * * *", run: async () => {} },
          { id: "no-run", cron: "* * * * *" } as never,
          { id: "bad-cron", cron: "every minute", run: async () => {} },
          { id: "too-many", cron: "* * * * *", attempts: 9, run: async () => {} },
          {
            id: "sync",
            cron: "0 3 * * *",
            description: "nightly",
            run: async (_ctx, tick) => {
              runs.push(tick.scheduledAt);
            },
          },
        ],
      },
      ctx
    );
    expect(problems).toHaveLength(4);
    expect(
      listKonSchedules()
        .filter((s) => s.konId === KON)
        .map((s) => s.id)
    ).toEqual(["sync"]);
    expect(scheduleProblem({ id: "ok", cron: "*/5 * * * * *", run: async () => {} })).toBeNull();
  });

  it("the tick is the scheduled instant, the same on every replica", () => {
    const a = tickOf(new Date("2026-11-20T03:00:00.004Z"), "0 3 * * *");
    const b = tickOf(new Date("2026-11-20T03:00:00.912Z"), "0 3 * * *");
    expect(a.toISOString()).toBe("2026-11-20T03:00:00.000Z");
    expect(b.getTime()).toBe(a.getTime());
    expect(tickOf(new Date("2026-11-20T03:00:07.300Z"), "*/5 * * * * *").toISOString()).toBe(
      "2026-11-20T03:00:07.000Z"
    );
  });

  it("two replicas firing the same tick: one claims it, one job is queued", async () => {
    if (!dbAvailable) return;
    const at = new Date("2026-11-20T03:00:00.010Z");
    const outcomes = await Promise.all([fireTick(KON, "sync", at), fireTick(KON, "sync", at)]);
    expect(outcomes.sort()).toEqual(["claimed", "skipped"]);
    // The next tick is a new claim.
    expect(await fireTick(KON, "sync", new Date("2026-11-21T03:00:00.000Z"))).toBe("claimed");

    const queued = rows<{ payload: { scheduledAt: string } }>(
      await db.execute(
        sql`SELECT payload FROM kitsuden_outbox WHERE queue = ${KON_SCHEDULES_QUEUE} AND payload->>'konId' = ${KON} ORDER BY created_at`
      )
    );
    expect(queued.map((r) => r.payload.scheduledAt)).toEqual([
      "2026-11-20T03:00:00.000Z",
      "2026-11-21T03:00:00.000Z",
    ]);
  });

  it("the job runs the kon's work with the tick's instant", async () => {
    await runScheduleJob({
      payload: { konId: KON, scheduleId: "sync", scheduledAt: "2026-11-20T03:00:00.000Z" },
    });
    expect(runs.map((d) => d.toISOString())).toContain("2026-11-20T03:00:00.000Z");
  });

  it("a schedule the kon no longer declares fails for good (no retry loop)", async () => {
    await expect(
      runScheduleJob({
        payload: { konId: KON, scheduleId: "gone", scheduledAt: new Date().toISOString() },
      })
    ).rejects.toBeInstanceOf(PermanentError);
    expect(await fireTick(KON, "gone")).toBe("unknown");
  });

  it("the claim is per key and instant", async () => {
    if (!dbAvailable) return;
    const key = `test:${generateTestId()}`;
    const at = new Date("2026-11-20T10:00:00.000Z");
    expect(await claimTick(key, at)).toBe(true);
    expect(await claimTick(key, at)).toBe(false);
    expect(await claimTick(`${key}:other`, at)).toBe(true);
    expect(await claimTick(key, new Date("2026-11-20T10:01:00.000Z"))).toBe(true);
    await db.execute(sql`DELETE FROM kitsuden_schedule_ticks WHERE key LIKE ${`${key}%`}`);
  });
});
