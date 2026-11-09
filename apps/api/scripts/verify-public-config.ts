/**
 * Startup step 0: a public installation does not start misconfigured
 * ============================================================================
 *
 * Called by `docker/start-with-check.sh` before touching the database. Failing here
 * is cheap: nothing has been migrated yet and nobody has been served.
 *
 * The logic lives in `src/lib/public-config.ts` so it can be tested without
 * starting anything. This file only decides whether it applies and how to exit.
 *
 * Explicit `process.exit` on both paths: the mail module may leave
 * resources open when imported, and a process that does not finish would leave
 * startup hanging at this step without saying why.
 */

import { publicConfigProblems } from "../src/lib/public-config";

if (process.env.KITSUDEN_PUBLIC !== "true") {
  console.log(
    "  Local mode (KITSUDEN_PUBLIC is not true): public URLs and real email are not required."
  );
  process.exit(0);
}

const problems = publicConfigProblems(process.env);

if (problems.length === 0) {
  console.log("  Public configuration verified: https, no localhost, real email.");
  process.exit(0);
}

console.error("\n  ✗ This installation is marked as public and is not ready:\n");
for (const p of problems) console.error(`     · ${p.variable}: ${p.reason}`);
console.error("\n    Fix .env and start again. For local use, do not set KITSUDEN_PUBLIC.\n");
process.exit(1);
