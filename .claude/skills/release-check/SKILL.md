---
name: release-check
description: >-
  Full pre-release verification of the Kitsuden core, the same checks CI runs. Use when the user
  asks "is it ready to release", "run the release checks", "pre-release check", "verify
  everything", or before tagging a version or publishing the repository.
---

# Release check

Run every step, even after a failure, and report a table: step, result, and what failed. Do not
fix anything unless the user asks; do not commit, tag or push. Run long suites in the background
and read their summary; if a worker fails to start under load, rerun that file alone.

1. **Lint.** `pnpm --filter @kitsuden/admin exec svelte-kit sync`, then `pnpm lint`.
2. **Format.** `pnpm format:check`. CI fails on it (same job as lint); list the files it names.
3. **Type-check.** `pnpm typecheck:core` (what CI runs; `pnpm typecheck` is the wider one).
4. **Unit and guard tests.** `pnpm test:unit` (vitest, `tests/unit`).
5. **Admin tests.** `pnpm test` in `packages/admin`.
6. **CLI tests.** `pnpm test:cli`.
7. **API suite on the test database** (port 5434, name containing `test`; never 5432):
   ```bash
   pnpm test:db:up     # starts, migrates
   pnpm test:db:migrate   # second pass: must apply no migration
   pnpm test:api       # migrates, bun test src/tests/, then one process per unit file
   ```
   From `apps/api`, also what CI runs after migrating:
   `node ../../scripts/test-db.mjs exec -- bun run scripts/verify-schema.ts` and
   `node ../../scripts/test-db.mjs exec -- bun run scripts/smoke-routes.ts` (no route may 5xx).
8. **Typed clients.** `pnpm sdk:check` (generated clients up to date), `pnpm test:sdk:ts`.
   `pnpm test:sdk:py` needs `uv`; mark it skipped if `uv` is missing.
9. **Versions.** The root `package.json` version matches the top released entry of
   `CHANGELOG.md` (below `[Unreleased]`, which should be empty or renamed for the release) and the
   version stated in `README.md`.
10. **Spanish scan.** Code, docs and API messages are English only (the admin panel's locales in
    `packages/admin/src/lib/i18n` excepted). Review each hit; persisted names recorded in a
    `history.json` `renamed` map are fine, prose is not:
    ```bash
    git grep -nIwiE 'para|los|las|que|con|una|del|está|también|cuando|según|ningún' -- \
      ':!pnpm-lock.yaml' ':!*.json' ':!packages/admin/src/lib/i18n' | head -50
    ```
11. **Secrets scan.** No `.env` is tracked except examples
    (`git ls-files | grep -E '(^|/)\.env' | grep -v '\.example$'` prints nothing), and no key is
    in the tree:
    ```bash
    git grep -nIE '(sk-ant-|sk_live_|ghp_|github_pat_|AKIA[0-9A-Z]{16}|kitsuden_agent_[A-Za-z0-9]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY)' | head
    ```
    Never print a matching value or open a `.env` file: name the file and line only.
12. **Clean tree.** `git status --short` shows only intended changes: no logs, `progress.txt`,
    `dist/`, `coverage/`, compiled `.js`/`.d.ts` next to sources, or scratch files.

Not covered here (CI only): Docker image builds, the all-kons migration chain, Schemathesis and
the starter builds. Say so in the report.
