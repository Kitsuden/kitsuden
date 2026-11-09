/**
 * The store behind `ctx.effect()` (packages/engine/src/effects.ts)
 * ============================================================================
 *
 * Two SECURITY DEFINER functions (migration 0064): the application role does
 * not touch `kitsuden_action_effects` directly.
 *
 * It runs on `db`, NOT on the request's or the job's transaction
 * (`resolveExecutor`): a rollback after the effect must not erase that it
 * happened, or the retry would repeat it. In lite mode (PGlite, one
 * connection) there is no other connection, so it does share the transaction.
 */

import { sql } from "drizzle-orm";

import {
  configureEffects,
  type EffectDecision,
  type EffectStore,
} from "../../../../packages/engine/src/effects";
import { db } from "../db";

interface Executor {
  execute(query: unknown): Promise<unknown>;
}

function firstRow(result: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(result)) return result[0] as Record<string, unknown> | undefined;
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
}

const executor = db as unknown as Executor;

/**
 * The store itself, also used by the sandbox (`kitsuden.effect()` in panel-defined
 * code actions, lib/worker-sandbox.ts): the same table, the same two functions.
 */
export const effectStore: EffectStore = {
  async begin({ scope, key, jobId, staleAfterMs, retryUnknown }) {
    const row = firstRow(
      await executor.execute(sql`
        SELECT * FROM kitsuden_effect_begin(${scope}, ${key}, ${jobId}, ${staleAfterMs}, ${retryUnknown})
      `)
    );
    if (!row) throw new Error("kitsuden_effect_begin returned nothing");
    return {
      decision: row.decision as EffectDecision,
      result: row.result ?? null,
      attempts: Number(row.attempts),
    };
  },

  async finish({ scope, key, ok, result, error }) {
    await executor.execute(sql`
      SELECT kitsuden_effect_finish(${scope}, ${key}, ${ok}, ${JSON.stringify(result ?? null)}::jsonb, ${error})
    `);
  },
};

configureEffects(effectStore);
