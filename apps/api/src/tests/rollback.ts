/**
 * Tests with ROLLBACK per test
 * ============================================================================
 *
 *   import { itWithRollback } from "./rollback";
 *
 *   itWithRollback("creates a post", async (tx) => {
 *     await repo(blogPosts).create({ … });     // goes to `tx` through the request-scope
 *     await tx.insert(table).values({ … });    // or explicit
 *     expect(…);
 *   });                                         // ROLLBACK: nothing is left in the database
 *
 * The alternative to `clearTestData()` (`DELETE FROM` without WHERE on whole
 * tables): each test runs inside ONE transaction that is reverted when it
 * finishes. Faster (nothing to delete), and isolated (two files that
 * share tables do not step on each other). Measured in `rollback-per-test.test.ts`.
 *
 * What goes into the test's transaction:
 *   · `repo()`, `theRequestDb()` and the kons (they resolve through the request-scope).
 *   · An explicit `tx`.
 *   · A request `app.request(…)` that goes through `rlsTransaction`: the
 *     middleware sees there is already a transaction and does NOT open another. Its writes are
 *     reverted with the test.
 *
 * What does NOT go in (and that is why this does not replace everything):
 *   · The global `db` used directly (`db.insert(…)`): it goes to another connection
 *     of the pool and DOES get committed.
 *   · Nested savepoints (`tx.transaction`) work; a real COMMIT does not.
 *
 * DO NOT use it in tests that verify the real COMMIT: the request's
 * transaction (request-transaction.test.ts), the queue and its atomicity
 * (queue-postgres.test.ts), the RLS of a request with its own user
 * (inside a rollback test, the middleware reuses the test's context
 * instead of setting the request's: pass the user to `itWithRollback`).
 */

import { it } from "bun:test";

import { runInRequestScope } from "../../../../packages/engine/src/request-scope";
import {
  setRlsContext,
  type TransactionalConnection,
  type RlsUser,
} from "../../../../packages/engine/src/rls-request";
import { db, type DatabaseTransaction } from "../db";

const REVERT = Symbol("revert-test");

/**
 * Runs `fn` in a transaction that is ALWAYS reverted. `user` sets the
 * RLS context (by default, the system: empty id and role).
 */
export async function withRollback<T>(
  fn: (tx: DatabaseTransaction) => Promise<T>,
  user: RlsUser | null = null
): Promise<T> {
  let result: T | undefined;
  try {
    await db.transaction(async (tx) => {
      if (user) await setRlsContext(tx as unknown as TransactionalConnection, user);
      await runInRequestScope({ tx, user: null }, async () => {
        result = await fn(tx as unknown as DatabaseTransaction);
      });
      throw REVERT;
    });
  } catch (err) {
    if (err !== REVERT) throw err;
  }
  return result as T;
}

/** bun's `it` whose body runs in `withRollback`. */
export function itWithRollback(
  name: string,
  fn: (tx: DatabaseTransaction) => Promise<unknown>,
  options: { user?: RlsUser | null; timeout?: number } = {}
): void {
  it(
    name,
    async () => {
      await withRollback(async (tx) => {
        await fn(tx);
      }, options.user ?? null);
    },
    options.timeout
  );
}
