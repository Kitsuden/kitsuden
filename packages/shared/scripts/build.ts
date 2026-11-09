/**
 * Build of `@kitsuden/shared` for publishing
 * ============================================================================
 *
 * WHY NOT PLAIN `tsc`: with ESM, Node requires the explicit extension in
 * relative imports (`./constants.js`). `tsc` emits what the source says
 * (`./constants`), so the published package failed on import with
 * ERR_MODULE_NOT_FOUND — it only worked under bundlers and under Bun, which do
 * resolve without an extension.
 *
 * Bundling into a single `dist/index.js` removes the problem at the root: no
 * relative imports are left to resolve. `zod` stays external (it is a real
 * dependency).
 *
 * Types are still generated with `tsc --emitDeclarationOnly`.
 */

import { existsSync, rmSync, watch } from "node:fs";
import { join } from "node:path";

const PKG_DIR = join(import.meta.dir, "..");
const SRC = join(PKG_DIR, "src");
const OUT = join(PKG_DIR, "dist");
const WATCH = process.argv.includes("--watch");

async function build(): Promise<boolean> {
  rmSync(OUT, { recursive: true, force: true });

  const result = await Bun.build({
    entrypoints: [join(SRC, "index.ts")],
    outdir: OUT,
    target: "node",
    format: "esm",
    external: ["zod", "hono", "hono/*", "drizzle-orm", "drizzle-orm/*", "node:*"],
    naming: "index.[ext]",
  });

  if (!result.success) {
    console.error("❌ @kitsuden/shared build failed:");
    for (const log of result.logs) console.error("  ", log.message);
    return false;
  }

  // Type declarations (tsc only emits .d.ts, no JS).
  const tsc = Bun.spawnSync(
    ["bunx", "tsc", "--emitDeclarationOnly", "--declaration", "--outDir", "dist"],
    { cwd: PKG_DIR, stdout: "pipe", stderr: "pipe" }
  );
  /**
   * Fail here, do not just warn.
   *
   * This used to be a `console.warn` that let the build continue, and it was
   * costly: `package.json` promises `types: ./dist/index.d.ts`, so without that
   * file the eight packages that resolve `@kitsuden/shared` against `dist` get
   * IMPLICIT `any` for everything they import from here. They do not stop
   * compiling: they compile without checking anything, which is worse.
   *
   * The warning was also EMPTY, because `tsc` writes its diagnostics to
   * **stdout**, not stderr. Nobody ever got to see the cause.
   *
   * And the FILE is checked, not just the exit code: with a `noEmit` inherited
   * from the root tsconfig, `tsc` exits with 0 and writes absolutely nothing.
   */
  const declaration = join(PKG_DIR, "dist", "index.d.ts");
  if (tsc.exitCode !== 0 || !existsSync(declaration)) {
    const output = [tsc.stdout, tsc.stderr]
      .map((b) => new TextDecoder().decode(b).trim())
      .filter(Boolean)
      .join("\n");
    console.error("@kitsuden/shared was built WITHOUT type declarations.");
    console.error(output || `tsc exited with ${tsc.exitCode} and did not write ${declaration}.`);
    console.error("Without .d.ts, anyone who imports this package silently gets `any`.");
    return false;
  }

  const kb = (result.outputs.reduce((n, o) => n + o.size, 0) / 1024).toFixed(0);
  console.log(`✅ @kitsuden/shared — ${kb} KB`);
  return true;
}

const ok = await build();

if (!WATCH) {
  process.exit(ok ? 0 : 1);
}

/**
 * Watch mode.
 *
 * It exists because a stale `dist/` is a recurring source of errors that look
 * nothing like their cause: when `src/` is changed without rebuilding, whoever
 * consumes the package blows up with "X is not a function". With `pnpm dev`
 * running, that mismatch is no longer possible.
 *
 * (Unit tests no longer depend on this: `tests/unit/vitest.config.ts`
 * resolves `@kitsuden/shared` to the source. Watch is for everything else.)
 */
console.log("👀 @kitsuden/shared — watching src/…");

let rebuilding = false;
let pending = false;

async function rebuild() {
  if (rebuilding) {
    pending = true; // groups the burst of events from a single save
    return;
  }
  rebuilding = true;
  try {
    await build();
  } catch (err) {
    console.error("❌ Error rebuilding:", err);
  } finally {
    rebuilding = false;
    if (pending) {
      pending = false;
      await rebuild();
    }
  }
}

watch(SRC, { recursive: true }, (_event, filename) => {
  if (filename && /\.(ts|tsx)$/.test(filename)) void rebuild();
});
