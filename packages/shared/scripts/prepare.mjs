#!/usr/bin/env node
/**
 * `pnpm install` runs this (the package's `prepare`).
 *
 * The package is built with Bun (scripts/build.ts). Kitsuden's API runs on Bun anyway, but
 * `pnpm install` used to FAIL when Bun was not installed yet, which made the order of the setup
 * steps a trap. Now, without Bun, it says what to do and lets the install finish; the build runs
 * when Bun is there (`pnpm --filter @kitsuden/shared build`, or the next `pnpm install`).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const shell = process.platform === "win32";
const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");

const bun = spawnSync("bun", ["--version"], { shell, stdio: "ignore" });
if (bun.status !== 0) {
  console.warn(
    "@kitsuden/shared: Bun is not installed, so dist/ was not built.\n" +
      "  Kitsuden's API runs on Bun: install it (https://bun.sh), then run\n" +
      "  pnpm --filter @kitsuden/shared build"
  );
  process.exit(0);
}

const build = spawnSync("bun", ["run", "scripts/build.ts"], { cwd: pkg, shell, stdio: "inherit" });
process.exit(build.status ?? 1);
