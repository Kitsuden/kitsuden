/**
 * The engine facade and cycles
 * ============================================================================
 *
 * Three `apps/api` files import engine submodules by deep path
 * (`packages/engine/src/...`) instead of through the `@kitsuden/engine` facade, and
 * each carries a comment explaining why: the engine index
 * re-exports THAT SAME file, so importing the facade from there closes
 * a cycle.
 *
 * The comment alone prevents nothing. In fact it did not: when
 * adding a `messageOf` to `module-loader.ts` and `agent-tools.ts`, an
 * `import { messageOf } from "@kitsuden/engine"` slipped in —in one case, two
 * lines below the comment that forbids it— and the cycle came back.
 *
 * This test turns the note into a rule: if a file decided to avoid the
 * facade, it cannot import it through the back door for a stray
 * utility. The right way out is to deep-import that utility too.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const API = join(ROOT, "apps", "api", "src");

/** Walks `apps/api/src` returning the .ts files that are not tests. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const input of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "build", "tests", "tests-unit"].includes(input.name)) continue;
    const route = join(dir, input.name);
    if (input.isDirectory()) {
      sourceFiles(route, acc);
      continue;
    }
    if (!input.name.endsWith(".ts") || input.name.endsWith(".test.ts")) continue;
    acc.push(route);
  }
  return acc;
}

/** `import`/`export ... from` lines, with comments already removed. */
function specifiers(source: string): string[] {
  return source
    .split(/\r?\n/)
    .filter((l) => /^\s*(import|export)\b/.test(l))
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
}

describe("engine facade", () => {
  it("whoever deep-imports the engine does not also import the facade", () => {
    const offenders: string[] = [];

    for (const route of sourceFiles(API)) {
      const lines = specifiers(readFileSync(route, "utf8"));
      const profound = lines.some((l) => /packages\/engine\/src\//.test(l));
      if (!profound) continue;

      // `import type` does not exist at runtime: it cannot close any cycle.
      const facade = lines.some(
        (l) => /["']@kitsuden\/engine["']/.test(l) && !/^\s*import\s+type\b/.test(l)
      );
      if (facade) offenders.push(route.replace(ROOT, "").replace(/\\/g, "/"));
    }

    expect(
      offenders,
      `These files avoid the engine facade on purpose (see the ` +
        `comment next to their deep import) but import it anyway, which ` +
        `reopens the cycle they were trying to avoid. Deep-import whatever ` +
        `else is missing, e.g. "packages/engine/src/errors" for messageOf. ` +
        `Files: ${offenders.join(", ")}`
    ).toEqual([]);
  });
});
