/**
 * `any` ratchet
 * ============================================================================
 *
 * The project has `strict: true` and, at the same time, over a thousand explicit
 * `any`. That is not a rhetorical contradiction: every `any` switches the checker
 * off at that point AND at everything derived from it, so strict mode ends up
 * guaranteeing quite a bit less than it promises.
 *
 * Eliminating them all at once is neither realistic nor prudent. What is:
 * PREVENTING THEM FROM GROWING. This test sets a ceiling per area. Raise the
 * count and the test fails; lower it and update the ceiling. It can only go down.
 *
 * If your change really needs an `any`, put an
 * `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- <reason>`
 * on it and it does not count: the target is the silent `any`, not the justified one.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

/**
 * Ceiling per area. These numbers are measured debt, not goals: lower them when
 * you clean up. Never raise them to make a commit pass.
 */
const CEILINGS: Record<string, number> = {
  // 237 → 208. Almost all from `mcp-tools.ts` (45 → 17): the table lookup by
  // name was there five times with its `(mergedSchema as any)`, and the arguments
  // of the 15 tools were read with `args as any` — which was not a typing slip
  // but the absence of validation at the boundary where whatever
  // an LLM writes comes in. They are now validated with zod before dispatch.
  // 208 → 196: `module-loader.ts` built the KonContext as `any` with an
  // `as KonContext` on the way out, and the whole content-publishing registry was
  // `any` even though its contract was already written in `@kitsuden/shared`.
  // Final drop of the round: `eqEnum` replaced 25 comparisons
  // `eq(column, value as any)` spread across 15 files. It was not style — with
  // a value outside the enum, Postgres makes the query fail (500) instead of
  // returning zero rows.
  "apps/api/src": 187,
  // 164 → 152 by replacing the `(table as any).column` of batch/batch-api with
  // the typed condition builder.
  // 152 → 143: in `actions.ts`, telemetry stopped hanging off the
  // `kon` object with casts and `kon: null as any` became a real `| null`.
  "packages/engine/src": 141,
  // 183 → 179 by removing the casts needed to chain `.where()`
  // after `.orderBy()` in esports and the `catch (e: any)` of kon-conta.
  // 179 → 170: `kon-dms` used `any[]` for the Drizzle conditions (which
  // hid that `or()` can return `undefined`) and cast to enum the
  // filters that arrive by query string without checking them.
  "packages/kons": 157,
  "packages/core": 96,
};

/** Counts explicit `any`, ignoring those justified with eslint-disable. */
function countAny(dir: string): number {
  let total = 0;

  function walk(current: string): void {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (["node_modules", "dist", ".git", "build"].includes(entry.name)) continue;
      const path = join(current, entry.name);

      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue;

      const lines = readFileSync(path, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;

        // COMMENT lines do not count.
        //
        // A comment explaining why an `any` was removed —quoting it, like
        // "this used to be `(c as any).get(...)`"— is not an `any`. Counting it
        // penalizes documenting and pushes people to write worse so the test passes,
        // which is the tail wagging the dog.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;

        if (!/:\s*any\b|<any>|\bas any\b/.test(line)) continue;

        // An `any` with explicit justification does not count: the target is the
        // silent one, not the one someone decided on and documented.
        const prev = lines[i - 1] ?? "";
        const prev2 = lines[i - 2] ?? "";
        if (/no-explicit-any/.test(prev) || /no-explicit-any/.test(prev2)) continue;
        if (/eslint-disable.*no-explicit-any/.test(line)) continue;

        total++;
      }
    }
  }

  walk(join(ROOT, dir));
  return total;
}

describe("any ratchet", () => {
  for (const [area, ceiling] of Object.entries(CEILINGS)) {
    it(`${area} does not exceed ${ceiling} unjustified any`, () => {
      const actual = countAny(area);

      // The message matters: whoever breaks this must know what to do.
      expect(
        actual,
        actual > ceiling
          ? `${area} went up to ${actual} (ceiling ${ceiling}). Type what you added, ` +
              `or justify it with an eslint-disable-next-line that explains why.`
          : `${area} went down to ${actual}: lower the ceiling in tests/unit/any-ratchet.test.ts`
      ).toBeLessThanOrEqual(ceiling);
    });
  }
});

/**
 * Bun-isms outside the scripts.
 *
 * `import.meta.dir` is Bun-specific and is `undefined` under Node. It already
 * broke the published package once. Build scripts CAN use it —they are
 * invoked with `bun run`— but runtime code cannot: it has to run on
 * both.
 */
describe("Node/Bun portability", () => {
  it("import.meta.dir does not appear in runtime code", () => {
    const offenders: string[] = [];

    function walk(current: string): void {
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (["node_modules", "dist", ".git", "build", "scripts"].includes(entry.name)) continue;
        const path = join(current, entry.name);

        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;

        const source = readFileSync(path, "utf8");
        for (const line of source.split("\n")) {
          // Only real usage, not mentions in comments explaining that it is avoided.
          const trimmed = line.trim();
          if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
          if (line.includes("import.meta.dir")) {
            offenders.push(path.replace(ROOT, "").replace(/\\/g, "/"));
            break;
          }
        }
      }
    }

    walk(join(ROOT, "apps"));
    walk(join(ROOT, "packages"));

    expect(
      offenders,
      `import.meta.dir is Bun-specific and is undefined under Node. Use process.cwd() ` +
        `or fileURLToPath(import.meta.url). Files: ${offenders.join(", ")}`
    ).toEqual([]);
    // Walks all of apps/ and packages/: 1.5 s in isolation, but it went over 20 s in
    // the full suite with the machine loaded (a false red due to timing).
  }, 90_000);
});
