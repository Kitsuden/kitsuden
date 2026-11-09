/**
 * A `$derived.by` value is not called with parentheses
 * ============================================================================
 *
 * ── THE FAILURE ────────────────────────────────────────────────────────────
 *
 * `CalculatedField.svelte` and `DateField.svelte` did this:
 *
 *     const displayValue = $derived.by(() => { … });
 *     …
 *     {displayValue()}          // ← with parentheses
 *
 * `$derived.by(fn)` EXECUTES the function and stores the result. Calling the
 * result throws `TypeError: displayValue is not a function`, which in the
 * minified bundle arrives as:
 *
 *     Uncaught TypeError: e(...) is not a function
 *
 * and takes down the rendering of the whole row. The table is left with the
 * spinner on and "0 records" — not a single message pointing at the culprit field.
 *
 * ── WHY IT IS EASY TO GET WRONG ────────────────────────────────────────────
 *
 * The two forms read almost the same and do the opposite:
 *
 *     $derived(() => …)      stores THE FUNCTION   → it IS called
 *     $derived.by(() => …)   stores THE RESULT     → it is NOT called
 *
 * `GamesView` uses the first with `sortedGames()` and is correct. That is why
 * this test only looks at `.by`: flagging the other one too would be shouting at
 * code that works, and a guardian that shouts at what is correct ends up ignored.
 *
 * ── WHY NOBODY SAW IT BEFORE ───────────────────────────────────────────────
 *
 * These components are only mounted when there are ROWS to paint. With
 * empty tables they never got to run. It is the same pattern as the
 * explorer loop: a failure that waits for real data to show up, and
 * then shows up on the main screen.
 */

import { readFileSync, globSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const ADMIN = join(ROOT, "packages", "admin", "src");

/**
 * Strips block and line comments.
 *
 * Without this, the very comment that explains the failure —where
 * `displayValue()` is written as an example of what NOT to do— would make the
 * test fail. It already happened in the first version.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("derived values with `.by`", () => {
  const files = globSync("**/*.svelte", { cwd: ADMIN }).map((f) => join(ADMIN, f));

  it("there are components to review", () => {
    expect(files.length, "no .svelte file of the panel was located").toBeGreaterThan(20);
  });

  it("none is invoked as if it were a function", () => {
    const problems: string[] = [];

    for (const route of files) {
      const source = withoutComments(readFileSync(route, "utf-8"));

      // `const X = $derived.by(` — only `.by`, which is the one that stores the value.
      const names = new Set(
        [...source.matchAll(/const\s+(\w+)\s*=\s*\$derived\.by\s*[<(]/g)].map((m) => m[1])
      );

      for (const name of names) {
        for (const m of source.matchAll(new RegExp(`(?<![\\w.$])${name}\\s*\\(`, "g"))) {
          // The declaration itself: `const X = $derived.by(`
          if (/=\s*\$derived\.by\s*$/.test(source.slice(Math.max(0, m.index! - 40), m.index!))) {
            continue;
          }

          const line = source.slice(0, m.index!).split("\n").length;
          problems.push(
            `${route.slice(ROOT.length + 1)}:${line} — \`${name}()\`. ` +
              `\`$derived.by\` stores the RESULT, not the function: the parentheses ` +
              `throw «is not a function» and take down the render of the whole row, ` +
              `leaving the table spinning with «0 records». Remove them.`
          );
        }
      }
    }

    expect(problems, problems.join("\n\n")).toEqual([]);
  });
});
