/**
 * Cross-test contamination detector
 * ============================================================================
 *
 * THE PROBLEM
 *
 * bun's `mock.module` applies to the whole PROCESS, not to the file. Since
 * `bun test` runs all files in a single process, a stub declared in
 * `a.test.ts` is still alive when `b.test.ts` runs.
 *
 * And it fails silently, which is the worst part: it has already happened
 * twice here —a test that stubbed `checkReadAccess` to `() => true` let
 * permission checks pass in OTHER files, and another that stubbed `sql`
 * without `.raw` broke the RLS builder across the whole process. In both cases
 * the suite stayed green.
 *
 * HOW IT IS DETECTED
 *
 * Each file is run in its OWN process and compared with the joint run. If a
 * file passes in isolation but fails in the batch (or the other way round),
 * there is cross contamination. It is the only reliable way: the symptom is the
 * difference, not a pattern you can grep for.
 *
 * Usage:  node scripts/check-test-isolation.mjs [directory]
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const TEST_DIR = process.argv[2] ?? "apps/api/src/tests-unit";

function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...findTests(rel));
    else if (entry.name.endsWith(".test.ts")) out.push(rel);
  }
  return out;
}

/**
 * Runs bun test and returns {pass, fail} read from the summary.
 *
 * TWO TRAPS, both caused trouble while writing this:
 *
 * 1. `bun test` writes the summary to STDERR, not stdout — only the version
 *    banner goes there. That is why spawnSync is used, which returns both
 *    streams whether the process exits with 0 or not.
 *
 * 2. If parsing fails, it must BLOW UP, not return 0. The first version
 *    returned {pass:0, fail:0} and then compared 0 against 0 and announced
 *    "✅ no drift". A detector that always says everything is fine is worse
 *    than having no detector: it gives a false guarantee.
 */
function run(args, cwd) {
  const result = spawnSync("bun", ["test", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 300_000,
    shell: process.platform === "win32",
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (!/\d+\s+pass/.test(output)) {
    throw new Error(
      `Could not read the summary of "bun test ${args.join(" ")}".\n` +
        `Output:\n${output.slice(0, 800)}`
    );
  }

  return {
    pass: Number(output.match(/(\d+)\s+pass/)?.[1] ?? 0),
    fail: Number(output.match(/(\d+)\s+fail/)?.[1] ?? 0),
  };
}

const files = findTests(TEST_DIR);
const apiDir = join(ROOT, "apps/api");

console.log(`Checking isolation of ${files.length} files…\n`);

const batch = run([TEST_DIR.replace("apps/api/", "")], apiDir);
console.log(`In batch: ${batch.pass} pass / ${batch.fail} fail\n`);

let isolatedPass = 0;
let isolatedFail = 0;
const suspects = [];

for (const file of files) {
  const relToApi = relative(join(ROOT, "apps/api"), join(ROOT, file)).split("\\").join("/");
  const result = run([relToApi], apiDir);
  isolatedPass += result.pass;
  isolatedFail += result.fail;

  if (result.fail > 0) suspects.push({ file, ...result, reason: "fails in isolation" });
  process.stdout.write(".");
}

console.log(`\n\nIsolated: ${isolatedPass} pass / ${isolatedFail} fail`);

// The signal: if the sum of the isolated runs does not match the joint one,
// some file depends on state left behind by another.
const drift = isolatedPass - batch.pass;

if (drift !== 0) {
  console.log(`\n⚠️  DRIFT of ${drift} tests between batch and isolated runs.`);
  console.log("   Some file depends on the global state another one leaves behind.");
} else {
  console.log("\n✅ No drift: no test depends on execution order.");
}

if (suspects.length > 0) {
  console.log("\nFiles that fail on their own:");
  for (const s of suspects) console.log(`   ${s.file} — ${s.fail} fail`);
}

process.exit(drift !== 0 || suspects.length > 0 ? 1 : 0);
