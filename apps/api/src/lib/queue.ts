/**
 * Kitsuden — The job queue on Postgres (transactional outbox)
 * ============================================================================
 *
 * Implements the engine seam (`packages/engine/src/queue.ts`). Replaces
 * BullMQ (plan B1): a single engine, a single failure
 * semantics, and the API is deployed with Postgres and nothing else.
 *
 * ── DISPATCHING ────────────────────────────────────────────────────────────
 *
 * `queue.dispatch()` INSERTs into `kitsuden_outbox` with the request's
 * executor (`resolveExecutor`): inside a request, the RLS transaction;
 * ROLLBACK = the job does not exist. Before, BullMQ enqueued even if the request
 * was rolled back, and with Valkey down the job was lost with a log line.
 * Alongside the INSERT goes a `pg_notify('kitsuden_queue', queue)`, which Postgres
 * delivers at COMMIT (and never on a ROLLBACK).
 *
 * The application role only has INSERT on the table (migration 0056);
 * claiming, closing and listing go through SECURITY DEFINER functions.
 *
 * ── THE WORKER ─────────────────────────────────────────────────────────────
 *
 *   · Its OWN small pool (`QUEUE_POOL_MAX`, 3): it does not compete with
 *     requests for connections.
 *   · It wakes on NOTIFY (postgres-listen.ts) and, as a safety net, POLLS every
 *     `QUEUE_POLL_MS` (2 s). Polling is not optional: a notification
 *     can be lost.
 *   · It claims with `FOR UPDATE SKIP LOCKED` and marks `running` with a LEASE
 *     (`QUEUE_LEASE_SECONDS`, 300 s). A worker that dies leaves the lease
 *     expired; the sweep (every 30 s) returns it to the queue or, with no attempts left,
 *     to `dead`. At-least-once delivery: handlers must be idempotent.
 *   · The ACTOR is re-read on execution: person → their current role (deleted =
 *     not executed); agent → active, valid key and current scopes (like
 *     approvals). The handler runs in a lazy RLS transaction with
 *     THAT actor (`inRlsTransaction`): a job enqueued yesterday does not run with
 *     permissions revoked today.
 *   · The AGENT pays: a job queued by an agent is charged its `cost` (dispatch
 *     option, else `QUEUE_AGENT_JOB_COST`, 1) to the agent's daily budget when it
 *     runs, every attempt. With the budget spent it is postponed to the next UTC
 *     day (the attempt is given back) or, with `onBudgetExhausted: "fail"` /
 *     `QUEUE_BUDGET_EXHAUSTED=fail`, it goes to the dead letter with the reason.
 *     System queues (`kitsuden-*`: e-mail, webhooks, classifier, embeddings,
 *     reviews) are never charged.
 *   · Failures: exponential backoff (2 s, 4 s, 8 s… up to 10 min) until
 *     `max_attempts`; then `dead`. `PermanentError` = `dead` immediately.
 *     Dead ones are visible in the panel (`/api/admin/queue`): retry or
 *     discard. Finished ones are deleted after `QUEUE_RETENTION_DAYS` (7).
 *
 * No worker on pg-mem (it understands neither SKIP LOCKED nor plpgsql). In lite mode
 * (PGlite) it runs on the same database and without LISTEN: polling only.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import {
  configureQueue,
  PermanentError,
  queueHandlers,
  queue,
  type JobActor,
  type DispatchOptions,
  type QueueJob,
} from "../../../../packages/engine/src/queue";
import { resolveExecutor, useRequest } from "../../../../packages/engine/src/request-scope";
import {
  withLazyTransactions,
  inRlsTransaction,
  type TransactionalConnection,
} from "../../../../packages/engine/src/rls-request";
import { db, isLiteMode, isPgMem, mergedSchema } from "../db";
import { authUsers } from "../db/schema-core";
import { registerAgentAction } from "../services/agent-audit";

import type { AgentLimits } from "./agent-quotas";

// Side effect: plugs the `ctx.effect()` store into the engine.
import "./effects";
import { logger } from "./logger";
import { listen } from "./postgres-listen";

const CHANNEL = "kitsuden_queue";
export const EMAIL_QUEUE = "kitsuden-email";

function environmentNumber(name: string, defaultValue: number, min = 1): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : defaultValue;
}

const POLLING_MS = () => environmentNumber("QUEUE_POLL_MS", 2000, 100);
const LEASE_S = () => environmentNumber("QUEUE_LEASE_SECONDS", 300, 5);
const RETENTION_DAYS = () => environmentNumber("QUEUE_RETENTION_DAYS", 7, 0);
const SWEEP_MS = 30_000;
const MAX_WAIT_MS = 10 * 60_000;

/** Something that runs Drizzle SQL and returns rows (node-postgres or PGlite). */
interface Executor {
  execute(query: unknown): Promise<unknown>;
}

