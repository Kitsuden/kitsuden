# Contributing to Kitsuden

Thanks for helping. Bug reports, fixes and documentation are all welcome. For a larger
change, please open an issue first so we can agree on the approach.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Setup

You need Node 22, pnpm 9, [Bun](https://bun.sh) and Docker.

```bash
git clone https://github.com/Kitsuden/kitsuden.git
cd kitsuden
pnpm install --frozen-lockfile
pnpm test:db:up
```

`pnpm test:db:up` starts a disposable Postgres on port 5434 and Valkey on port 6380, creates
`.env.test` from `.env.test.example` if it is missing, and migrates the test database. To
migrate again later: `pnpm test:db:migrate`. Do not run `apps/api/scripts/migrate.ts` by hand with
`NODE_ENV=test` and no database settings: it needs `DATABASE_URL`, which only these commands
read from `.env.test`.

If the migration says «password authentication failed», the test volume was created with other
credentials than `.env.test`. It holds only test data: `pnpm test:db:down --nuke`, then
`pnpm test:db:up`.

## Checks

Run these before opening a pull request. CI runs the same ones.

```bash
pnpm typecheck:all
pnpm lint
pnpm test:unit      # vitest suite in tests/unit
pnpm test:api       # API suite on real Postgres; needs pnpm test:db:up
```

`pnpm test:api` and `pnpm --dir apps/api test` read `.env.test` by themselves and apply any
pending migration first. A variable already set in your environment wins, which is how CI
passes its own. For one file, from `apps/api`:
`node ../../scripts/test-db.mjs exec -- bun test src/tests/auth.test.ts`.

The test suites delete whole tables, and refuse to run against a database whose name does
not contain `test`. Never point them at a database you care about.

## Conventions

- **Tests:** a bug fix comes with a test that fails without it. Tests that use the full
  stack belong in `tests/unit`, not `bun test`, because Bun's `mock.module` leaks across
  files.
- **Migrations:** never edit a migration that has shipped. The runner records a checksum of
  each file, so add a new one instead. If a change touches row-level security, update
  `apps/api/src/db/rls-policies.sql` too.
- **Validation:** new routes declare themselves with `defineOperation` so that REST, OpenAPI,
  MCP and authorization come from one declaration.
- **Kons:** optional modules live in the
  [kitsuden-kons](https://github.com/Kitsuden/kitsuden-kons) repository, not here.
- **Commits:** short imperative subject (`fix(api): reject placeholder secrets`). Hooks run
  lint-staged on commit.

Code, comments, docs and API messages are in English. The admin panel's interface text goes
through `packages/admin/src/lib/i18n`, with a key in every locale.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
