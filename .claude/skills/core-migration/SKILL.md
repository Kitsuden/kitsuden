---
name: core-migration
description: >-
  Add or fix a database migration in the Kitsuden core. Use when the user asks for a new table,
  column, index, constraint or row-security change in apps/api or packages/core, says "add a
  migration", "schema change", "rename a column", or a migration fails with drift ("changed AFTER
  being applied"). Not for kons: they live in the kitsuden-kons repository.
---

# Add a core migration

Background: `docs/operations.md` (Migrations, What CI checks, Guards) and the header of
`apps/api/scripts/migrate.ts`.

## Where they live

The runner (`apps/api/scripts/migrate.ts`) applies, in this order:

1. `apps/api/drizzle/*.sql`: the base schema from drizzle-kit (`0000`, `0001`). Do not add here.
2. `apps/api/src/db/migrations/*.sql`: the hand-written core migrations. **New ones go here.**
3. `packages/core/<battery>/migrations/*.sql` (`blocks`, `datasets`, `media`, `vector-search`):
   only for a change that belongs to that battery.
4. The RLS files in `apps/api/src/db/`: `agent-functions.sql`, `rls-policies.sql`,
   `rls-owned-tables.sql`, `rls-system-only.sql`. Idempotent, re-applied on every run.

Each file runs in one transaction and is recorded with its checksum in `kitsuden_migrations`.

## Steps

1. **Name.** Next number after the highest in the folder, four digits, English snake_case:
   `NNNN_what_it_does.sql`. Files sort by name; never reuse or renumber an existing one.
2. **Never edit a released migration.** The runner stops on a checksum change. Fix a past
   migration with a new one (see `0075_english_leftover_names.sql`). `--allow-drift` is not a fix.
3. **Idempotent SQL.** CI applies the chain twice and fails if the second pass does anything:
   `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `ALTER INDEX IF EXISTS`, `DO $$`
   blocks that check `pg_constraint`/`information_schema` first. Start the file with a comment
   saying why it exists.
4. **Declare the table.** Tables the code uses are declared in `apps/api/src/db/schema-core.ts`;
   `apps/api/scripts/verify-schema.ts` fails at startup if a declared table has no migration.
5. **Row security.** A table with an owner column (`user_id`, `owner_id`, `created_by`,
   `author_id`) must be classified, or `apps/api/src/tests-unit/rls-coverage.test.ts` fails:
   personal ownership goes in `rls-owned-tables.sql`; collaborative authorship goes in that test's
   list with its reason. Other policies go in `rls-policies.sql`, each `DROP POLICY IF EXISTS`
   before `CREATE POLICY` (the applier swallows "already exists"). The helpers in
   `agent-functions.sql` (`kitsuden_rls_team`, `kitsuden_rls_owned`,
   `kitsuden_rls_public_read`, `kitsuden_effective_admin`, `kitsuden_agent_can_in_kon`…) are
   documented in `docs/kons/README.md` → "Row security in one line".
6. **Renamed or reworded a migration?** Only when the SQL does not change (a comment translated,
   a line ending). Record it in the folder's `history.json`: `renamed` (new name → old name) and
   `previousChecksums` (new name → the checksums it had). Otherwise installed databases run it
   again or stop on drift. Logic: `apps/api/src/lib/migration-history.ts`.
7. **Apply it to the test database only** (port 5434, name containing `test`; never 5432):
   ```bash
   pnpm test:db:up        # starts and migrates it (node scripts/test-db.mjs up)
   pnpm test:db:migrate   # re-apply after editing (node scripts/test-db.mjs migrate)
   ```
   Run it twice: the second run must apply nothing. For the runner's own flags, from `apps/api`:
   `node ../../scripts/test-db.mjs exec -- bun run scripts/migrate.ts --status` (or `--dry-run`).
8. **Test.** `pnpm test:api` (migrates, then the API suite) and the RLS coverage test alone:
   `node ../../scripts/test-db.mjs exec -- bun test src/tests-unit/rls-coverage.test.ts` from
   `apps/api`. Add a test for the behaviour the migration enables.

Never run `pnpm db:push` or point a migration at a real database. Report the file name, what it
changes, and the test results. Do not commit unless asked.
