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
 *   · NOT TWICE, IF ASKED. With `dedupeKey`, a dispatch while a job with the
 *     same key is pending or running on that queue queues nothing and answers
 *     the id of that job (`deduplicated: true`).
 *
 * ── LANES ──────────────────────────────────────────────────────────────────
 *
 * A lane is a queue: each has its own handler and its own `concurrency`, and
 * a slow one does not hold the others back. A kon that needs "work that calls
 * a model" apart from "work that does not" registers two queues. A queue may
 * also accept jobs from automation rules (`rules` in `handle`): the step
 * `core:enqueue` only reaches queues that said so.
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
  /**
   * Do not queue this twice: while a job with this key is pending or running on
   * the same queue, the dispatch queues nothing and answers that job's id with
   * `deduplicated: true`. Free again once that job is done or dead. Up to 200
   * characters; the kon chooses it (`identify:contact:42`).
   */
  dedupeKey?: string;
}

/** What a dispatch answers. */
export interface DispatchResult {
  id: string;
  /** `true` when a job with the same `dedupeKey` was already waiting: `id` is that one. */
  deduplicated?: boolean;
}

/** How a queue presents itself to whoever writes an automation rule. */
export interface QueueRuleEntry {
  label: string;
  description: string;
  /** The fields the handler expects in the payload, each with what it is. */
  payload?: Record<string, string>;
}

export interface HandlerOptions {
  /** Jobs from this queue at a time in this process. Defaults to 3. */
  concurrency?: number;
  /**
   * Accept jobs from automation rules (the step `core:enqueue`). Without it a
   * rule cannot reach this queue: a queue's payload is its handler's private
   * contract unless the handler opens it.
   */
  rules?: QueueRuleEntry;
  /**
   * Kons that may queue jobs here besides the one that handles it (docs/kons/queues.md): kon ids
   * (`kon-koe`), short ids (`koe`) or `"*"` for any kon. Without it only the handling kon does. It
   * never lets another kon handle the queue, and the core's own queues ignore it.
   */
  senders?: string[];
}

/** What the host puts behind `queue.dispatch()`. */
export interface QueueEngine {
  dispatch(
    queue: string,
    name: string,
    payload: unknown,
    options: DispatchOptions
  ): Promise<DispatchResult>;
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
interface RegisteredQueue {
  fn: QueueHandler;
  concurrency: number;
  rules?: QueueRuleEntry;
}
const handlers = new Map<string, RegisteredQueue>();

/** The host plugs in its implementation (once, at startup). */
export function configureQueue(next: QueueEngine | null): void {
  engine = next;
  if (next) for (const queue of handlers.keys()) next.onRegister?.(queue);
}

/** The registered handlers (for the host's worker). */
export function queueHandlers(): ReadonlyMap<string, RegisteredQueue> {
  return handlers;
}

/** The queues that accept jobs from automation rules, with how they present themselves. */
export function ruleQueues(): Array<{ queue: string } & QueueRuleEntry> {
  return [...handlers.entries()]
    .filter(([, h]) => h.rules)
    .map(([name, h]) => ({ queue: name, ...h.rules! }));
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
  ): Promise<DispatchResult> {
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
    if (options.dedupeKey !== undefined) {
      const key = options.dedupeKey;
      if (typeof key !== "string" || key.length < 1 || key.length > 200) {
        throw new RangeError("`dedupeKey` must be a string of 1 to 200 characters");
      }
    }
    return engine.dispatch(queue, name, payload, { ...options, attempts });
  },

  /** Registers a queue's handler (one per queue and process). */
  handle<T>(queue: string, fn: QueueHandler<T>, options: HandlerOptions = {}): void {
    validateName("Name", queue);
    const concurrency = Math.max(1, Math.min(50, Math.floor(options.concurrency ?? 3)));
    handlers.set(queue, { fn: fn as QueueHandler, concurrency, rules: options.rules });
    engine?.onRegister?.(queue);
  },

  /** Is an engine connected? */
  configured(): boolean {
    return engine !== null;
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// THE QUEUE AS KONS SEE IT (docs/kons/queues.md)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * How the host checks what a kon does with the queue (apps/api/src/lib/queue-kon-access.ts). Each
 * method answers the queue name to use, or throws to refuse.
 */
export interface KonQueueGuard {
  /** A kon registers a handler: the name it is registered under, and the handler to register. */
  handle(
    queue: string,
    fn: QueueHandler,
    options: HandlerOptions
  ): { queue: string; fn: QueueHandler };
  /** A kon queues a job: the name it is queued on. */
  dispatch(queue: string): string;
}

let konGuard: KonQueueGuard | null = null;

/** The host plugs in its kon checks (once, when it binds the first kon). */
export function configureKonQueueGuard(next: KonQueueGuard | null): void {
  konGuard = next;
}

/**
 * The `queue` that `@kitsuden/engine` hands kons. The same API as `queue`, but every name goes
 * through the host's guard: a kon handles and queues only inside its own namespace, never on a core
 * queue, and on another kon's queue only when that kon (or the core) allows it. Without a guard
 * (a kon's own tests, the engine on its own) it is the plain queue. The core's code imports
 * `queue` from this file, not from the package, and is not checked.
 */
export const konQueue = {
  async dispatch<T>(
    queueName: string,
    name: string,
    payload: T,
    options: DispatchOptions = {}
  ): Promise<DispatchResult> {
    const target = konGuard ? konGuard.dispatch(queueName) : queueName;
    return queue.dispatch(target, name, payload, options);
  },

  handle<T>(queueName: string, fn: QueueHandler<T>, options: HandlerOptions = {}): void {
    if (!konGuard) return queue.handle(queueName, fn, options);
    const checked = konGuard.handle(queueName, fn as QueueHandler, options);
    queue.handle(checked.queue, checked.fn, options);
  },

  configured(): boolean {
    return queue.configured();
  },
};
