/**
 * prepack: puts the neutral starter into templates/starter-basic so that
 * `kitsuden new` works with the CLI installed from npm, outside the monorepo.
 *
 * It uses the SAME filter as `kitsuden new` (dist/utils/copy-starter.js): without
 * node_modules, dist, .astro or .env. templates/starter-basic is in the
 * package's .gitignore: it is a packaging artifact, not source.
 */

import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { copyStarter, isStarter } from "../dist/utils/copy-starter.js";

const cli = resolve(import.meta.dirname, "..");
const origin = resolve(cli, "..", "starters", "kitsuden-starter-basic");
const target = join(cli, "templates", "starter-basic");

if (!isStarter(origin)) {
  console.error(`starter not found at ${origin}`);
  process.exit(1);
}
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
await copyStarter(origin, target);
console.log(`starter copied to ${target}`);
