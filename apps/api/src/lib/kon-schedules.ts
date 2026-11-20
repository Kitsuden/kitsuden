/**
 * Kons' periodic tasks (`defineKon({ schedules })`, docs/kons/schedules.md)
 * ============================================================================
 *
 * A kon that syncs with another system (an ERP, a mailbox) needs a clock. Before, the only way was a
 * `setInterval` in `onStartup`, which ran in every replica of the API, stopped silently on a crash and
 * left no trace.
 *
 *   · Every process keeps the same timers (croner). When one fires, the process CLAIMS the tick
 *     (schedule-claim.ts): one row per (schedule, scheduled instant); the first wins, the rest skip.
 *   · The winner does not run the work itself: it queues a job on `kitsuden-kon-schedules`. The work
 *     runs on whichever process has a worker free, with the queue's lease, retries (`attempts`) and dead
 *     letter, visible in the panel. A process with `QUEUE_WORKER=false` still claims and queues.
 *   · A kon switched off since startup: its ticks are skipped (and a queued one does nothing).
 *   · Without a queue (pg-mem tests), the winner runs the work inline.
 */

import type { KonContext, KonDefinition, KonSchedule } from "@kitsuden/shared";
import { Cron } from "croner";

import { PermanentError, queue } from "../../../../packages/engine/src/queue";

import { konSwitchedOff } from "./kon-activation";
import { logger } from "./logger";
import { claimTick, tickOf } from "./schedule-claim";

export const KON_SCHEDULES_QUEUE = "kitsuden-kon-schedules";

interface Registered {
  konId: string;
  schedule: KonSchedule;
  context: KonContext;
  timer: Cron | null;
}

const registry = new Map<string, Registered>();
let started = false;

const SCHEDULE_ID = /^[a-z][a-z0-9-]{0,62}$/;

const keyOf = (konId: string, id: string) => `${konId}/${id}`;

/** Disabled or uninstalled since it was loaded, whether at startup or hot. */
async function konOff(konId: string): Promise<boolean> {
  if (await konSwitchedOff(konId).catch(() => false)) return true;
  // Deferred: deferred-kons reaches kon-setup, which reaches this file.
  const { hotKonSwitchedOff } = await import("./deferred-kons");
  return hotKonSwitchedOff(konId).catch(() => false);
}

