# Kitsuden behind PgBouncer (transaction mode)

Kitsuden works behind PgBouncer in **transaction** pooling mode. Every request
already runs in one transaction with its identity set by `set_config(…, true)`
(the function form of `SET LOCAL`), which dies with the transaction, so a
server connection can serve another client right after.

## What to point where

| Variable                                                            | Through PgBouncer? | Why                                                                                                                                                                     |
| ------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` (the API's requests)                                 | **yes**            | one transaction per request, context with `SET LOCAL`                                                                                                                   |
| `QUEUE_DATABASE_URL` (the queue worker's pool)                      | yes                | claims, closes and job transactions are short transactions                                                                                                              |
| `DATABASE_LISTEN_URL`                                               | **no, direct**     | `LISTEN` is session state; through PgBouncer the queue's and realtime's `NOTIFY` never arrive. The queue still works (it polls every `QUEUE_POLL_MS`), only slower      |
| `DATABASE_ADMIN_URL` / `DATABASE_DDL_URL` (migrations, runtime DDL) | **no, direct**     | the migration runner takes a session `pg_advisory_lock`; in transaction mode the lock and its unlock can land on different server connections and the lock is left held |

## What was checked (2026-10-28)

`apps/api/scripts/test-pgbouncer.ts` runs Kitsuden's real code (the lazy RLS
transaction, Drizzle, the queue functions) through PgBouncer:

```bash
pnpm test:db:up        # creates .env.test from .env.test.example if needed
docker compose -f docker-compose.pgbouncer-test.yml --env-file .env.test up -d
cd apps/api && bun --no-env-file scripts/test-pgbouncer.ts
```

| Check                                                                                 | Expected                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 40 RLS transactions at once on fewer server connections, each reads only its own user | ✓                                                                                                                                                                                                          |
| After commit, no context is left on the connection                                    | ✓ (`SET LOCAL`)                                                                                                                                                                                            |
| Drizzle parameterized queries                                                         | ✓ node-postgres sends **unnamed** prepared statements (extended protocol), which transaction mode supports                                                                                                 |
| Named prepared statements (`.prepare("x")`)                                           | may fail with `MAX_PREPARED_STATEMENTS=0`; Kitsuden does not use them (audited: no `.prepare(` in the API, engine, core or kons). PgBouncer ≥ 1.21 with `max_prepared_statements > 0` supports them anyway |
| A session `SET` (without `LOCAL`)                                                     | leaks to other clients: never use it; use `set_config(…, true)`                                                                                                                                            |
| `LISTEN` through PgBouncer                                                            | does not receive: use `DATABASE_LISTEN_URL` direct                                                                                                                                                         |
| Queue: dispatch in a transaction, two concurrent claims with `SKIP LOCKED`            | ✓ no job taken twice                                                                                                                                                                                       |

**Run through a real PgBouncer on 2026-10-29** (`edoburu/pgbouncer:v1.24.1-p1`,
PgBouncer 1.24.1, `pool_mode=transaction`, `default_pool_size=5`, in front of
the test Postgres): all checks pass, twice:

- `MAX_PREPARED_STATEMENTS=0`: named prepared statements fail as expected
  (`prepared statement "…" already exists`, because the statement
  stayed on a server connection that another client got).
- `PGBOUNCER_MAX_PREPARED=200`: named prepared statements work too.

In both runs a session `SET` leaked to another transaction and `LISTEN`
through PgBouncer got nothing. Both results were expected, and they are why the
two rules below exist.

## Rules for code (so it stays compatible)

- Context per transaction only: `set_config('app.…', value, true)`. Never
  `SET` without `LOCAL`, never `SET ROLE`/`search_path` at session level.
- No session advisory locks (`pg_advisory_lock`) on the request pool; use
  `pg_advisory_xact_lock` inside a transaction.
- No temporary tables that outlive a transaction, no `WITH HOLD` cursors.
- No named prepared statements on the request pool.
- Anything that needs a session (`LISTEN`, the migration lock) uses its own
  direct connection.

## PgBouncer settings

```ini
pool_mode = transaction
default_pool_size = 20          ; per database/user pair
max_client_conn = 500
server_reset_query =            ; empty in transaction mode
max_prepared_statements = 0     ; Kitsuden does not need them
```

The application role's `statement_timeout` and
`idle_in_transaction_session_timeout` (set with `ALTER ROLE` by the startup
script) still apply: they are set per role on each server connection.
