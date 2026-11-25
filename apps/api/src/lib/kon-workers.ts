/**
 * Kons' long-running processes (`defineKon({ workers })`, docs/kons/workers.md)
 * ============================================================================
 *
 * Some kons need something that stays open: a bot keeps a socket to Discord's gateway, a mailbox is
 * polled. A request handler cannot hold that, a schedule only ticks, and an `onStartup` that opens a
 * socket opens one per replica (two bots answering every message) and never comes back after a crash.
 *
 *   · ONE instance across every replica and process. Each worker holds a Postgres advisory lock on a
 *     connection of its own for as long as it runs; the other processes try again every
 *     `LOCK_RETRY_MS`. If the connection drops, the lock is gone: the worker is stopped here, and
 *     another process takes it.
 *   · Where it runs is chosen with the same image: `KITSUDEN_WORKERS=inline` (the default: the API
 *     runs them), `off` (this process runs none) or `only` (a worker process: same command, no public
 *     traffic). `KITSUDEN_WORKER_FILTER=dc:gateway,koe:*` narrows what one process takes.
 *   · It stops (its `signal` aborts) on shutdown, when the kon is switched off, and when the lock is
 *     lost. A crash (it throws, or returns while not stopped) restarts it after 1 s, 2 s, 4 s… up to
 *     60 s; the pause resets after 5 minutes of healthy running.
 *   · Without a real Postgres (pg-mem, lite) the lock is this process's own: there is no other.
 */

import { createHash } from "node:crypto";

import type { KonContext, KonDefinition, KonWorker } from "@kitsuden/shared";

import { konSwitchedOff } from "./kon-activation";
import { logger } from "./logger";

const WORKER_ID = /^[a-z][a-z0-9-]{0,62}$/;

/** How often a process that does not hold a worker's lock tries again, and re-checks a kon that is off. */
export const LOCK_RETRY_MS = 15_000;
/** How often a running worker checks that its kon is still on. */
const ACTIVATION_CHECK_MS = 10_000;
/** How long a stopped worker gets to return before shutdown moves on. */
const STOP_GRACE_MS = 10_000;
const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** Running this long without crashing resets the pause. */
const HEALTHY_MS = 5 * 60_000;

export type WorkersMode = "inline" | "off" | "only";

/** A held lock: `lost` aborts when it can no longer be trusted (the connection dropped). */
export interface WorkerLock {
  lost: AbortSignal;
  release(): Promise<void>;
}

/** Takes a worker's lock, or `null` if another process holds it. */
export type LockAcquirer = (workerId: string) => Promise<WorkerLock | null>;

interface Registered {
  konId: string;
  workerId: string;
  worker: KonWorker;
  context: KonContext;
  /** Aborts when the kon is announced again (its new declaration replaces this one) or on stop. */
  retired: AbortController;
  /** The supervisor loop, while it runs. */
  loop: Promise<void> | null;
  running: boolean;
  restarts: number;
  lastError: string | null;
}

const registry = new Map<string, Registered>();
let started = false;
let stopAll = new AbortController();
let acquire: LockAcquirer = postgresLock;
let timings = {
  lockRetry: LOCK_RETRY_MS,
  activationCheck: ACTIVATION_CHECK_MS,
  stopGrace: STOP_GRACE_MS,
  backoffFirst: BACKOFF_FIRST_MS,
  backoffMax: BACKOFF_MAX_MS,
  healthy: HEALTHY_MS,
};

/** `KITSUDEN_WORKERS`: an unknown value is reported and read as the default. */
export function workersMode(env: NodeJS.ProcessEnv = process.env): WorkersMode {
  const raw = (env.KITSUDEN_WORKERS ?? "").trim().toLowerCase();
  if (raw === "" || raw === "inline") return "inline";
  if (raw === "off" || raw === "only") return raw;
  logger.warn(`[worker] KITSUDEN_WORKERS=${raw} is not inline, off or only: using inline`);
  return "inline";
}

/** Does `KITSUDEN_WORKER_FILTER` let this process take `dc:gateway`? Empty = every worker. */
export function workerAllowed(workerId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const patterns = (env.KITSUDEN_WORKER_FILTER ?? "")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (patterns.length === 0) return true;
  const [kon] = workerId.split(":");
  return patterns.some((p) => p === workerId || p === "*" || p === `${kon}:*`);
}

/** The full name: `kon-dc` + `gateway` → `dc:gateway`. */
export function workerIdOf(konId: string, id: string): string {
  return `${konId.replace(/^kon-/, "")}:${id}`;
}

/** Why a worker cannot be registered, or `null`. */
export function workerProblem(worker: KonWorker): string | null {
  if (!worker || typeof worker !== "object") return "a worker must be an object";
  if (typeof worker.id !== "string" || !WORKER_ID.test(worker.id)) {
    return `worker id ${JSON.stringify(worker.id)} must be lower case letters, digits and '-', starting with a letter`;
  }
  if (typeof worker.run !== "function") return `worker ${worker.id} has no run()`;
  return null;
}

