#!/usr/bin/env node
/**
 * Copies the files the Docker mode needs from the repository root into
 * `templates/`, so the published package scaffolds offline. Runs before packing
 * (`prepack`); in the monorepo the code reads the root directly.
 */
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TEMPLATE_FILES } from "../src/index.mjs";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(pkg, "../..");
const out = resolve(process.argv[2] ?? join(pkg, "templates"));

rmSync(out, { recursive: true, force: true });
for (const f of TEMPLATE_FILES) {
  mkdirSync(dirname(join(out, f)), { recursive: true });
  copyFileSync(join(root, f), join(out, f));
}
console.error(`[create-kitsuden] ${TEMPLATE_FILES.length} templates → ${out}`);
