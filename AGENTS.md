# Kitsuden: notes for coding agents

Read by Codex, Antigravity and other agents; Claude Code reads it through `CLAUDE.md`.
Documentation for agent setups: `docs/agents/coding-agents.md`.

## Never

- Connect to Postgres on port **5432**, to a database whose name contains `prod`, or to
  any `kitsuden_*_prod` container: on a machine that runs Kitsuden, that is the live site.
- Run `docker compose` against the root `docker-compose.yml` (it is the production stack)
  or `pnpm prod:*` on a machine that already runs Kitsuden: with the same `KITSUDEN_INSTANCE`
  (default `kitsuden`) the names are the same and would clash with, or reuse the volumes of, the
  live installation. A new install goes through `./install.sh`, which picks a free prefix.
- Print `.env` files. They can hold production credentials. If you must check a value, print
  key names only and mask URLs.
- Run the test suite against a database whose name lacks `test`: `clearTestData()` deletes
  whole tables without `WHERE`.

## Tests

- `pnpm test:unit`: the vitest suite in `tests/unit`. Kon tests that use the full stack belong
  here, not in `bun test` (Bun's `mock.module` leaks across files).
- `pnpm test:cli`: the CLI's own tests (kon install, signed registry).
- `pnpm test:db:up`: the test Postgres (port 5434), migrated, with settings from `.env.test`, created
  from `.env.test.example` when absent. Then `pnpm test:api`: the API suite on real Postgres; it reads
  `.env.test` by itself. One file: `node ../../scripts/test-db.mjs exec -- bun test <file>` from `apps/api`.
- Run a long suite in the background and read its summary; do not re-run blindly when a worker
  fails to start: repeat that file alone.

## Tools for agents

- `.claude/settings.json`: shared Claude Code permissions. The safe dev commands are allowed;
  reading `.env` files, `pnpm prod:*`, `docker compose up`/`down`, `git push` and `pnpm publish`
  are denied.
- `.claude/skills/`: step-by-step skills, usable by any agent that reads Markdown:
  - `core-migration`: add a core migration (numbering, `history.json`, RLS, the test database);
  - `authorization-change`: change gates, scopes or policies and keep the authorization matrix true;
  - `release-check`: the full pre-release verification CI runs, plus secrets and Spanish scans.
- `skills/kitsuden/SKILL.md`: the skill for calling a running Kitsuden API (below).
- `docs/agents/coding-agents.md`: MCP set-up for Claude Code, Codex and Antigravity.
- `docs/ai/`: system prompts, the MCP tool reference and troubleshooting for agents using Kitsuden.

## Talking to a Kitsuden API

- Use the `kitsuden` skill (`skills/kitsuden/SKILL.md`) and read `GET <api>/llms.txt` before
  the first call. Never invent routes, flags or scopes.
- The API URL comes from `KITSUDEN_API_URL`; the token from `KITSUDEN_API_TOKEN`. Never write a
  token into a file in the repository.
- A `202 KITSUDEN_E_APPROVAL_REQUIRED` means a human must approve: report the proposal, do not retry.
