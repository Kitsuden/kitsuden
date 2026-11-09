/**
 * Scripts embedded in startup must always finish
 * ============================================================================
 *
 * `docker/start-with-check.sh` runs pieces of TypeScript with `bun run -`.
 * One of them ended like this:
 *
 *     main().catch(() => process.exit(0));
 *
 * Which only terminates on the BAD path. On the good one, `main()` did all its
 * work —registered the kons, printed each line— and the process **did not exit**:
 * `db` leaves a Postgres pool open, and as long as a handle stays alive the
 * runtime does not finish.
 *
 * The effect: startup stopped there forever. Step [6/6] never
 * got to launch the API, nothing listened on 3000, and `docker compose up`
 * only said the container was `unhealthy`. **Without a single line
 * of error, because there was no error.** Measured with the fix, that same step
 * went from hanging indefinitely to taking 0.20 s.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * If a startup script calls a top-level async function,
 * it has to exit by BOTH paths: `.finally(() => process.exit(...))`, or a
 * `process.exit` reachable in both. A bare `.catch()` is not enough.
 *
 * It is checked by reading the script and not by running it: a test that ran
 * startup would need a database, and if the failure reappeared it would hang
 * itself — a hung test blocks the suite and reports nothing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SCRIPT = join(ROOT, "docker", "start-with-check.sh");

describe("scripts embedded in startup terminate", () => {
  const source = readFileSync(SCRIPT, "utf-8");

  it("the startup script exists and has content", () => {
    expect(source.length).toBeGreaterThan(500);
  });

  it("there is no main().catch() without an exit on the good path", () => {
    /**
     * The exact pattern that hung startup: `.catch()` closing the chain,
     * with no `.finally()` or a later `process.exit`.
     */
    const suspicious = source
      .split("\n")
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /^\s*main\(\)[\s\S]*\.catch\(/.test(l))
      .filter(([, l]) => !l.includes(".finally("));

    expect(
      suspicious.map(([n, l]) => `line ${n}: ${l.trim()}`),
      `docker/start-with-check.sh again ends a main() with only .catch(). ` +
        `That ends the process when it fails, but NOT when it works: the ` +
        `Postgres pool stays open and the runtime never exits. Startup ` +
        `hangs there and the container shows 'unhealthy' with no error. ` +
        `Use .finally(() => process.exit(0)).`
    ).toEqual([]);
  });

  it("every main() in the script exits through finally", () => {
    // Positive check: it is not enough that the bad pattern does not exist, the good one has
    // to exist. If someone rewrites the block another way and
    // forgets to exit, this catches it.
    const invocations = (source.match(/^\s*main\(\)/gm) ?? []).length;
    if (invocations === 0) return; // the block no longer exists: nothing to require

    const outputs = (source.match(/\.finally\(\s*\(\)\s*=>\s*process\.exit\(/g) ?? []).length;
    expect(
      outputs,
      `The script calls main()${invocations} time(s) but only ${outputs} ` +
        `end with .finally(() => process.exit(...)). A main() that does not exit ` +
        `on the success path hangs the whole startup, silently.`
    ).toBeGreaterThanOrEqual(invocations);
  });
});
