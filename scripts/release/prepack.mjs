#!/usr/bin/env node
/**
 * `prepack` of the published packages: delete what the build writes, then build again.
 *
 * WHY: `tsc` and `bun build` never delete. A file that a rename or a removed
 * module left in `dist/` stays there and goes into the tarball, and nothing fails:
 * the package still installs and the stale module is only found by whoever
 * imports it. That is how `@intijs/*` 0.1.0 shipped files that no longer had a
 * source (IntiJS/inti#13). Deleting first makes the tarball exactly what the
 * sources build today.
 *
 * Cross-platform on purpose: the packages are published from Windows CMD, so no
 * `rm -rf`. Run from the package folder (npm and pnpm do that for lifecycle scripts).
 *
 * Usage, in a package.json:
 *   "prepack": "node ../../scripts/release/prepack.mjs"
 *   "prepack": "node ../../scripts/release/prepack.mjs --clean=dist,templates --script=sync-templates"
 *
 *   --clean=a,b    folders to delete, relative to the package (default: dist)
 *   --script=name  package script that rebuilds them (default: build; `none` skips it)
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const pkgDir = process.cwd();
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, ...v] = a.slice(2).split("=");
      return [k, v.join("=")];
    })
);

const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const clean = (args.clean || "dist").split(",").filter(Boolean);
const script = args.script || "build";

for (const folder of clean) {
  const target = resolve(pkgDir, folder);
  const rel = relative(pkgDir, target);
  // Only folders INSIDE the package: a typo must never delete something else.
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    console.error(`[prepack] refusing to delete ${target}: it is not inside ${pkgDir}`);
    process.exit(1);
  }
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    console.log(`[prepack] ${manifest.name}: deleted ${rel}/`);
  }
}

if (script !== "none") {
  if (!manifest.scripts?.[script]) {
    console.error(`[prepack] ${manifest.name} has no "${script}" script`);
    process.exit(1);
  }
  console.log(`[prepack] ${manifest.name}: pnpm run ${script}`);
  const run = spawnSync("pnpm", ["run", script], {
    cwd: pkgDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
