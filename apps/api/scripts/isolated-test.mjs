#!/usr/bin/env node
/**
 * API unit tests, ONE process per file
 * ============================================================================
 *
 *   node scripts/isolated-test.mjs [directory…]      (default src/tests-unit)
 *
 * bun's `mock.module` applies to the whole PROCESS, not to the file (see
 * scripts/check-test-isolation.mjs at the root). In `src/tests-unit` almost every
 * file replaces `../db`, `drizzle-orm`, `../lib/auth`… with whatever shape
 * suits it, so in a single `bun test` the result depends on the ORDER
 * in which bun walks the files. On Windows it came out green; on the Linux CI,
 * with a different order, there were 12 failures that were not real (each file passes alone). bun's `--isolate`
 * does not work here: it breaks the state that some files share
 * on purpose.
 *
 * So each file runs in its own `bun test`, with up to N at a time
 * (`ISOLATED_PARALLEL_TEST`, default 4), and the output says which file fails.
 * It exits with 1 if any fails. The integration tests (`src/tests`) remain
 * in a single process: they share a database and do not replace modules.
 *
 * The settings come from .env.test at the repository root, unless the environment
 * already has them, as in CI.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { testEnvironment } from "../../../scripts/test-db.mjs";

const TEST_ENV = testEnvironment();
const ROOT = process.cwd();
const DIRS = process.argv.slice(2).length ? process.argv.slice(2) : ["src/tests-unit"];
const PARALLEL = Math.max(1, Number(process.env.ISOLATED_PARALLEL_TEST) || 4);

function files(dir) {
  const out = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const route = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...files(route));
    else if (e.name.endsWith(".test.ts")) out.push(route);
  }
  return out.sort();
}

/** bun writes the summary to stderr: both streams are read */
function runOnce(file) {
  return new Promise((resolve) => {
    // --no-env-file: bun would otherwise add apps/api/.env, which is not for tests.
    const child = spawn("bun", ["--no-env-file", "test", file], {
      cwd: ROOT,
      env: TEST_ENV,
      shell: process.platform === "win32",
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => {
      const n = (re) => Number(output.match(re)?.[1] ?? 0);
      resolve({ file, code, pass: n(/^\s*(\d+) pass/m), fail: n(/^\s*(\d+) fail/m), output });
    });
  });
}

const list = DIRS.flatMap(files);
const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(PARALLEL, list.length) }, async () => {
    while (next < list.length) {
      const r = await runOnce(list[next++]);
      results.push(r);
      const mark = r.code === 0 ? "ok " : "FAIL";
      console.log(
        `${mark} ${relative(ROOT, join(ROOT, r.file))}  (${r.pass} pass, ${r.fail} fail)`
      );
      if (r.code !== 0) console.log(r.output.split("\n").slice(-40).join("\n"));
    }
  })
);

const badOnes = results.filter((r) => r.code !== 0);
const total = results.reduce((a, r) => ({ pass: a.pass + r.pass, fail: a.fail + r.fail }), {
  pass: 0,
  fail: 0,
});
console.log(
  `\n${list.length} files, ${total.pass} pass, ${total.fail} fail, ${badOnes.length} files with failures`
);
process.exit(badOnes.length ? 1 : 0);
