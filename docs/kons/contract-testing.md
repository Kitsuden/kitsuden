# Contract testing with Schemathesis

Every kon SDK operation declares its input, its output and the errors it can
return (`defineOperation`, see [the kon SDK](./README.md)). Kitsuden turns
those declarations into OpenAPI 3.1, and
[Schemathesis](https://github.com/schemathesis/schemathesis) (MIT) attacks
that contract: thousands of requests generated from the schemas, valid and
invalid, against the real app.

It fails on:

| Check                         | Meaning                                             |
| ----------------------------- | --------------------------------------------------- |
| `not_a_server_error`          | the operation answered 5xx                          |
| `status_code_conformance`     | it answered a status the operation does not declare |
| `content_type_conformance`    | the body type is not the declared one               |
| `response_schema_conformance` | the body does not match the declared output schema  |

Schemathesis is **not** a Kitsuden dependency. It runs with
[`uvx`](https://docs.astral.sh/uv/) at a pinned version
(`VERSION_SCHEMATHESIS` in `apps/api/scripts/schemathesis.ts`), only on a
developer machine or in CI.

## Run it

Only against a **test** database (it creates users and sends random
`POST`/`PUT`/`DELETE`): the script refuses to run without `NODE_ENV=test`,
`KITSUDEN_TEST_DB=postgres` and a database whose name contains `test`, and it
blocks every outgoing request to a non-local host.

```bash
pnpm test:db:up
cd apps/api
NODE_ENV=test KITSUDEN_TEST_DB=postgres DATABASE_URL=<test db> REDIS_URL=<test valkey> bun run test:schemathesis
```

What it does:

1. turns on every installed kon in `modules`;
2. mounts the real app (`src/index.ts`) with the rate limiter off
   (`RATE_LIMIT_ENABLED=false`) and serves it on `127.0.0.1`;
3. writes `apps/api/.schemathesis/openapi.json` with the SDK operations;
4. signs in as a fresh admin and runs Schemathesis (phases `examples`,
   `coverage`, `fuzzing`, fixed seed);
5. writes JUnit and NDJSON reports to `apps/api/.schemathesis/`.

Options (some flag names are Spanish): `--only=<regex>` (only matching paths),
`--examples=<n>` (examples: fuzzing cases per operation, default 25),
`--spec-only` (spec only: write the OpenAPI and exit), `--baseline-update`
(accept this run's failures).

Left out on purpose:

- what touches the disk, the repository or the process (the
  `DO_NOT_RUN_WITH_PERMISSION` list of the authorization matrix) and multipart
  uploads;
- operations that only work by calling an outside service
  (the external-service list in the script), which is cut off here.

Do **not** run it at the same time as the API integration suite: its
`clearTestData()` deletes every dataset of the test database halfway through
the run.

## The baseline

`apps/api/schemathesis-baseline.json` lists the failures already known. They
are reported but do not fail the run: CI fails only on a **new** one. A run
never edits the file unless asked:

- after fixing a failure, run with `--baseline-prune` and commit the file;
- to accept a failure on purpose, run with `--baseline-update` and commit it.

Some failures depend on the generated data and on what earlier runs left in
the database, so they come and go between runs. Build the baseline the way CI
runs: several passes with `--baseline-update`, each on a freshly created and
migrated test database, never on one with leftovers.

The baseline is **empty**: the 21 failures of the first run (unhandled Postgres
input errors, a broken index query, a search that never worked with the `pg`
driver, contracts that did not declare what handlers return) were fixed. Two layers keep that class closed for every operation:

- the SDK rejects text with U+0000 (which Postgres cannot store) in params,
  query and JSON body before the handler runs (`422`);
- `toErrorEnvelope` turns a Postgres error that is the input's fault into a
  client error without the query text: SQLSTATE class 22 → `400`,
  `23505`/`23503` → `409`, `23502`/`23514` → `422`.

## In CI

The `schemathesis` job in `.github/workflows/ci.yml` runs on its own Postgres
service (never the one of the integration suite) and uploads
`apps/api/.schemathesis/` as an artifact. It is **non-blocking for now**
(`continue-on-error`): it generates random requests, so a run can fail on a new
input with no code change, and it has not been stable long enough to gate
merges. Treat a failure as a real 500 or a broken contract: fix it, or accept it
on purpose with `--baseline-update`. In CI only the core kons are installed (the
others live in the kons repository); baseline entries for operations a run does
not reach are kept.

A kons repository tests its own kons. The way to do it is to install every kon
by path (`KITSUDEN_KONS`), migrate them on a database whose name contains
`test`, and run the same script with `--only-installed` ("installed only": the
SDK operations of the installed, non-core kons) and `--baseline=<its own file>`
(a `schemathesis-baseline.json` at that repository's root). Only kons whose
routes are SDK operations can be tested this way: a legacy kon declares no
input or output schema, so there is nothing to check its responses against.
Migrating a kon to the SDK is what brings it under contract testing.