/**
 * Registers what a kon declared. Called when the kon is announced (at startup and when it is enabled at
 * runtime); a kon announced again replaces its workers (the old ones are stopped). Returns the problems.
 */
export function registerKonWorkers(
  konDef: Pick<KonDefinition, "id" | "workers">,
  context: KonContext
): string[] {
  const problems: string[] = [];
  for (const [key, entry] of registry) {
    if (entry.konId === konDef.id) {
      entry.retired.abort();
      registry.delete(key);
    }
  }
  const seen = new Set<string>();
  for (const worker of konDef.workers ?? []) {
    const problem = workerProblem(worker);
    if (problem) {
      problems.push(problem);
      continue;
    }
    if (seen.has(worker.id)) {
      problems.push(`worker ${worker.id} is declared twice`);
      continue;
    }
    seen.add(worker.id);
    const workerId = workerIdOf(konDef.id, worker.id);
    const entry: Registered = {
      konId: konDef.id,
      workerId,
      worker,
      context,
      retired: new AbortController(),
      loop: null,
      running: false,
      restarts: 0,
      lastError: null,
    };
    registry.set(workerId, entry);
    if (started) launch(entry);
  }
  return problems;
}

/** Starts the supervisors (the API's startup); later registrations start at once. */
export function startKonWorkers(env: NodeJS.ProcessEnv = process.env): void {
  if (started) return;
  const mode = workersMode(env);
  if (mode === "off") {
    if (registry.size > 0) {
      logger.info(
        { workers: [...registry.keys()] },
        "[worker] KITSUDEN_WORKERS=off: this process runs no kon workers"
      );
    }
    return;
  }
  started = true;
  stopAll = new AbortController();
  for (const entry of registry.values()) launch(entry);
  if (registry.size > 0) {
    logger.info({ workers: [...registry.keys()], mode }, "[worker] kon workers supervised");
  }
}

/** Stops every worker and waits for them, up to the grace period (shutdown, tests). */
export async function stopKonWorkers(): Promise<void> {
  started = false;
  stopAll.abort();
  const loops = [...registry.values()].map((e) => e.loop).filter(Boolean) as Promise<void>[];
  await Promise.race([Promise.allSettled(loops), sleep(timings.stopGrace + 1_000)]);
}

/** What is declared and where it runs, for the panel and `/api/admin`. */
export function listKonWorkers(): Array<{
  konId: string;
  id: string;
  description: string | null;
  runningHere: boolean;
  restarts: number;
  lastError: string | null;
}> {
  return [...registry.values()].map((e) => ({
    konId: e.konId,
    id: e.workerId,
    description: e.worker.description ?? null,
    runningHere: e.running,
    restarts: e.restarts,
    lastError: e.lastError,
  }));
}

function launch(entry: Registered): void {
  if (entry.loop) return;
  if (!workerAllowed(entry.workerId)) return;
  entry.loop = supervise(entry).finally(() => {
    entry.loop = null;
  });
}

/** The life of one worker in this process: wait for its kon and its lock, run it, restart it. */
async function supervise(entry: Registered): Promise<void> {
  const done = AbortSignal.any([stopAll.signal, entry.retired.signal]);
  let failures = 0;
  while (!done.aborted) {
    if (await konOff(entry.konId)) {
      await sleep(timings.lockRetry, done);
      continue;
    }
    let lock: WorkerLock | null = null;
    try {
      lock = await acquire(entry.workerId);
    } catch (err) {
      logger.warn(
        { worker: entry.workerId, err: messageOf(err) },
        "[worker] could not ask for the lock"
      );
    }
    if (!lock) {
      await sleep(timings.lockRetry, done);
      continue;
    }

    const stop = new AbortController();
    const signal = AbortSignal.any([done, lock.lost, stop.signal]);
    const watch = watchActivation(entry.konId, stop, signal);
    const began = Date.now();
    let crashed = false;
    entry.running = true;
    logger.info({ worker: entry.workerId, attempt: entry.restarts }, "[worker] started");
    try {
      const run = Promise.resolve().then(() =>
        entry.worker.run(entry.context, {
          signal,
          workerId: entry.workerId,
          attempt: entry.restarts,
        })
      );
      // Settles when run() does, or when the grace after a stop runs out.
      await untilSettledOrGrace(run, signal);
      crashed = !signal.aborted;
      if (crashed) entry.lastError = "run() returned while the worker was not stopped";
    } catch (err) {
      crashed = !signal.aborted;
      entry.lastError = messageOf(err);
      logger.error(
        { worker: entry.workerId, err: entry.lastError },
        signal.aborted ? "[worker] failed while stopping" : "[worker] crashed"
      );
    } finally {
      entry.running = false;
      clearInterval(watch);
      await lock.release().catch(() => {});
    }

    if (!crashed) {
      logger.info({ worker: entry.workerId }, "[worker] stopped");
      failures = 0;
      continue; // kon off, lock lost, retired or shutdown: the loop decides
    }
    if (Date.now() - began >= timings.healthy) failures = 0;
    const pause = Math.min(timings.backoffMax, timings.backoffFirst * 2 ** failures);
    failures++;
    entry.restarts++;
    logger.warn({ worker: entry.workerId, inMs: pause }, "[worker] restarting");
    await sleep(pause, done);
  }
}

