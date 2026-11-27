/**
 * The kons get THIS process's engine, not a second copy
 * ============================================================================
 *
 * In production the API runs as a bundle (`bun build src/index.ts` → `dist/index.js`)
 * that carries its own copy of `packages/engine`. The kons are loaded at runtime from
 * their sources and `import … from "@kitsuden/engine"`, which Bun resolved to the
 * engine's SOURCE files: a second, independent copy in the same process.
 *
 * Every piece of module state then existed twice, and the kon saw the empty one:
 *
 *   · the request scope and RLS context: a kon's `asSystem()` did nothing, its
 *     `withSavepoint()` opened no savepoint, and `repo()` writes answered 500 on the
 *     `record_changes` RLS check (`shared-state.ts` covers those);
 *   · the queue: `queue.handle()` from a kon stored its handler in the second copy,
 *     the only worker (the bundle's) never saw it, and the jobs stayed `waiting`
 *     forever (ingest, koe, the CRM inbox, Odoo sync…). The startup log said "a kon
 *     registered the queue … outside its scope";
 *   · anything else kept at module level that nobody has listed yet.
 *
 * With sources (tests, `bun run src/index.ts`) there was one copy and nothing
 * failed, which is why it went unseen.
 *
 * The fix at the root: before any kon is imported, `@kitsuden/engine` is registered as
 * a runtime virtual module whose exports are the namespace this process already
 * loaded. A kon's import then gets the very functions the core uses. In source mode
 * that namespace is the same module, so nothing changes there.
 *
 * Only `@kitsuden/engine` itself: `@kitsuden/engine/zod` is zod (stateless helpers),
 * and `@kitsuden/shared` holds contracts, not request state.
 */
import * as engine from "../../../../packages/engine/index";

let registered = false;

/** Makes `import … from "@kitsuden/engine"` in a kon resolve to this process's engine. Idempotent. */
export function shareEngineWithKons(): boolean {
  if (registered) return true;
  const runtime = (globalThis as { Bun?: typeof Bun }).Bun;
  if (!runtime?.plugin) return false; // Node build (`build:node`): no runtime plugins
  // A plain object: the namespace's exports are functions, classes and constants
  // (no `export let`), so a snapshot is the same as the live bindings.
  const exports = { ...engine } as Record<string, unknown>;
  runtime.plugin({
    name: "kitsuden-engine-for-kons",
    setup(build) {
      build.module("@kitsuden/engine", () => ({ exports, loader: "object" }));
    },
  });
  registered = true;
  return true;
}
