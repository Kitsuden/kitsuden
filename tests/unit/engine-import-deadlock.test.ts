/**
 * `schema-merger` cannot import `db` at runtime
 * ============================================================================
 *
 * ── THE DEADLOCK ───────────────────────────────────────────────────────────
 *
 * `apps/api/src/db/index.ts` ends with:
 *
 *     export const db = await getDbInstance();
 *
 * A top-level `await`, whose initialization loads `schema-merger`. If
 * `schema-merger` imports `db` back, there is a cycle with top-level
 * `await` — and in ESM that **deadlocks or not depending on where you enter**:
 *
 *   · Entering through `db`: it works. `db` starts, loads `schema-merger`, which sees
 *     `db` half-evaluated (dead zone, legal), finishes, and `db` resolves.
 *
 *   · Entering through any module that reaches `schema-merger` first: ESM
 *     schedules its evaluation AFTER `db`. `db` waits for `schema-merger`,
 *     `schema-merger` waits its turn behind `db`. Permanent deadlock.
 *
 * ── WHY IT DESERVES A TEST ─────────────────────────────────────────────────
 *
 * Because it does not look like a failure. The process sat at **0% CPU with not
 * a single open connection**: no exception, no trace, no timeout. The API never
 * got to listen and the only thing visible was
 *
 *     dependency failed to start: container kitsuden_api_prod is unhealthy
 *
 * Locating it meant bisecting the 40 imports of the engine index one by one.
 *
 * ── WHAT IS GUARDED NOW ────────────────────────────────────────────────────
 *
 * The first version of this test guarded the symptom: that the engine
 * index did not re-export `buildMergedSchema`. It worked, but left the trap
 * set — any other module could close the cycle again.
 *
 * Now `buildMergedSchema` RECEIVES database access as a parameter, and
 * `schema-merger` keeps only an `import type`, which TypeScript erases. Without an
 * execution edge no cycle is possible, wherever the load comes from.
 *
 * This test protects that: that this import stays type-only.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const MERGER = join(ROOT, "apps", "api", "src", "lib", "schema-merger.ts");

/** Real `import`/`export ... from` lines, without comments. */
function amounts(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .filter((l) => /^\s*(import|export)\b[^;]*\bfrom\s*["']/.test(l));
}

describe("schema-merger does not reopen the cycle with db", () => {
  const lines = amounts(readFileSync(MERGER, "utf-8"));

  it("there are imports to inspect", () => {
    // Without this, a format change that broke the filter would leave the list
    // empty and the check below would pass without looking at anything.
    expect(lines.length).toBeGreaterThan(3);
  });

  it("the import of ../db is type-only", () => {
    // `../db/schema-core` does not count: it is the schema, not the connection, and it does not
    // drag in the top-level `await`.
    const toDb = lines.filter((l) => /from\s*["']\.\.\/db["']/.test(l));
    const withValueOf = toDb.filter((l) => !/^\s*import\s+type\b/.test(l));

    expect(
      withValueOf,
      `apps/api/src/lib/schema-merger.ts imports '../db' at ` +
        `RUNTIME:\n\n${withValueOf.join("\n")}\n\n` +
        `This reopens the cycle with the top-level 'await' of db/index.ts and ` +
        `blocks API startup forever — with no error, no CPU and no ` +
        `connections. If you need to query the database here, receive it as a ` +
        `parameter (buildMergedSchema already does) instead of importing it.`
    ).toEqual([]);
  });

  it("buildMergedSchema still accepts the database as a parameter", () => {
    // If someone removes the parameter, the only way to query the
    // database from here again is to import it — and that reopens the deadlock.
    const source = readFileSync(MERGER, "utf-8");
    expect(
      /export async function buildMergedSchema\(\s*queries\?:/.test(source),
      "buildMergedSchema no longer receives the database as a parameter: without that route, " +
        "querying installed_kons forces importing '../db' and reopening the cycle."
    ).toBe(true);
  });
});
