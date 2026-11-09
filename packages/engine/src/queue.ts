/**
 * Kitsuden — The job queue (the engine's seam)
 * ============================================================================
 *
 *   await queue.dispatch("kitsuden-email", "system.welcome", { to, name });
 *
 *   queue.handle("reports", async (job) => {
 *     await generateReport(job.payload);       // idempotent
 *   }, { concurrency: 2 });
 *
 * A single engine: Postgres (BullMQ was removed).
 * The host (apps/api/src/lib/queue.ts) wires it up with `configureQueue()` at
 * startup. There is deliberately no driver system: this is the seam in case
 * another one is ever needed, not an invitation to write it.
 *
 * ── WHAT IT PROMISES ───────────────────────────────────────────────────────
 *
 *   · ATOMICITY. Inside a request, `dispatch` writes in the SAME RLS
 *     transaction: if the request ends in ROLLBACK, the job does not exist;
 *     if it commits, the job is ready. Outside a request, it commits right away.
 *   · AT LEAST ONCE. A worker that dies midway leaves the job with an expired
 *     lease and the sweep returns it to the queue: the handler may run twice.
 *     Handlers must be IDEMPOTENT.
 *   · THE ACTOR IS RE-READ. Who enqueued it (person or agent) is stored; on
 *     execution their permissions are re-read, and the handler runs with that
 *     actor's RLS exactly as it is NOW. Revoked or deleted: the job dies
 *     without running.
 *   · RETRIES AND DEAD LETTER. A handler that throws is retried with
 *     exponential backoff up to `attempts` (3 by default). Once exhausted, or
 *     with a `PermanentError`, the job is left `dead` with its error, visible
 *     in the panel (`/api/admin/queue`) to retry or discard.
 *
 * Registrations (`handle`) are kept here even if the host has not started its
 * worker yet: a kon can register when it loads.
 */

/** Who enqueued the job, as seen AT EXECUTION time (re-read). */
export interface JobActor {
  /** Id of the account or agent. */
  id: string;
  /** `agent` for an agent; the account's role (re-read) for a person. */
  role: string;
  /** Current scopes of an agent. */
  scopes?: string[];
}

export interface QueueJob<T = unknown> {
  id: string;
  queue: string;
  /** Name of the job within the queue (the Mailable, in the mail queue). */
  name: string;
  payload: T;
  /** Current attempt, starting at 1. */
  attempt: number;
  maxAttempts: number;
  /** `null` = enqueued by the system (no request, cron, startup). */
  actor: JobActor | null;
  requestId: string | null;
}

export type QueueHandler<T = unknown> = (job: QueueJob<T>) => Promise<unknown>;

export interface DispatchOptions {
  /** Why this job was queued, for whoever reads the queue later. */
  reason?: string;
  /** Maximum attempts (1–25). Defaults to 3. */
  attempts?: number;
  /** Do not run before this delay. */
  delayMs?: number;
  /**
   * Budget units this job costs when it runs, charged to the daily budget of the
   * AGENT that queued it (`QUEUE_AGENT_JOB_COST`, 1, when absent; 0 = free). Jobs of
   * people, of the system and on `kitsuden-*` queues are never charged.
   */
  cost?: number;
  /**
   * When that agent's budget is spent: `postpone` (to the next UTC day, without
   * using an attempt) or `fail` (dead letter with the reason). Defaults to
   * `QUEUE_BUDGET_EXHAUSTED`, `postpone`.
   */
  onBudgetExhausted?: "postpone" | "fail";
}

export interface HandlerOptions {
  /** Jobs from this queue at a time in this process. Defaults to 3. */
  concurrency?: number;
}

/** What the host puts behind `queue.dispatch()`. */
export interface QueueEngine {
  dispatch(
    queue: string,
    name: string,
    payload: unknown,
    options: DispatchOptions
  ): Promise<{ id: string }>;
  /** Called when a handler is registered (so the worker picks it up). */
  onRegister?(queue: string): void;
}

/**
 * Throw it from a handler to NOT retry: the job goes to `dead` right
 * away (invalid data, nonexistent recipient…).
 */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

const VALID_NAME = /^[A-Za-z0-9_.:\-]{1,120}$/;

let engine: QueueEngine | null = null;
const handlers = new Map<string, { fn: QueueHandler; concurrency: number }>();

/** The host plugs in its implementation (once, at startup). */
export function configureQueue(next: QueueEngine | null): void {
  engine = next;
  if (next) for (const queue of handlers.keys()) next.onRegister?.(queue);
}

/** The registered handlers (for the host's worker). */
export function queueHandlers(): ReadonlyMap<string, { fn: QueueHandler; concurrency: number }> {
  return handlers;
}

function validateName(type: string, value: string): void {
  if (!VALID_NAME.test(value)) {
    throw new TypeError(
      `${type} of the queue is invalid: "${value}" (letters, digits and _.:- up to 120)`
    );
  }
}

export const queue = {
  /**
   * Enqueues a job. Inside a request it goes in its transaction (see the
   * header); the payload must be JSON.
   */
  async dispatch<T>(
    queue: string,
    name: string,
    payload: T,
    options: DispatchOptions = {}
  ): Promise<{ id: string }> {
    validateName("Name", queue);
    validateName("Job", name);
    if (!engine) {
      throw new Error(
        "The queue is not configured: the host must call configureQueue() at startup"
      );
    }
    const attempts = options.attempts ?? 3;
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 25) {
      throw new RangeError("`attempts` must be an integer between 1 and 25");
    }
    return engine.dispatch(queue, name, payload, { ...options, attempts });
  },

  /** Registers a queue's handler (one per queue and process). */
  handle<T>(queue: string, fn: QueueHandler<T>, options: HandlerOptions = {}): void {
    validateName("Name", queue);
    const concurrency = Math.max(1, Math.min(50, Math.floor(options.concurrency ?? 3)));
    handlers.set(queue, { fn: fn as QueueHandler, concurrency });
    engine?.onRegister?.(queue);
  },

  /** Is an engine connected? */
  configured(): boolean {
    return engine !== null;
  },
};
