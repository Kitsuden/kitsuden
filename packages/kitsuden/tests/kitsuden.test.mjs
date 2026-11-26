// The package is a thin entry point: these tests pin that it stays one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const require = createRequire(join(pkgDir, "package.json"));

test("ESM entry re-exports the SDK module itself", async () => {
  const kitsuden = await import("../index.js");
  const sdk = await import("@kitsuden/sdk");
  assert.ok(Object.keys(sdk).length > 0);
  for (const key of Object.keys(sdk)) assert.equal(kitsuden[key], sdk[key], key);
});

test("CJS entry is the SDK's CJS module", () => {
  assert.equal(require("./index.cjs"), require("@kitsuden/sdk"));
});

test("bin runs the CLI with its arguments", () => {
  const cli = JSON.parse(readFileSync(require.resolve("@kitsuden/cli/package.json"), "utf8"));
  const r = spawnSync(process.execPath, [join(pkgDir, "bin", "kitsuden.mjs"), "--version"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), cli.version);
});

test("no runtime of its own: only the SDK and the CLI", () => {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["@kitsuden/cli", "@kitsuden/sdk"]);
});