/** Every few seconds: is the kon still on? If not, stop the worker. */
function watchActivation(
  konId: string,
  stop: AbortController,
  signal: AbortSignal
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    if (signal.aborted) return;
    void konOff(konId).then((off) => {
      if (off) stop.abort();
    });
  }, timings.activationCheck);
  timer.unref?.();
  return timer;
}

async function untilSettledOrGrace(run: Promise<void>, signal: AbortSignal): Promise<void> {
  const graceAfterStop = new Promise<void>((resolve) => {
    const onAbort = () => {
      const t = setTimeout(resolve, timings.stopGrace);
      t.unref?.();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  await Promise.race([run, graceAfterStop]);
}

/** Disabled or uninstalled since it was loaded, whether at startup or hot. */
async function konOff(konId: string): Promise<boolean> {
  if (await konSwitchedOff(konId).catch(() => false)) return true;
  const { hotKonSwitchedOff } = await import("./deferred-kons");
  return hotKonSwitchedOff(konId).catch(() => false);
}

// ── The lock ─────────────────────────────────────────────────────────────────

/** A stable 63-bit key for `pg_try_advisory_lock(bigint)`. */
export function lockKeyOf(workerId: string): string {
  const hash = createHash("sha256").update(`kitsuden-kon-worker:${workerId}`).digest();
  return (hash.readBigUInt64BE(0) & 0x7fff_ffff_ffff_ffffn).toString();
}

const heldHere = new Set<string>();

/** Without a real Postgres there is only this process: the lock is a set. */
function processLock(workerId: string): WorkerLock | null {
  if (heldHere.has(workerId)) return null;
  heldHere.add(workerId);
  return {
    lost: new AbortController().signal,
    release: async () => {
      heldHere.delete(workerId);
    },
  };
}

/**
 * An advisory lock on a connection of its own, held for the worker's whole run. Advisory locks belong to
 * the session, so the pooled `db` cannot hold one: the next query could go out on another connection.
 */
async function postgresLock(workerId: string): Promise<WorkerLock | null> {
  const { isPgMem, isLiteMode } = await import("../db");
  const url = process.env.DATABASE_URL;
  if (isPgMem || isLiteMode || !url) return processLock(workerId);

  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: url,
    application_name: `kitsuden-worker ${workerId}`,
  });
  const lost = new AbortController();
  client.on("error", () => lost.abort());
  client.on("end", () => lost.abort());
  await client.connect();
  const key = lockKeyOf(workerId);
  const res = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS ok", [
    key,
  ]);
  if (!res.rows[0]?.ok) {
    await client.end().catch(() => {});
    return null;
  }
  // A silent network cut does not end the client: a periodic query notices it.
  const keepalive = setInterval(() => {
    client.query("SELECT 1").catch(() => lost.abort());
  }, 30_000);
  keepalive.unref?.();
  return {
    lost: lost.signal,
    release: async () => {
      clearInterval(keepalive);
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [key]).catch(() => {});
      await client.end().catch(() => {});
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Tests: forget everything, and optionally replace the lock and the pauses. */
export function resetKonWorkersForTests(
  options: { acquire?: LockAcquirer; timings?: Partial<typeof timings> } = {}
): void {
  stopAll.abort();
  for (const entry of registry.values()) entry.retired.abort();
  registry.clear();
  heldHere.clear();
  started = false;
  stopAll = new AbortController();
  acquire = options.acquire ?? postgresLock;
  timings = {
    lockRetry: LOCK_RETRY_MS,
    activationCheck: ACTIVATION_CHECK_MS,
    stopGrace: STOP_GRACE_MS,
    backoffFirst: BACKOFF_FIRST_MS,
    backoffMax: BACKOFF_MAX_MS,
    healthy: HEALTHY_MS,
    ...options.timings,
  };
}

/** Tests: the in-process lock, as pg-mem uses it. */
export const processLockForTests: LockAcquirer = async (id) => processLock(id);

/** Tests: the real Postgres advisory lock. */
export const postgresLockForTests: LockAcquirer = (id) => postgresLock(id);
