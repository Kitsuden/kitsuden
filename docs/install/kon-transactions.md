# The request transaction in a kon

Every HTTP request to a kon runs inside **one Postgres transaction**. The host
opens it in front of the kon router (`rlsTransaction` in
`packages/engine/src/rls-request.ts`). It sets who is asking with
`set_config('app.current_user_id' | 'app.current_user_role', …, true)`, so
Row-Level Security applies to everything the kon reads or writes through
`ctx.db.instance`. A route that throws or answers 5xx is rolled back. Any
other answer is committed.

This page covers the three things that behave differently because of that,
what the host does for you, and what you still have to do in your routes.

## 1. Parallel queries (`Promise.all`)

A transaction is one connection, and one connection runs one statement at a
time. pg 8 queued overlapping `client.query()` calls internally and printed a
deprecation warning. pg 9 removes that queue.

**What the host does:** each request has its own FIFO queue. Every statement
on the request transaction waits for its turn before it reaches the driver.
`Promise.all` over queries is therefore safe and needs no change. It is not
faster either, because the queries run one after another on that connection.

Two operations are **exclusive sections**. Each holds the queue until it
finishes, and its own statements go through a child queue:

- `db.transaction(fn)`, which is a SAVEPOINT inside the request;
- `ctx.db.asSystem(fn)`, which switches to the system context.

Work running in parallel with them waits outside. It can never land inside
the savepoint, and it can never run as the system. One rule follows from
this: inside `fn`, do not await a promise created outside it that still has
queries to run. That promise is waiting for the same queue, so the request
deadlocks.

## 2. SQL errors you catch and ignore

Inside a transaction, a failed statement **aborts the whole transaction**:

- every later statement fails with `current transaction is aborted` (SQLSTATE
  `25P02`);
- if nothing else runs, Postgres turns the final `COMMIT` into a `ROLLBACK`
  without raising an error. Everything the request wrote is lost while the
  client receives `200`/`201`.

So `try { await db… } catch { /* keep going */ }` is wrong in a route. Wrap
the statement that is allowed to fail in a savepoint:

```ts
import { withSavepoint, attemptSql } from "@kitsuden/engine";

// Try and continue: on failure returns the default and the transaction stays usable.
const subs = await attemptSql(() => db.execute(sql`select … from pay_subscriptions`), null);

// Keep your own catch, but scope the failure to a savepoint.
try {
  await withSavepoint(() => db.insert(table).values(row));
} catch (err) {
  if (!isUniqueViolation(err)) throw err;
}
```

Outside a request (startup hooks, timers, `background`), both helpers just
run `fn`. Each statement there is autocommitted, so a failure cannot poison
anything. Plain `db.transaction((sp) => …)` is also a savepoint inside a
request and works the same way.

**Safety net:** the host checks the reply to `COMMIT`. If Postgres answered
`ROLLBACK`, it logs `[RLS] the request's transaction ended up aborted: nothing was saved` with
the route and the first SQL error. If the request was a write (not
GET/HEAD/OPTIONS) and was about to answer success, the response is replaced by
`500` with code `KITSUDEN_E_INTERNAL`. The client is told the truth, and an
`Idempotency-Key` retry stays possible. The fix is always in the route: find
the swallowed error and give it a savepoint.

## 3. Slow external calls while the transaction is open

The application role has `idle_in_transaction_session_timeout = 60s`. A
connection that waits more than 60 s inside a transaction is killed. The
request then fails, and so does everything it wrote.

**What the host does:** the transaction is **lazy**. `BEGIN` and the RLS
context are prepared but not sent. No connection is taken from the pool
until the first real query. A route that calls out before it touches the
database, or never touches it at all, holds no connection while it waits.

**What you do in the route:**

| Situation                                                             | Do this                                                                                                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The external call does not need data from the database                | Make it **before** the first query.                                                                                                                                                                    |
| The result is not needed for the response (mail, webhooks, analytics) | Run it **after** with `ctx.db.background(() => …)` and do not await it.                                                                                                                                |
| You need data first, then the call, then more queries                 | Put a **timeout** on the call that fits well under 60 s (`AbortSignal.timeout(…)`, the SDK timeout option). Several calls in a row must fit **together**.                                              |
| The call takes minutes (LLM, big imports)                             | Read what you need with `background` (outside the transaction, as the system, **after** authorizing). Then the request transaction is never opened. Or return `202` and do the work in the background. |

`background` runs as the **system**, not as the user, so authorize first.
It is also the only correct way to run work that outlives the response. A
query captured inside the request and run after it now fails with a clear
error. Before, it went to a connection that had already been returned to the
pool.

## Drivers

The lazy transaction and the per-query queue need the pg pool to be wrapped
with `withLazyTransactions(pool)`. `apps/api/src/db/index.ts` does that
for the production and test pools. With other drivers (PGlite in lite mode
and in the kon unit tests), the transaction opens eagerly as before. PGlite
serializes queries itself. The exclusive sections still serialize against
each other there, but a plain query running in parallel with `asSystem`
is not held back on PGlite.