function rowsValue(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

// ═══════════════════════════════════════════════════════════════════════════
// DISPATCH
// ═══════════════════════════════════════════════════════════════════════════

/** The actor that is stored: whoever asks in the current request. */
function requestActor(): {
  userId: string | null;
  userRole: string | null;
  agentId: string | null;
  keyId: string | null;
} {
  const u = useRequest()?.user;
  if (!u?.id) return { userId: null, userRole: null, agentId: null, keyId: null };
  if (u.role === "agent") {
    return { userId: null, userRole: "agent", agentId: u.id, keyId: u.keyId ?? null };
  }
  return { userId: u.id, userRole: u.role ?? "user", agentId: null, keyId: null };
}

async function dispatch(
  queue: string,
  name: string,
  payload: unknown,
  options: DispatchOptions
): Promise<{ id: string }> {
  const id = randomUUID();
  const actor = requestActor();
  const delay = Math.max(0, Math.floor(options.delayMs ?? 0));
  const json = JSON.stringify(payload ?? {});
  // The agent's key travels inside request_id so as not to widen the table:
  // `<requestId>|key:<keyId>`. Only the worker reads it when re-reading the actor.
  const requestId = useRequest()?.requestId ?? null;
  const reference = actor.keyId ? `${requestId ?? ""}|key:${actor.keyId}` : requestId;

  const executor = resolveExecutor(db) as unknown as Executor;
  // No RETURNING: the application role only has INSERT (no SELECT).
  // `run_at` with Postgres's clock, the same one the claim uses.
  const when = delay > 0 ? sql`now() + (${delay} * interval '1 millisecond')` : sql`now()`;
  // Budget columns (migration 0069) only when the caller sets them: an ordinary
  // dispatch writes exactly what it wrote before.
  const cost =
    options.cost === undefined ? null : Math.max(0, Math.min(1_000_000, Math.floor(options.cost)));
  const policy =
    options.onBudgetExhausted === "fail" || options.onBudgetExhausted === "postpone"
      ? options.onBudgetExhausted
      : null;
  if (cost !== null || policy !== null) {
    await executor.execute(sql`
      INSERT INTO kitsuden_outbox
        (id, queue, name, payload, reason, user_id, user_role, agent_id, request_id, max_attempts, run_at, cost, budget_policy)
      VALUES
        (${id}, ${queue}, ${name}, ${json}::jsonb, ${options.reason ?? null}, ${actor.userId}, ${actor.userRole},
         ${actor.agentId}, ${reference}, ${options.attempts ?? 3}, ${when}, ${cost}, ${policy})
    `);
  } else {
    await executor.execute(sql`
      INSERT INTO kitsuden_outbox
        (id, queue, name, payload, reason, user_id, user_role, agent_id, request_id, max_attempts, run_at)
      VALUES
        (${id}, ${queue}, ${name}, ${json}::jsonb, ${options.reason ?? null}, ${actor.userId}, ${actor.userRole},
         ${actor.agentId}, ${reference}, ${options.attempts ?? 3}, ${when})
    `);
  }
  // pg-mem has no pg_notify, and in lite nobody listens.
  if (!isPgMem && !isLiteMode) {
    await executor.execute(sql`SELECT pg_notify(${CHANNEL}, ${queue})`);
  }
  // Outside a request it is already committed: wake the local worker
  // without waiting for the poll (in a request, NOTIFY will do it on commit).
  if (!useRequest()?.tx) setImmediate(() => worker?.wakeUp());
  return { id };
}

configureQueue({
  dispatch,
  onRegister: () => worker?.wakeUp(),
});

// ═══════════════════════════════════════════════════════════════════════════
// RE-READ THE ACTOR
// ═══════════════════════════════════════════════════════════════════════════

export type ReReadActor =
  | {
      ok: true;
      actor: JobActor | null;
      /** An agent's limits as of NOW (its daily budget is charged with the job's cost). */
      limits?: AgentLimits;
    }
  | { ok: false; reason: string };

export interface JobRow {
  id: string;
  queue: string;
  name: string;
  payload: unknown;
  user_id: string | null;
  user_role: string | null;
  agent_id: string | null;
  request_id: string | null;
  attempts: number;
  max_attempts: number;
  /** Migration 0069 (absent before it). */
  cost?: number | null;
  budget_policy?: string | null;
}

function agentKey(reference: string | null): string | null {
  const m = reference?.match(/\|key:(.+)$/);
  return m?.[1] ?? null;
}

async function rereadDefaultActor(row: JobRow): Promise<ReReadActor> {
  if (row.agent_id) {
    // Deferred import: agent-auth pulls in half the API and here it is only needed
    // when there really is a job from an agent.
    const { agentContextForApproval } = await import("../services/agent-auth");
    const r = await agentContextForApproval(row.agent_id, agentKey(row.request_id));
    if (!r.ok) return { ok: false, reason: r.reason };
    return {
      ok: true,
      actor: { id: r.context.agentId, role: "agent", scopes: r.context.scopes },
      limits: {
        agentId: r.context.agentId,
        rateLimit: null,
        writesPerDay: null,
        budgetUnitsPerDay: r.context.budgetUnitsPerDay ?? null,
      },
    };
  }
  if (row.user_id) {
    const [u] = await db
      .select({ role: authUsers.role })
      .from(authUsers)
      .where(eq(authUsers.id, row.user_id))
      .limit(1);
    if (!u) return { ok: false, reason: "user_not_found" };
    return { ok: true, actor: { id: row.user_id, role: u.role ?? "user" } };
  }
  return { ok: true, actor: null };
}

let rereadActor = rereadDefaultActor;

/** Tests only: replaces how the actor is re-read. */
export function setRereadActor(fn: typeof rereadDefaultActor | null): void {
  rereadActor = fn ?? rereadDefaultActor;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE AGENT'S BUDGET
// ═══════════════════════════════════════════════════════════════════════════

/** Queues of the system itself: never charged to an agent. */
export function systemQueue(queue: string): boolean {
  return queue.startsWith("kitsuden-");
}

/** What a job costs if its dispatch did not say (`QUEUE_AGENT_JOB_COST`, 1; 0 = free). */
function defaultJobCost(): number {
  const n = Number(process.env.QUEUE_AGENT_JOB_COST);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
}

function budgetPolicy(row: JobRow): "postpone" | "fail" {
  const v = row.budget_policy ?? process.env.QUEUE_BUDGET_EXHAUSTED;
  return v === "fail" ? "fail" : "postpone";
}

export type BudgetCharge =
  | { run: true; units: number }
  | { run: false; policy: "postpone" | "fail"; retryAfter: number; max: number; units: number };

/**
 * Charges the job's cost to the budget of the agent that queued it, at the moment
 * it runs (each attempt runs, each attempt pays). Nothing for people, the system,
 * `kitsuden-*` queues, a cost of 0 or an agent without a daily budget.
 */
export async function chargeJobBudget(
  row: JobRow,
  limits: AgentLimits | undefined,
  now = Date.now()
): Promise<BudgetCharge> {
  if (!row.agent_id || !limits || systemQueue(row.queue)) return { run: true, units: 0 };
  const units = row.cost === null || row.cost === undefined ? defaultJobCost() : row.cost;
  if (units <= 0) return { run: true, units: 0 };
  // Deferred: the quotas pull in the operations registry, only needed for an agent's job.
  const { consumeQuota } = await import("./agent-quotas");
  const r = await consumeQuota(limits, { request: false, write: false, units }, now);
  if (r.allowed) return { run: true, units };
  return {
    run: false,
    policy: budgetPolicy(row),
    retryAfter: r.retryAfter,
    max: r.max,
    units,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EL WORKER
// ═══════════════════════════════════════════════════════════════════════════

function retryWait(attempt: number): number {
  return Math.min(MAX_WAIT_MS, 2000 * 2 ** Math.max(0, attempt - 1));
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

class Worker {
  readonly id = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private inProgress = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private pumping = false;
  private anotherRound = false;
  private isStopped = false;
  /** Tests: no automatic wake-ups (only `oneRound`). */
  paused = false;
  private active = new Set<Promise<void>>();
  private stopListening: (() => Promise<void>) | null = null;

  constructor(
    private readonly base: Executor,
    private readonly forTransactions: TransactionalConnection,
    private readonly closePool: () => Promise<void>
  ) {}

  async start(): Promise<void> {
    this.timer = setInterval(() => this.wakeUp(), POLLING_MS());
    this.timer.unref?.();
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.sweepTimer.unref?.();
    if (!isLiteMode) {
      this.stopListening = await listen(CHANNEL, () => this.wakeUp()).catch(() => null);
    }
    await this.sweep();
    this.wakeUp();
  }

  /** Requests a claim round (those arriving at the same time are merged). */
  wakeUp(): void {
    if (this.isStopped || this.paused) return;
    if (this.pumping) {
      this.anotherRound = true;
      return;
    }
    this.pumping = true;
    void this.pump().finally(() => {
      this.pumping = false;
      if (this.anotherRound) {
        this.anotherRound = false;
        this.wakeUp();
      }
    });
  }

  private async pump(): Promise<void> {
    for (const [queue, { concurrency }] of queueHandlers()) {
      if (this.isStopped) return;
      const free = concurrency - (this.inProgress.get(queue) ?? 0);
      if (free <= 0) continue;
      let claimedItems: JobRow[];
      try {
        claimedItems = rowsValue(
          await this.base.execute(
            sql`SELECT * FROM kitsuden_queue_claim(ARRAY[${queue}]::text[], ${free}, ${LEASE_S()}, ${this.id})`
          )
        ) as unknown as JobRow[];
      } catch (err) {
        logger.warn({ err: errorText(err), queue }, "[queue] could not claim work");
        continue;
      }
      for (const row of claimedItems) this.launch(queue, row);
    }
  }

  private launch(queue: string, row: JobRow): void {
    this.inProgress.set(queue, (this.inProgress.get(queue) ?? 0) + 1);
    const task = this.run(queue, row).finally(() => {
      this.inProgress.set(queue, (this.inProgress.get(queue) ?? 1) - 1);
      this.active.delete(task);
      this.wakeUp();
    });
    this.active.add(task);
  }

  private async run(queue: string, row: JobRow): Promise<void> {
    const queueHandler = queueHandlers().get(queue);
    const start = Date.now();
    try {
      if (!queueHandler) throw new Error(`No handler for queue ${queue}`);
      const rereadValue = await rereadActor(row);
      if (!rereadValue.ok) {
        throw new PermanentError(`actor_revoked: ${rereadValue.reason}`);
      }
      // The agent pays for its job when it runs.
      const charge = await chargeJobBudget(row, rereadValue.limits);
      if (!charge.run) {
        const reason = `budget_exhausted: the agent's daily budget of ${charge.max} units is spent (this job costs ${charge.units})`;
        await registerAgentAction({
          agentId: row.agent_id,
          action: "job_budget_exhausted",
          resource: `${queue} ${row.name}`,
          resourceId: row.id,
          details: { policy: charge.policy, cost: charge.units, limit: charge.max },
          success: false,
          errorMessage: reason,
        }).catch(() => undefined);
        if (charge.policy === "fail") throw new PermanentError(reason);
        await this.base.execute(
          sql`SELECT kitsuden_queue_postpone(${row.id}::uuid, ${this.id}, ${charge.retryAfter}, ${`${reason}; postponed to the next UTC day`})`
        );
        logger.warn(
          {
            queue,
            jobId: row.id,
            jobName: row.name,
            agentId: row.agent_id,
            retryAfterS: charge.retryAfter,
          },
          "job postponed: the agent's budget is spent"
        );
        return;
      }
      const job: QueueJob = {
        id: row.id,
        queue,
        name: row.name,
        payload: row.payload,
        attempt: row.attempts,
        maxAttempts: row.max_attempts,
        actor: rereadValue.actor,
        requestId: row.request_id?.replace(/\|key:.+$/, "") || null,
      };
      await inRlsTransaction(this.forTransactions, rereadValue.actor, () => queueHandler.fn(job), {
        requestId: `job:${row.id}`,
      });
      await this.base.execute(sql`SELECT kitsuden_queue_complete(${row.id}::uuid, ${this.id})`);
      logger.info(
        { queue, jobId: row.id, jobName: row.name, attempt: row.attempts, ms: Date.now() - start },
        "job completed"
      );
    } catch (err) {
      const final = err instanceof PermanentError;
      const wait = Math.ceil(retryWait(row.attempts) / 1000);
      let status: unknown = null;
      try {
        const [r] = rowsValue(
          await this.base.execute(
            sql`SELECT kitsuden_queue_fail(${row.id}::uuid, ${this.id}, ${errorText(err)}, ${wait}, ${final}) AS status`
          )
        );
        status = r?.status ?? null;
      } catch (errOnClose) {
        logger.error(
          { err: errorText(errOnClose), jobId: row.id },
          "[queue] could not record the failure; the sweep will recover it"
        );
      }
      const level = status === "dead" ? "error" : "warn";
      logger[level](
        {
          queue,
          jobId: row.id,
          jobName: row.name,
          attempt: row.attempts,
          status,
          err: errorText(err),
        },
        status === "dead" ? "dead job (dead letter)" : "job failed; it will be retried"
      );
    }
  }

  /** One claim round, waiting for the claimed work to finish (tests). */
  async oneRound(): Promise<void> {
    await this.pump();
    await Promise.allSettled([...this.active]);
  }

  async sweep(): Promise<void> {
    try {
      const [r] = rowsValue(
        await this.base.execute(sql`SELECT kitsuden_queue_sweep(${RETENTION_DAYS()}) AS n`)
      );
      const n = Number(r?.n ?? 0);
      if (n > 0) {
        logger.warn({ orphans: n }, "[queue] jobs with an expired lease recovered");
        this.wakeUp();
      }
    } catch (err) {
      logger.warn({ err: errorText(err) }, "[queue] the sweep failed");
    }
  }

  async stop(waitMs = 10_000): Promise<void> {
    this.isStopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.stopListening?.().catch(() => {});
    // Whatever is running has a while to finish; what is not, will be
    // recovered by another process's sweep when the lease expires.
    await Promise.race([
      Promise.allSettled([...this.active]),
      new Promise((r) => setTimeout(r, waitMs).unref?.()),
    ]);
    await this.closePool();
  }
}

let worker: Worker | null = null;

// ═══════════════════════════════════════════════════════════════════════════
// THE MAIL QUEUE (compatibility with the previous name)
// ═══════════════════════════════════════════════════════════════════════════

export interface EmailJobData {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * What used to be the BullMQ queue. `add` no longer silently discards anything:
 * either it stays in the database (and in the request's transaction) or it throws.
 */
export const emailQueue = {
  async add(name: string, data: Record<string, unknown>) {
    return queue.dispatch(EMAIL_QUEUE, name, data);
  },

  async getWaitingCount() {
    const status = await queueStatus();
    return status.byQueue[EMAIL_QUEUE]?.pending ?? 0;
  },

  async getActiveCount() {
    const status = await queueStatus();
    return status.byQueue[EMAIL_QUEUE]?.running ?? 0;
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// PANEL AND HEALTH
// ═══════════════════════════════════════════════════════════════════════════

export interface QueueStatus {
  worker: "running" | "stopped" | "disabled";
  listens: boolean;
  byQueue: Record<string, Record<string, number>>;
  totals: Record<string, number>;
}

export async function queueStatus(): Promise<QueueStatus> {
  const { activeListening } = await import("./postgres-listen");
  const byQueue: Record<string, Record<string, number>> = {};
  const totals: Record<string, number> = {};
  if (!isPgMem) {
    const r = rowsValue(await db.execute(sql`SELECT * FROM kitsuden_queue_status()`));
    for (const f of r) {
      const queue = String(f.queue);
      const status = String(f.status);
      const n = Number(f.total ?? 0);
      (byQueue[queue] ??= {})[status] = n;
      totals[status] = (totals[status] ?? 0) + n;
    }
  }
  return {
    worker: isPgMem ? "disabled" : worker ? "running" : "stopped",
    listens: activeListening(),
    byQueue,
    totals,
  };
}

export async function deadJobs(limit = 50): Promise<Array<Record<string, unknown>>> {
  return rowsValue(await db.execute(sql`SELECT * FROM kitsuden_queue_dead(${limit})`));
}

export async function retryJob(id: string): Promise<boolean> {
  const [r] = rowsValue(await db.execute(sql`SELECT kitsuden_queue_retry(${id}::uuid) AS ok`));
  worker?.wakeUp();
  return r?.ok === true;
}

export async function discardJob(id: string): Promise<boolean> {
  const [r] = rowsValue(await db.execute(sql`SELECT kitsuden_queue_discard(${id}::uuid) AS ok`));
  return r?.ok === true;
}

// ═══════════════════════════════════════════════════════════════════════════
// STARTUP AND SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════

let workersInitialized = false;

/** Starts the queue worker (once per process). */
export async function setupWorkers(): Promise<void> {
  if (workersInitialized) return;
  workersInitialized = true;

  if (isPgMem) {
    logger.info(
      "[queue] pg-mem: no worker (it does not understand SKIP LOCKED); jobs are only stored"
    );
    return;
  }
  if (process.env.QUEUE_WORKER === "false") {
    logger.info("[queue] QUEUE_WORKER=false: this process only enqueues");
    return;
  }

  // eslint-disable-next-line import/no-cycle -- lazy on purpose: breaks the queue↔email cycle on static load
  const { registerEmailWorker } = await import("../jobs/email");
  registerEmailWorker();
  // Signed webhooks to agents when their proposal is resolved (B3).
  const { registerNotificationDelivery } = await import("./proposal-notifications");
  registerNotificationDelivery();
  // Embeddings for models with semantic search.
  const { registerModelEmbeddings } = await import("./model-embeddings");
  registerModelEmbeddings();
  // Second opinion on proposals: injection classifier.
  const { registerClassifier } = await import("./injection-classifier");
  registerClassifier();
  // Agent data ledger: later reviews of decided proposals become due.
  const { registerLedgerReviews } = await import("./ledger");
  registerLedgerReviews();

  if (isLiteMode) {
    // PGlite: a single connection; the worker uses the same database.
    const base = db as unknown as Executor & TransactionalConnection;
    worker = new Worker(base, base, async () => {});
  } else {
    const pool = withLazyTransactions(
      new pg.Pool({
        connectionString: process.env.QUEUE_DATABASE_URL || process.env.DATABASE_URL,
        max: environmentNumber("QUEUE_POOL_MAX", 3),
        idleTimeoutMillis: 30_000,
        application_name: "kitsuden-queue",
      })
    );
    pool.on("error", (err) => logger.warn({ err: err.message }, "[queue] pool error"));
    const queueDb = drizzle(pool, { schema: mergedSchema as Record<string, unknown> });
    worker = new Worker(
      queueDb as unknown as Executor,
      queueDb as unknown as TransactionalConnection,
      () => pool.end()
    );
  }
  await worker.start();
  logger.info(
    { worker: worker.id, queues: [...queueHandlers().keys()] },
    "[queue] Postgres worker running"
  );
}

export async function shutdownQueues(): Promise<void> {
  const t = worker;
  worker = null;
  // It can be started again (tests in the same process do so).
  workersInitialized = false;
  await t?.stop();
  const { closeListener } = await import("./postgres-listen");
  await closeListener();
}

/** Tests only: the worker stops waking itself (NOTIFY, polling, on dispatch). */
export function pauseWorker(paused: boolean): void {
  if (worker) worker.paused = paused;
}

/** Tests only: one claim round, waiting for what was claimed. */
export async function processPending(): Promise<void> {
  await worker?.oneRound();
}

/** Tests only: forces a sweep. */
export async function sweepNow(): Promise<void> {
  await worker?.sweep();
}
