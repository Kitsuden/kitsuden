#!/usr/bin/env node
/**
 * The SDK in watch mode
 * ============================================================================
 *
 *   pnpm sdk:watch
 *
 * You change a `defineModel` (or any `defineOperation`) and, within a few
 * seconds, `packages/sdk/src/generated` already reflects it: the frontend
 * editor flags the new field or the removed one without touching anything
 * else. It closes "gap 3" without Rust: the bottleneck was never the language,
 * it was that generation had to be launched by hand.
 *
 * What it does on each change (with a 300 ms margin to group a multiple save):
 *   1. `apps/api/scripts/sdk-openapi.ts` → the OpenAPI of the operations
 *      (offline: no database or network; ~4 s measured).
 *   2. `scripts/sdk/generate.mjs` → the TS and Python clients, INCREMENTAL:
 *      it only rewrites the files that change, so the TypeScript server
 *      revalidates only the kon that was touched.
 * If another change arrives while it regenerates, ONE more pass is made at the end.
 *
 * What it watches: the kons (`packages/kons`), the core (`packages/core`), the
 * models and operations of `packages/shared` and the engine, and the core's own
 * operations in `apps/api/src`. It ignores tests, `dist`, `node_modules` and
 * generated output (otherwise it would wake itself up).
 */

import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const WATCHED = [
  "packages/kons",
  "packages/core",
  "packages/shared/src",
  "packages/engine/src",
  "apps/api/src/lib",
  "apps/api/src/routes",
].map((d) => join(ROOT, d));

const IGNORE =
  /(^|[\\/])(node_modules|dist|dist-[^\\/]*|generated|_generated|tests?|__tests__|\.astro|\.svelte-kit)([\\/]|$)|\.(test|spec)\.[mc]?[jt]sx?$|\.d\.ts$/;
const OF_INTEREST = /\.(ts|mts|json)$/;

let timer = null;
let ongoing = false;
let anotherRound = false;
const touched = new Set();

function runOnce(cmd, args, cwd) {
  return new Promise((ok) => {
    const p = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
      shell: process.platform === "win32",
    });
    p.on("close", (code) => ok(code ?? 1));
  });
}

async function regenerate() {
  if (ongoing) {
    anotherRound = true;
    return;
  }
  ongoing = true;
  const list = [...touched].slice(0, 5).map((f) => relative(ROOT, f).replaceAll("\\", "/"));
  touched.clear();
  const start = Date.now();
  console.error(`\n[sdk:watch] change in ${list.join(", ")}${list.length === 5 ? "…" : ""}`);
  const spec = await runOnce(
    "bun",
    ["--no-env-file", "scripts/sdk-openapi.ts"],
    join(ROOT, "apps/api")
  );
  if (spec === 0) {
    await runOnce("node", ["scripts/sdk/generate.mjs"], ROOT);
    console.error(`[sdk:watch] ready in ${((Date.now() - start) / 1000).toFixed(1)} s`);
  } else {
    console.error(
      "[sdk:watch] the OpenAPI could not be generated (see the error above); the SDK does not change"
    );
  }
  ongoing = false;
  if (anotherRound) {
    anotherRound = false;
    void regenerate();
  }
}

function onChange(base, file) {
  if (!file) return;
  const abs = join(base, file.toString());
  if (IGNORE.test(abs) || !OF_INTEREST.test(abs)) return;
  touched.add(abs);
  clearTimeout(timer);
  timer = setTimeout(() => void regenerate(), 300);
}

for (const dir of WATCHED) {
  if (!existsSync(dir)) continue;
  // `recursive` works on Windows, macOS and Linux (Node >= 20).
  watch(dir, { recursive: true }, (_event, file) => onChange(dir, file));
}

console.error(
  `[sdk:watch] watching ${WATCHED.filter(existsSync).length} folders; Ctrl+C to exit. First generation…`
);
touched.add(join(ROOT, "(startup)"));
void regenerate();