/** Why a schedule cannot be registered, or `null`. */
export function scheduleProblem(schedule: KonSchedule): string | null {
  if (!schedule || typeof schedule !== "object") return "a schedule must be an object";
  if (typeof schedule.id !== "string" || !SCHEDULE_ID.test(schedule.id)) {
    return `schedule id "${String(schedule.id)}" must be lower case letters, digits and "-"`;
  }
  if (typeof schedule.run !== "function") return `schedule ${schedule.id} has no run()`;
  const fields = typeof schedule.cron === "string" ? schedule.cron.trim().split(/\s+/).length : 0;
  if (fields !== 5 && fields !== 6) {
    return `schedule ${schedule.id}: "${String(schedule.cron)}" is not a 5- or 6-field cron expression`;
  }
  try {
    new Cron(schedule.cron, { paused: true, timezone: schedule.timezone }).stop();
  } catch (err: unknown) {
    return `schedule ${schedule.id}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (
    schedule.attempts !== undefined &&
    (!Number.isInteger(schedule.attempts) || schedule.attempts < 1 || schedule.attempts > 5)
  ) {
    return `schedule ${schedule.id}: attempts must be an integer from 1 to 5`;
  }
  return null;
}

function startTimer(entry: Registered): void {
  entry.timer?.stop();
  entry.timer = new Cron(
    entry.schedule.cron,
    {
      name: `kitsuden-kon:${keyOf(entry.konId, entry.schedule.id)}`,
      timezone: entry.schedule.timezone,
      // A tick that is still being claimed when the next one comes is not doubled in this process.
      protect: true,
      // The timer does not keep the process alive on its own (tests, a graceful stop).
      unref: true,
      catch: (err) =>
        logger.error(
          { err, schedule: keyOf(entry.konId, entry.schedule.id) },
          "[schedule] tick failed"
        ),
    },
    async () => {
      await fireTick(entry.konId, entry.schedule.id);
    }
  );
}

/**
 * Registers what a kon declared. Called when the kon is announced (at startup and when it is enabled at
 * runtime); a kon announced again replaces its schedules. Returns the problems, one per bad schedule.
 */
export function registerKonSchedules(
  konDef: Pick<KonDefinition, "id" | "schedules">,
  context: KonContext
): string[] {
  const problems: string[] = [];
  for (const [key, entry] of registry) {
    if (entry.konId === konDef.id) {
      entry.timer?.stop();
      registry.delete(key);
    }
  }
  const seen = new Set<string>();
  for (const schedule of konDef.schedules ?? []) {
    const problem = scheduleProblem(schedule);
    if (problem) {
      problems.push(problem);
      continue;
    }
    if (seen.has(schedule.id)) {
      problems.push(`schedule ${schedule.id} is declared twice`);
      continue;
    }
    seen.add(schedule.id);
    const entry: Registered = { konId: konDef.id, schedule, context, timer: null };
    registry.set(keyOf(konDef.id, schedule.id), entry);
    if (started) startTimer(entry);
  }
  return problems;
}

/** Starts every registered timer (the API's startup). Later registrations start at once. */
export function startKonSchedules(): void {
  if (started) return;
  started = true;
  for (const entry of registry.values()) startTimer(entry);
  if (registry.size > 0) {
    logger.info({ schedules: [...registry.keys()] }, "[schedule] kon schedules running");
  }
}

/** Stops every timer (shutdown, tests). */
export function stopKonSchedules(): void {
  started = false;
  for (const entry of registry.values()) {
    entry.timer?.stop();
    entry.timer = null;
  }
}

/** What is scheduled, for the panel and `/api/admin`. */
export function listKonSchedules(): Array<{
  konId: string;
  id: string;
  cron: string;
  timezone: string;
  description: string | null;
  nextRun: string | null;
}> {
  return [...registry.values()].map((e) => ({
    konId: e.konId,
    id: e.schedule.id,
    cron: e.schedule.cron,
    timezone: e.schedule.timezone ?? "UTC",
    description: e.schedule.description ?? null,
    nextRun: e.timer?.nextRun()?.toISOString() ?? null,
  }));
}

interface ScheduleJob {
  konId: string;
  scheduleId: string;
  scheduledAt: string;
}

/**
 * One tick in this process: claim it, then queue the work (or run it inline without a queue). Exported
 * for tests, which pass the instant.
 */
export async function fireTick(
  konId: string,
  scheduleId: string,
  now: Date = new Date()
): Promise<"claimed" | "skipped" | "off" | "unknown"> {
  const entry = registry.get(keyOf(konId, scheduleId));
  if (!entry) return "unknown";
  if (await konOff(konId)) return "off";
  const scheduledAt = tickOf(now, entry.schedule.cron);
  const key = `kon:${keyOf(konId, scheduleId)}`;
  if (!(await claimTick(key, scheduledAt))) return "skipped";

  const job: ScheduleJob = { konId, scheduleId, scheduledAt: scheduledAt.toISOString() };
  if (!queue.configured()) {
    await runScheduleJob({ payload: job });
    return "claimed";
  }
  await queue.dispatch(KON_SCHEDULES_QUEUE, `${konId}.${scheduleId}`, job, {
    attempts: entry.schedule.attempts ?? 1,
    reason: `schedule ${keyOf(konId, scheduleId)} at ${job.scheduledAt}`,
    dedupeKey: `${key}@${job.scheduledAt}`.slice(0, 200),
  });
  return "claimed";
}

/** The queue handler: runs the kon's work for one tick. */
export async function runScheduleJob(job: { payload: unknown }): Promise<void> {
  const data = job.payload as ScheduleJob;
  const entry = registry.get(keyOf(data.konId, data.scheduleId));
  // The kon no longer declares it (updated, uninstalled): nothing to run, nothing to retry.
  if (!entry) throw new PermanentError(`no schedule ${keyOf(data.konId, data.scheduleId)}`);
  if (await konOff(data.konId)) return;
  const started = Date.now();
  await entry.schedule.run(entry.context, { scheduledAt: new Date(data.scheduledAt) });
  logger.info(
    {
      schedule: keyOf(data.konId, data.scheduleId),
      scheduledAt: data.scheduledAt,
      ms: Date.now() - started,
    },
    "[schedule] ran"
  );
}

/** Registers the queue handler (called by the worker startup, lib/queue.ts). */
export function registerKonScheduleWorker(): void {
  queue.handle(KON_SCHEDULES_QUEUE, runScheduleJob, { concurrency: 2 });
}

/** Tests: forget everything. */
export function resetKonSchedulesForTests(): void {
  stopKonSchedules();
  registry.clear();
}
