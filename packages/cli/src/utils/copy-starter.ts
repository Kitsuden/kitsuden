/**
 * Copying the frontend starter
 * ============================================================================
 *
 * `kitsuden new` and the CLI packaging (`scripts/package-starter.mjs`)
 * copy the SAME starter with the SAME filter. It lives here so the two
 * copies do not drift apart: if one let `.env` through, the published tarball
 * would carry the `.env` of whoever packaged it.
 *
 * What is NOT copied, at any depth:
 *
 *   · node_modules, dist, dist-*, .astro, .inti, .turbo, coverage — build
 *     output or local state; the new project regenerates them;
 *   · .env and .env.* except .env.example — they may carry secrets
 *     (KITSUDEN_SITE_KEY, INTI_KITSUDEN_TOKEN).
 */

import { existsSync } from "node:fs";
import { cp, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".astro", ".inti", ".turbo", "coverage"]);

/** Is this entry copied? It receives only the name (without folder). */
export function isCopied(name: string): boolean {
  if (EXCLUDED_DIRS.has(name)) return false;
  if (name.startsWith("dist-")) return false;
  if (name === ".env") return false;
  if (name.startsWith(".env.") && name !== ".env.example") return false;
  return true;
}

/** Copies `origin` into `target` with the filter above. `target` must not exist or must be empty. */
export async function copyStarter(origin: string, target: string): Promise<void> {
  await cp(origin, target, {
    recursive: true,
    filter: (source) => source === origin || isCopied(basename(source)),
  });
}

/** Root of the CLI package (the folder with its package.json), from dist/ or src/. */
export function cliRoot(): string {
  // dist/utils/copy-starter.js → ../.. ; same from src/utils with tsx.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export interface StarterFound {
  dir: string;
  /** Where it came from: to say so in the output and not guess when debugging. */
  source: "--from" | "bundled" | "monorepo";
}

/** Does it look like the starter? The minimum so as not to copy any random folder. */
export function isStarter(dir: string): boolean {
  return (
    existsSync(join(dir, "package.json")) &&
    existsSync(join(dir, "astro.config.mjs")) &&
    existsSync(join(dir, ".env.example"))
  );
}

/**
 * Where the starter is, in order:
 *
 *   1. `--from <dir>` if passed;
 *   2. `templates/starter-basic` inside the CLI package — left there by
 *      `prepack`, so it is what the CLI installed from npm ships with;
 *   3. `packages/starters/kitsuden-starter-basic` of the monorepo, when the CLI
 *      runs from the Kitsuden repository.
 *
 * There is no download from GitHub: a download that fails silently is worse
 * than an error that says what to pass.
 */
export function findStarter(from?: string): StarterFound | null {
  if (from) {
    const dir = resolve(from);
    return isStarter(dir) ? { dir, source: "--from" } : null;
  }
  const cli = cliRoot();
  const packaging = join(cli, "templates", "starter-basic");
  if (isStarter(packaging)) return { dir: packaging, source: "bundled" };
  const monorepo = resolve(cli, "..", "starters", "kitsuden-starter-basic");
  if (isStarter(monorepo)) return { dir: monorepo, source: "monorepo" };
  return null;
}

/** Recursive list of copied relative paths (for the tests and the summary). */
export async function listRelative(dir: string, base = dir): Promise<string[]> {
  const outside: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const route = join(dir, e.name);
    if (e.isDirectory()) outside.push(...(await listRelative(route, base)));
    else
      outside.push(
        route
          .slice(base.length + 1)
          .split("\\")
          .join("/")
      );
  }
  return outside;
}
