/**
 * Chained `.where()` on the same builder
 * ============================================================================
 *
 * In Drizzle, `.where()` SETS the condition; it does not accumulate it.
 * Reassigning the builder to add filters one by one —
 *
 *     let q = db.select().from(t);
 *     if (a) q = q.where(eq(t.orgId, a));
 *     if (b) q = q.where(eq(t.industry, b));   // ← erases the previous filter
 *
 * — compiles, does not throw, and returns TOO MUCH. It is the worst possible
 * combination: the filter that gets lost is usually the first, and the first is
 * usually the isolation one (`organizationId`, `dataSetId`, `tenantId`).
 *
 * When this test was written there were SEVEN places like that, in six files:
 *
 *   · `tools-enhanced.ts` — the MCP search returned entries from all
 *     datasets, not just the requested one.
 *   · `crm.routes.ts` — companies, contacts and opportunities of ALL
 *     organizations as soon as a filter was combined with the search.
 *   · `esports.routes.ts` — the text filter was ignored if it came with a status.
 *   · `media.routes.ts` — the library ignored the folder when filtering by type.
 *   · `datasets.import-export.ts` — the worst: `dataSetId` was in the base
 *     query, so exporting WITH a filter took entries from all
 *     datasets into a file.
 *   · `batch.ts` and `batch-api.ts` — here it was not reading but WRITING: a
 *     `where: {}` left the UPDATE (and the DELETE) without a WHERE.
 *
 * None gave an error. All gave an answer.
 *
 * The correct way is to accumulate in an array and call ONCE:
 *
 *     const conditions = [];
 *     if (a) conditions.push(eq(t.orgId, a));
 *     if (b) conditions.push(eq(t.industry, b));
 *     const rows = await db.select().from(t)
 *       .where(conditions.length ? and(...conditions) : undefined);
 *
 * Careful when combining: a raw `sql\`A OR B\`` carries NO parentheses of its own,
 * and inside an `and()` SQL precedence turns it into `(X AND A) OR B`.
 * Use Drizzle's `or(...)`, which does group.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const AREAS = ["apps/api/src", "packages/kons", "packages/core", "packages/engine/src"];

/** `q = q.where(` — the same name on both sides of the equals sign. */
const REASSIGNMENT = /^\s*(\w+)\s*=\s*\1\s*\.where\s*\(/;

/** `let q = ...` / `const q = ...` — a new builder is born, new group. */
const DECLARATION = /^\s*(?:let|const|var)\s+(\w+)\s*(?::[^=]+)?=/;

/** `} else {` or `} else if (...) {` — a branch of a chain, not one more filter. */
const ELSE_BRANCH = /^\s*\}?\s*else\b/;

/**
 * Places where the SAME builder receives two or more `.where()` that can both
 * execute.
 *
 * The two things to distinguish so as not to nag with false alarms:
 *
 *   · A LONE reassignment is harmless: it is called once and that's it.
 *   · An `if / else if / else` too: only one branch is entered. There the
 *     builder is reassigned several times in the text but never in execution.
 *
 * What is a failure is several INDEPENDENT `if`s, each adding its
 * own — which is exactly how an optional filter is written, and that is why this
 * error repeats.
 */
function badSites(source: string): number[] {
  const lines = source.split(/\r?\n/);
  const groups = new Map<string, number[]>();
  const badOnes: number[] = [];

  const close = (name: string) => {
    const g = groups.get(name);
    // With two or more that are NOT branches of the same chain, they really accumulate.
    if (g && g.length >= 2) badOnes.push(...g);
    groups.delete(name);
  };

  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;

    const decl = DECLARATION.exec(line);
    if (decl) close(decl[1]!); // the previous builder with that name already ended

    const reassign = REASSIGNMENT.exec(line);
    if (!reassign) return;
    const name = reassign[1]!;

    // Does it hang from an `else`? The nearest guard is looked for backwards.
    let isBranch = false;
    for (let j = i - 1; j >= 0 && j > i - 6; j--) {
      const previous = lines[j]!.trim();
      if (previous === "") continue;
      if (ELSE_BRANCH.test(previous)) isBranch = true;
      if (/\bif\s*\(|\belse\b|\{$/.test(previous)) break;
    }
    if (isBranch) return;

    groups.set(name, [...(groups.get(name) ?? []), i + 1]);
  });

  for (const name of [...groups.keys()]) close(name);
  return badOnes;
}

function tsFiles(dir: string, acc: string[] = []): string[] {
  let inputs;
  try {
    inputs = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of inputs) {
    if (["node_modules", "dist", "build", ".git"].includes(e.name)) continue;
    const route = join(dir, e.name);
    if (e.isDirectory()) {
      tsFiles(route, acc);
      continue;
    }
    if (!e.name.endsWith(".ts") || e.name.endsWith(".d.ts") || e.name.endsWith(".test.ts"))
      continue;
    acc.push(route);
  }
  return acc;
}

describe("Drizzle filters", () => {
  it("nobody accumulates filters by reassigning the builder", () => {
    const offenders: string[] = [];

    for (const area of AREAS) {
      for (const route of tsFiles(join(ROOT, area))) {
        for (const line of badSites(readFileSync(route, "utf8"))) {
          offenders.push(`${route.replace(ROOT, "").replace(/\\/g, "/")}:${line}`);
        }
      }
    }

    expect(
      offenders,
      `\`.where()\` in Drizzle REPLACES the previous condition, it does not add it. ` +
        `Reassigning the builder to add filters one by one means only the ` +
        `LAST one counts, without error: the query returns too much and the filter that ` +
        `gets lost is usually the isolation one. Accumulate in an array and call ` +
        `\`.where(and(...conditions))\` just once. Places: ` +
        `${offenders.join(", ")}`
    ).toEqual([]);
  });
});
