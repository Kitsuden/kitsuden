#!/usr/bin/env node
/**
 * `npx kitsuden …` runs the Kitsuden CLI (@kitsuden/cli), with the same arguments.
 *
 * The CLI's entry point reads `process.argv` when it is imported, so importing it
 * IS running it: no child process, the exit code and the signals stay its own.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const manifestPath = require.resolve("@kitsuden/cli/package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.kitsuden;
if (!bin) {
  console.error("kitsuden: @kitsuden/cli declares no `kitsuden` bin; reinstall the package");
  process.exit(1);
}
await import(pathToFileURL(join(dirname(manifestPath), bin)).href);
