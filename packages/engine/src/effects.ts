/**
 * External effects, at most once
 * ============================================================================
 *
 * The queue delivers at least once: a `run` that throws after sending an email
 * is retried and sends it again. `ctx.effect(key, fn)` runs `fn` once per key:
 *
 *   await ctx.effect(`welcome:${userId}`, () => mail.send(...));
 *
 * - The first call runs `fn` and records its result.
 * - A later call with the same key (a retry, or another job) returns that
 *   result without running `fn`.
 * - If `fn` throws, nothing is recorded as done: the next call runs it again.
 * - If the process died while `fn` was running, nobody knows whether it
 *   happened. The call then throws a `PermanentError` (the job goes to the dead
 *   letter for a person to look at), unless the action passed `retryUnknown`.
 *
 * The record is written outside the job's transaction, so a rollback after
 * the effect does not erase it. The key belongs to the action (its trigger),
 * so two actions do not share keys. The result must be JSON.
 *
 * The host (apps/api/src/lib/effects.ts) plugs in the store with
 * `configureEffects()` at startup.
 */

import { PermanentError } from "./queue";

export interface EffectOptions {
  /**
   * Run `fn` again when an earlier attempt was left unfinished (the process
   * died midway). Only for effects that are harmless to repeat. Default: false.
   */
  retryUnknown?: boolean;
  /**
   * How long a running effect may take before it counts as unfinished.
   * Default: 10 minutes.
   */
  staleAfterMs?: number;
}

export type EffectDecision = "run" | "done" | "busy" | "unknown";

/** What the host puts behind `ctx.effect()`. */
export interface EffectStore {
  begin(input: {
    scope: string;
    key: string;
    jobId: string | null;
    staleAfterMs: number;
    retryUnknown: boolean;
  }): Promise<{ decision: EffectDecision; result: unknown; attempts: number }>;
  finish(input: {
    scope: string;
    key: string;
    ok: boolean;
    result: unknown;
    error: string | null;
  }): Promise<void>;
}

/** Another worker is running the same effect: the job is retried later. */
export class EffectBusyError extends Error {
  constructor(key: string) {
    super(`The effect "${key}" is running in another job right now; this job will retry it`);
    this.name = "EffectBusyError";
  }
}

const DEFAULT_STALE_MS = 10 * 60_000;
const MAX_KEY = 500;

let store: EffectStore | null = null;

/** The host plugs in its implementation (once, at startup). */
export function configureEffects(next: EffectStore | null): void {
  store = next;
}

/** Runs `fn` at most once for (`scope`, `key`). See the header. */
export async function runEffect<T>(
  scope: string,
  key: string,
  fn: () => Promise<T> | T,
  options: EffectOptions & { jobId?: string | null } = {}
): Promise<T> {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY) {
    throw new TypeError(`The effect key must be a string of 1 to ${MAX_KEY} characters`);
  }
  if (!store) {
    throw new Error("Effects are not configured: the host must call configureEffects() at startup");
  }
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_MS;
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 1000) {
    throw new RangeError("`staleAfterMs` must be an integer of at least 1000");
  }

  const begun = await store.begin({
    scope,
    key,
    jobId: options.jobId ?? null,
    staleAfterMs,
    retryUnknown: options.retryUnknown === true,
  });
  if (begun.decision === "done") return begun.result as T;
  if (begun.decision === "busy") throw new EffectBusyError(key);
  if (begun.decision === "unknown") {
    throw new PermanentError(
      `The effect "${key}" was left unfinished by an earlier attempt, so it may or may not ` +
        `have happened. It is not run again on its own: check it, or pass { retryUnknown: true } ` +
        `if repeating it is harmless.`
    );
  }

  let result: T;
  try {
    result = await fn();
  } catch (err) {
    await store.finish({
      scope,
      key,
      ok: false,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  await store.finish({ scope, key, ok: true, result: result ?? null, error: null });
  return result;
}
