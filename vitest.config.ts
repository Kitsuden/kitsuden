/**
 * Root Vitest config.
 *
 * Without this file, a bare `npx vitest run` finds no configuration and
 * sweeps the whole repo with the default patterns: it picks up Bun's tests
 * (`import "bun:test"` → "Cannot find package"), Playwright's
 * ("did not expect test.describe() to be called here"), Svelte's
 * (`$state is not defined`) and even the `.claude/` worktrees, which are
 * full copies of the repo. Result: 130 files in red and the impression
 * that the project is broken when it is not.
 *
 * Re-exporting the unit suite's config makes the obvious command do
 * the right thing. `pnpm test` remains the documented entry point (unit tests + the
 * Bun suite of apps/api, which is a different runner and cannot be merged
 * here); this only avoids the stumble.
 */
export { default } from "./tests/unit/vitest.config";
