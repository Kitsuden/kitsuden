/**
 * Kitsuden — The "glass box" of a request
 * ============================================================================
 *
 * What the host needs to write each request's trace without extra
 * queries:
 *
 *   · MEASUREMENTS of the request's transaction: how many queries, how much
 *     time in the database and how many rows the writes touched. They are
 *     recorded by the lazy connection of `rls-request.ts` as each query passes.
 *   · BLOCKS: a write (`UPDATE`/`DELETE … WHERE id`) that touched no rows.
 *     There are three walls —the operation's permission, the handler's owner
 *     filter and RLS— and the handler's filter acts BEFORE RLS, so "rows
 *     filtered by RLS" would almost always be 0. What is useful is "blocked by
 *     the owner filter or by RLS", and it is measured like this:
 *     0 rows → a `SELECT EXISTS` by id AS THE SYSTEM to tell
 *     "does not exist" from "is not yours".
 *
 * The result goes ONLY to the trace (audit). The caller receives the same in
 * both cases (the usual 404): returning it would be an existence oracle. Reads
 * are NOT measured by default: counting rows "before RLS" would require
 * dynamic SQL with elevated privileges.
 */

import { DB_METRICS_SERVICE, useRequest } from "./request-scope";
import { asSystem } from "./rls-request";

export interface MeasuresDb {
  /** Queries that went to the database in the request's transaction. */
  queries: number;
  /** Milliseconds waiting on the database (sum of the queries). */
  ms: number;
  /** Rows touched by INSERT/UPDATE/DELETE. */
  rows: number;
}

export interface AnnotatedBlocking {
  table: string;
  operation: "update" | "delete";
  /** `not_yours` = it exists, but the owner filter or RLS set it aside. */
  reason: "not_yours" | "not_found";
}

const MEASURES_KEY = DB_METRICS_SERVICE;
const BLOCKINGS_KEY = "kitsuden.denials";

function services(): Record<string, unknown> | null {
  const scope = useRequest();
  if (!scope) return null;
  scope.services ??= {};
  return scope.services;
}

/** The measurements of the current request (created empty the first time). */
export function requestMeasures(): MeasuresDb | null {
  const s = services();
  if (!s) return null;
  return (s[MEASURES_KEY] ??= { queries: 0, ms: 0, rows: 0 }) as MeasuresDb;
}

export function requestBlockings(): AnnotatedBlocking[] {
  return (services()?.[BLOCKINGS_KEY] as AnnotatedBlocking[] | undefined) ?? [];
}

export function annotateBlocking(blocking: AnnotatedBlocking): void {
  const s = services();
  if (!s) return;
  ((s[BLOCKINGS_KEY] ??= []) as AnnotatedBlocking[]).push(blocking);
}

/**
 * For a handler that did its own `UPDATE/DELETE … WHERE id` and touched
 * nothing: finds out (as the system) whether the row exists and records it. Only in a
 * request from someone (the system has nobody to block). It does not change
 * what the handler responds.
 */
export async function checkLock(
  table: string,
  operation: AnnotatedBlocking["operation"],
  exists: () => Promise<boolean>
): Promise<void> {
  const scope = useRequest();
  if (!scope?.user?.id) return;
  try {
    const has = await asSystem(exists);
    annotateBlocking({ table, operation, reason: has ? "not_yours" : "not_found" });
  } catch {
    // The trace is an extra: it never breaks the request.
  }
}
