/**
 * MINIMAL copy of the Kitsuden monorepo to test `kitsuden make kon` without
 * touching the real repository.
 *
 * Only what the kon guards read is copied (tests/unit, packages/kons,
 * packages/core, schemas, shared, engine, the admin's icon map and
 * apps/api/src + drizzle). The `node_modules` are NOT copied: they are linked
 * (junction on Windows, symlink elsewhere) to those of the original repo, so
 * the copy weighs about 15 MB and takes seconds.
 *
 * A consequence worth knowing: `@kitsuden/engine` and `@kitsuden/shared` are
 * resolved through those node_modules and point to the ORIGINAL repo's code. The
 * guards read the kons from the copy (via `__dirname`), which is what matters.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

const COPY_ACTION = [
  "package.json",
  "pnpm-workspace.yaml",
  // The INSTALLED kons: without this list, the copy's API does not know
  // any of the ones in packages/kons.
  "kitsuden.kons.json",
  "tsconfig.json",
  "vitest.config.ts",
  "tests/unit",
  "packages/kons",
  "packages/tsconfig.kons.json",
  "packages/core",
  "packages/schemas",
  "packages/shared",
  "packages/engine",
  "packages/grimoires",
  "packages/admin/src/lib",
  "apps/api/package.json",
  "apps/api/tsconfig.json",
  "apps/api/kitsuden.config.ts",
  "apps/api/src",
  "apps/api/drizzle",
];

const OUTSIDE = new Set(["node_modules", "dist", ".turbo", "coverage"]);

function link(origin, target) {
  symlinkSync(origin, target, process.platform === "win32" ? "junction" : "dir");
}

/** Copies `raiz` to `target` and links the node_modules. Returns `target`. */
export function copyRepo(root, target) {
  mkdirSync(target, { recursive: true });
  for (const rel of COPY_ACTION) {
    const o = join(root, rel);
    if (!existsSync(o)) continue;
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    cpSync(o, join(target, rel), {
      recursive: true,
      filter: (f) => !OUTSIDE.has(f.split(/[\\/]/).pop()),
    });
  }

  // node_modules: root, apps/api and each copied package that has them.
  const withModules = [".", "apps/api", "packages/shared", "packages/engine"];
  for (const group of ["packages/kons", "packages/core"]) {
    for (const e of readdirSync(join(root, group), { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== "node_modules") withModules.push(`${group}/${e.name}`);
    }
  }
  withModules.push("packages/kons", "packages/core");
  for (const rel of withModules) {
    const o = join(root, rel, "node_modules");
    const d = join(target, rel, "node_modules");
    if (existsSync(o) && existsSync(join(target, rel)) && !existsSync(d)) link(o, d);
  }
  return target;
}

/**
 * Deletes the copy. It first REMOVES the node_modules links (unlink does not follow
 * the link) and checks they are gone; only then does it delete the rest. A
 * recursive delete that crossed a junction would empty the real repo's
 * node_modules.
 */
export function deleteCopy(target) {
  if (!existsSync(target)) return;
  const pendingItems = [target];
  while (pendingItems.length) {
    const dir = pendingItems.pop();
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const route = join(dir, e.name);
      const st = lstatSync(route);
      if (st.isSymbolicLink()) {
        unlinkSync(route);
        if (existsSync(route)) throw new Error(`could not remove the link ${route}`);
      } else if (st.isDirectory() && e.name !== ".git") pendingItems.push(route);
    }
  }
  rmSync(target, { recursive: true, force: true });
}
