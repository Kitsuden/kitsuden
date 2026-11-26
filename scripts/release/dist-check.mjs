#!/usr/bin/env node
/**
 * Part of `prepublishOnly`: every file the manifest promises exists, and loads.
 *
 * `main`, `module`, `types`, each `exports` target and each `bin` must exist
 * (with `publishConfig` applied, as `pnpm pack` writes them), and each JavaScript
 * entry point must import (ESM) or require (CJS) without throwing. A package can
 * pass its unit tests, which run on the sources, and still ship an export that
 * points at a file the build never wrote: this is the check for that.
 *
 *   node ../../scripts/release/dist-check.mjs              imports with Node
 *   node ../../scripts/release/dist-check.mjs --bun        imports with Bun (builds that target Bun)
 *   node ../../scripts/release/dist-check.mjs --no-import  existence only
 *
 * Bins are checked for existence and a `#!` line, not run: running a CLI or a
 * server here would do whatever it does.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pkgDir = process.cwd();
const useBun = process.argv.includes("--bun");
const noImport = process.argv.includes("--no-import");

const raw = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
// What the published manifest says: pnpm moves these publishConfig keys to the top.
const pkg = { ...raw };
for (const key of ["main", "module", "types", "typings", "exports", "bin", "browser"]) {
  if (raw.publishConfig?.[key] !== undefined) pkg[key] = raw.publishConfig[key];
}

const problems = [];
/** @type {{ file: string, kind: "import" | "require" | "types" | "other", from: string }[]} */
const targets = [];

function add(file, kind, from) {
  if (typeof file !== "string") return;
  targets.push({ file, kind, from });
}

function kindOf(condition, file) {
  if (/\.d\.[cm]?ts$/.test(file)) return "types";
  if (condition === "require" || file.endsWith(".cjs")) return "require";
  if (/\.(m?js)$/.test(file)) return "import";
  return "other";
}

function walkExports(node, path, condition) {
  if (typeof node === "string") {
    add(node, kindOf(condition, node), `exports${path}`);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    const subpath = key.startsWith(".") ? `["${key}"]` : `.${key}`;
    walkExports(value, path + subpath, key.startsWith(".") ? condition : key);
  }
}

add(pkg.main, kindOf(pkg.type === "module" ? "import" : "require", pkg.main ?? ""), "main");
add(pkg.module, "import", "module");
add(pkg.types ?? pkg.typings, "types", "types");
walkExports(pkg.exports, "", "import");

const bins = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
for (const [name, file] of Object.entries(bins)) {
  const full = resolve(pkgDir, file);
  if (!existsSync(full)) {
    problems.push(`bin "${name}" → ${file} does not exist`);
    continue;
  }
  const first = readFileSync(full, "utf8").split("\n", 1)[0];
  if (!first.startsWith("#!")) problems.push(`bin "${name}" → ${file} has no #! line`);
}

// A source file in an export means the package was not built for publishing.
for (const t of targets) {
  if (/\.(ts|tsx|mts|cts)$/.test(t.file) && t.kind !== "types") {
    problems.push(`${t.from} → ${t.file} is TypeScript source, not built JavaScript`);
  }
  if (!existsSync(resolve(pkgDir, t.file))) problems.push(`${t.from} → ${t.file} does not exist`);
}

if (!noImport && problems.length === 0) {
  const require = createRequire(join(pkgDir, "package.json"));
  const seen = new Set();
  for (const t of targets) {
    const full = resolve(pkgDir, t.file);
    if (seen.has(full) || (t.kind !== "import" && t.kind !== "require")) continue;
    seen.add(full);
    if (useBun) {
      const code =
        t.kind === "require"
          ? `require(${JSON.stringify(full)})`
          : `await import(${JSON.stringify(pathToFileURL(full).href)})`;
      const r = spawnSync("bun", ["-e", code], {
        cwd: pkgDir,
        encoding: "utf8",
        // No shell: cmd.exe would split the code argument at its quotes.
        timeout: 60_000,
      });
      if (r.status !== 0)
        problems.push(`${t.from} → ${t.file} fails to load in Bun:\n${r.stderr || r.stdout}`);
      continue;
    }
    try {
      if (t.kind === "require") require(full);
      else await import(pathToFileURL(full).href);
    } catch (error) {
      problems.push(`${t.from} → ${t.file} fails to ${t.kind}: ${error?.message ?? error}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`[dist-check] ${pkg.name}: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
const loaded = noImport ? "existence only" : useBun ? "loaded with Bun" : "loaded with Node";
console.log(
  `[dist-check] ${pkg.name}: ${targets.length} entry file(s) and ${Object.keys(bins).length} bin(s) OK (${loaded})`
);
// Bun's and Node's module loaders may keep handles open (timers in imported modules).
process.exit(0);
