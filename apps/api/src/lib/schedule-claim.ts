/**
 * One replica per scheduled tick
 * ============================================================================
 *
 * Every API process runs the same timers. Before a timer does its work it claims the tick: the first
 * process to record (key, tick) in `kitsuden_schedule_ticks` (migration 0091) wins, the others skip. The
 * tick is the instant the cron expression scheduled, truncated to its own precision, so every replica
 * computes the same one even when their timers fire a few milliseconds apart.
 *
 * Without the table (an unmigrated database) or on pg-mem, which runs no plpgsql, the claim is granted:
 * one process is what those setups run anyway, and a missed tick would be worse than a doubled one there.
 */

import { hostname } from "node:os";

import { sql } from "drizzle-orm";

import { db, isPgMem } from "../db";

import { logger } from "./logger";

const PROCESS = `${hostname()}:${process.pid}`;

/**
 * The scheduled instant of a tick that fires `now`: truncated to the second for a 6-field expression
 * (seconds first), to the minute for a 5-field one.
 */
export function tickOf(now: Date, expression: string): Date {
  const fields = expression.trim().split(/\s+/).length;
  const t = new Date(now.getTime());
  t.setUTCMilliseconds(0);
  if (fields < 6) t.setUTCSeconds(0);
  return t;
}

/** Whether this process runs the tick `at` of `key`. */
export async function claimTick(key: string, at: Date): Promise<boolean> {
  if (isPgMem) return true;
  try {
    const result = await db.execute<{ claimed: boolean }>(
      sql`SELECT kitsuden_schedule_claim(${key}, ${at.toISOString()}::timestamptz, ${PROCESS}) AS claimed`
    );
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{
      claimed: boolean;
    }>;
    return rows[0]?.claimed === true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // An unmigrated database: behave as before (every process runs it), and say so.
    if (/kitsuden_schedule_claim/.test(message) && /does not exist/.test(message)) {
      logger.warn({ key }, "[schedule] migration 0091 missing: the tick runs without a claim");
      return true;
    }
    // Any other failure (the database down): nobody can claim, so nobody runs it twice.
    logger.warn({ key, err: message }, "[schedule] could not claim the tick: skipped");
    return false;
  }
}
