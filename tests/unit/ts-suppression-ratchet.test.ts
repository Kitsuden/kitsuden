/**
 * TypeScript suppressions ratchet
 * ============================================================================
 *
 * Sibling of `any-ratchet`, and for the same reason: `strict: true` guarantees
 * nothing on the lines where someone turned the checker off.
 *
 * But there is a difference here that matters. An `any` is an imprecision; a
 * `@ts-ignore` is the compiler saying "this is wrong" and someone
 * answering "shut up". One session found one that hid a real data
 * failure: `dbQuery.where()` called twice in the MCP server, which in
 * Drizzle REPLACES the previous condition instead of combining it — the
 * `dataSetId` filter was lost and the search returned entries from all
 * datasets. TypeScript prevented it. The `@ts-ignore` did not say why.
 *
 * ── THE TWO RULES ──────────────────────────────────────────────────────────
 *
 * 1. NO suppression without an explanation. A mute silence is indistinguishable from
 *    an oversight, and nobody dares remove it just in case. With a written reason,
 *    the next person to come along can judge it.
 * 2. The total does not go up. Lower the ceiling when you clean up; never raise it
 *    to get a commit through.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

/**
 * Suppression ceiling per area. Measured debt, not a target.
 *
 * Most of it is `@ts-nocheck` in generated files (drizzle), CLI
 * templates —where it is correct: they reference things that do not exist until the
 * project is generated— and loose scripts.
 */
const CEILINGS: Record<string, number> = {
  "apps/api/src": 11,
  "packages/engine/src": 4,
  // Zero, and it stays that way: the kons are the surface that is published and that
  // outsiders write. If one needs to suppress something, let it justify it
  // by raising this number on purpose and not by accident.
  "packages/kons": 0,
  "packages/core": 6,
  "packages/mcp-server/src": 1,
};

const DIRECTIVE = /@ts-(ignore|expect-error|nocheck)\b/;

/**
 * What follows the directive on the same line, if anything follows.
 *
 * No `$` anchor: in files with Windows line endings the line ends
 * in `\r`, which `.` does not capture and `$` does not cross — the `match` failed entirely and every
 * reason came out empty. In a CRLF repository that turns the guard into a
 * detector of nothing that also accuses correct code.
 */
function reasonOf(line: string): string {
  const m = line.match(/@ts-(?:ignore|expect-error|nocheck)\b([^\r\n]*)/);
  if (!m) return "";
  // Any separator is accepted: `--`, `-`, `:` or the text directly.
  return m[1].replace(/^[\s\-:—]+/, "").trim();
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

function traverse(dir: string): Finding[] {
  const output: Finding[] = [];

  function walk(actual: string): void {
    let inputs;
    try {
      inputs = readdirSync(actual, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of inputs) {
      if (["node_modules", "dist", ".git", "build", ".svelte-kit"].includes(e.name)) continue;
      const route = join(actual, e.name);

      if (e.isDirectory()) {
        walk(route);
        continue;
      }
      if (!/\.(ts|tsx|svelte)$/.test(e.name) || e.name.endsWith(".d.ts")) continue;
      // Tests may need to suppress in order to provoke errors on purpose.
      if (/\.(test|spec)\.ts$/.test(e.name)) continue;

      const lines = readFileSync(route, "utf8").split("\n");
      lines.forEach((l, i) => {
        if (DIRECTIVE.test(l)) {
          output.push({
            file: route.replace(ROOT, "").replace(/\\/g, "/"),
            line: i + 1,
            text: l,
          });
        }
      });
    }
  }

  walk(join(ROOT, dir));
  return output;
}

describe("TypeScript suppressions ratchet", () => {
  for (const [area, ceiling] of Object.entries(CEILINGS)) {
    it(`${area} does not exceed ${ceiling} suppressions`, () => {
      const n = traverse(area).length;
      expect(
        n,
        n > ceiling
          ? `${area} went up to ${n} (ceiling ${ceiling}). A @ts-ignore is the compiler ` +
              `warning about a real problem: fix it instead of silencing it.`
          : `${area} went down to ${n}: lower the ceiling in tests/unit/ts-suppression-ratchet.test.ts`
      ).toBeLessThanOrEqual(ceiling);
    });
  }

  it("no suppression without an explanation", () => {
    // The rule that really matters. A mute `@ts-ignore` cannot be judged
    // or removed: the next person to come along does not know whether it covers a real problem or
    // has been redundant for two years.
    const muted = Object.keys(CEILINGS)
      .flatMap((a) => traverse(a))
      .filter((h) => reasonOf(h.text).length < 4);

    expect(
      muted.length,
      muted.length === 0
        ? ""
        : `Unexplained suppressions:\n` +
            muted.map((m) => `  ${m.file}:${m.line}`).join("\n") +
            `\n\nWrite WHY: "// @ts-ignore -- the library does not publish types".`
    ).toBe(0);
  });
});
