#!/usr/bin/env node
/**
 * Removes dependencies and build output from the repository, on any platform.
 * The node_modules at the root goes last, since `pnpm clean` runs from it.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REMOVE = new Set(["node_modules", "dist", ".astro", ".svelte-kit", "build", ".turbo"]);
const PROJECT_FOLDERS = [
  "apps",
  "packages",
  "packages/core",
  "packages/kons",
  "packages/starters",
  "packages/grimoires",
];

for (const base of PROJECT_FOLDERS) {
  const folder = join(ROOT, base);
  if (!existsSync(folder)) continue;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of REMOVE)
      rmSync(join(folder, entry.name, name), { recursive: true, force: true });
  }
  rmSync(join(folder, "node_modules"), { recursive: true, force: true });
}
rmSync(join(ROOT, "node_modules"), { recursive: true, force: true });
console.log("clean: done. Run pnpm install to start again.");
