/**
 * Enum filters without casts
 * ============================================================================
 *
 * This pattern was in 25 places across 15 files:
 *
 *     const status = c.req.query("status");
 *     if (status) conditions.push(eq(table.status, status as any));
 *
 * `status` is unvalidated text from the URL, and the column is a
 * PostgreSQL enum. With a value that does not belong, the query does NOT return zero
 * rows: it **fails**. `invalid input value for enum dms_document_status`. A
 * client typo produced a 500, and the message exposed the internal name of the
 * type.
 *
 * It is the same class of failure that showed up at the MCP boundary and in `kon-dms`:
 * an `as any` on something that crosses a boundary hides an assumption that nobody
 * checks. Here the assumption was "whatever comes in the URL is a value of the
 * enum".
 *
 * The right way is `eqEnum`, which checks the value against `enumValues` —the
 * list the column itself carries— and returns `undefined` if it does not belong.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const AREAS = ["apps/api/src", "packages/kons", "packages/core", "packages/engine/src"];

/** `eq(table.column, value as any)` — comparison with a cast on the value. */
const CAST_IN_COMPARISON = /\b(eq|ne)\(\s*\w+\.\w+\s*,\s*[\w.?]+\s+as\s+any\s*\)/;

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

describe("comparisons against columns", () => {
  it("nobody compares a column with a value cast to any", () => {
    const offenders: string[] = [];

    for (const area of AREAS) {
      for (const route of tsFiles(join(ROOT, area))) {
        readFileSync(route, "utf8")
          .split(/\r?\n/)
          .forEach((line, i) => {
            // Comments that document the old pattern do not count.
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
            if (!CAST_IN_COMPARISON.test(line)) return;
            offenders.push(`${route.replace(ROOT, "").split(sep).join("/")}:${i + 1}`);
          });
      }
    }

    expect(
      offenders,
      `Comparing a column with a value cast to \`any\` skips the ` +
        `check. If the column is a Postgres ENUM, a value that does not ` +
        `belong does not return zero rows: it makes the whole query fail (500). ` +
        `Use \`eqEnum(column, value)\` from @kitsuden/engine, which validates against ` +
        `the values the column itself declares. Sites: ${offenders.join(", ")}`
    ).toEqual([]);
  });
});
