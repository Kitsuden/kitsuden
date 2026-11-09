/**
 * The per-request RLS host, for the kons' test benches.
 * ============================================================================
 *
 * Kons no longer open their own RLS transaction: the host
 * opens it (module-loader mounts `withTransactionalRLS()` in front of each
 * router) and `ctx.db.instance` resolves to it within the request. Testing a
 * kon's router bare, without that, would be testing it WITHOUT context —like the
 * system— and every isolation test would pass green for the wrong reason.
 *
 * This mounts EXACTLY the same engine pieces the host uses
 * (`rlsTransaction`, `theRequestDb`, `asSystem`, `background`) on the
 * test database (PGlite with a non-superuser role), in the same order as
 * `src/index.ts`: first who is asking, then the transaction, then the kon.
 */

import { Hono, type MiddlewareHandler } from "hono";

import {
  asSystem,
  theRequestDb,
  background,
  rlsTransaction,
  type TransactionalConnection,
} from "../../../packages/engine/src/rls-request";

export function rlsHost<T extends object>(db: T, auth: { optionalAuth: MiddlewareHandler }) {
  const instance = theRequestDb(db);
  return {
    /** What goes into `createTestKonContext({ db })`. */
    db: {
      instance,
      execute: async (query: unknown) =>
        (instance as unknown as TransactionalConnection).execute(query),
      tableExists: async () => true,
      asSystem,
      background,
    },
    /** The kon's router, behind the session and the RLS transaction. */
    mount(router: Hono): Hono {
      const app = new Hono();
      app.use("*", auth.optionalAuth);
      app.use("*", rlsTransaction(db as unknown as TransactionalConnection));
      app.route("/", router);
      return app;
    },
  };
}
