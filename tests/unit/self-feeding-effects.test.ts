/**
 * An `$effect` cannot depend on what it causes itself
 * ============================================================================
 *
 * ── THE FAILURE ──────────────────────────────────────────────────────────────
 *
 * In Svelte 5, everything that is READ inside an effect becomes a dependency of it,
 * including what is read inside the functions it calls. A load that reads the list it has
 * just assigned (`total = rows.length`), or an effect that bumps a counter it also reads
 * (`reloadKey += 1`), re-runs itself: loading triggers loading.
 *
 * It was first found in the old data explorer (it only showed once the list had a real
 * row), and again while the lists moved to the list template: the Actions page froze the
 * tab because its effect did `reloadKey += 1` in the open.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 *
 * If an effect calls a function that writes state, the dependencies are WRITTEN by hand
 * and the call goes inside `untrack`. A counter is bumped inside `untrack` too.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "packages", "admin", "src");
const LIST_VIEW = join(SRC, "lib", "components", "list", "ListView.svelte");

function svelteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    // The vendored kit has its own tests.
    if (e.isDirectory()) {
      if (e.name !== "tallao" && e.name !== "node_modules") out.push(...svelteFiles(path));
    } else if (e.name.endsWith(".svelte")) out.push(path);
  }
  return out;
}

const effectsOf = (source: string): string[] =>
  [...source.matchAll(/\$effect\(\(\) => \{([\s\S]*?)\n {2}\}\);/g)].map((m) => m[1]!);

describe("the list template does not reload itself", () => {
  const source = readFileSync(LIST_VIEW, "utf-8");

  it("the load is isolated inside the effect", () => {
    const withLoad = effectsOf(source).filter((body) => /\bload\(\)/.test(body));
    expect(withLoad.length, "no `$effect` that loads the list was found").toBeGreaterThan(0);
    for (const body of withLoad) {
      expect(
        body.includes("untrack("),
        "There is an `$effect` that calls `load()` without `untrack`: everything the load " +
          "reads becomes a dependency of the effect, including what it writes itself."
      ).toBe(true);
    }
  });

  it("the load does not read the list it has just assigned", () => {
    const load = source.slice(source.indexOf("async function load()"));
    const body = load.slice(0, load.indexOf("\n  }\n") + 4);
    expect(body).toContain("rows = result.rows;");
    // After the assignment, the function works on `result` / local values, not on `rows`.
    const after = body.slice(body.indexOf("rows = result.rows;") + "rows = result.rows;".length);
    expect(
      /\brows\.(map|length|filter)\b/.test(after),
      "The load reads `rows` right after assigning it. Use the response (a local value): " +
        "reading what you just wrote ties the function to its own output."
    ).toBe(false);
  });
});

describe("no effect bumps a counter it also reads", () => {
  it("`x += 1` / `x++` inside an `$effect` goes inside `untrack`", () => {
    const offenders: string[] = [];
    for (const file of svelteFiles(SRC)) {
      const source = readFileSync(file, "utf-8");
      for (const body of effectsOf(source)) {
        // Only the effect's own statements: a bump inside a callback it defines
        // (`.then(() => n += 1)`, `onclick`) runs later, outside the tracking.
        const direct = body
          .split("\n")
          .filter((line) => /^\s{4,6}\w+(\.\w+)* (\+= 1|-= 1);|^\s{4,6}\w+(\+\+|--);/.test(line));
        // Only reactive counters matter: a plain `let n = 0` is not tracked.
        const reactive = direct.filter((line) => {
          const name = line.trim().split(/[^\w]/)[0]!;
          return source.includes(`let ${name} = $state`);
        });
        if (reactive.length > 0 && !body.includes("untrack(")) {
          offenders.push(`${file.slice(SRC.length + 1)}: ${reactive[0]!.trim()}`);
        }
      }
    }
    expect(
      offenders,
      "These effects write a counter they read, so they re-run themselves for ever " +
        "(the page freezes). Wrap the write in `untrack(() => { … })`."
    ).toEqual([]);
  });
});
