/**
 * Stripping comments from a TypeScript source without eating the code
 * ============================================================================
 *
 * Several probes look for patterns in the code (`CREATE TABLE`, `kitsuden.config`)
 * and have to ignore MENTIONS in comments: those files document
 * exactly the pattern being chased, so without this they would report themselves.
 *
 * ── WHY THE OBVIOUS REGEX DOES NOT WORK ────────────────────────────────────
 *
 * The naive version —`source.replace(/\/\*[\s\S]*?\*\//g, "")`— deletes code.
 * In `apps/api/src/index.ts` there are sixteen `/*` and only five `*​/`: the others
 * are wildcard routes inside strings, like `"/api/v1/*"`. The regex pairs
 * one of those with a `*​/` that is thousands of lines further down and takes with it
 * everything in between — I measured 23 KB of 38 KB.
 *
 * The symptom is the worst possible one in a probe: it does not fail, it simply stops
 * looking at most of the file and passes green.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * A comment block only counts if its `/*` opens the line (nothing but
 * spaces before it). A `/*` inside a string always has something before it
 * —quote, parenthesis, `=`— so the distinction is reliable and needs no
 * parser.
 *
 * Line breaks are preserved by substituting spaces: if they were deleted,
 * the line numbers the probe reports would be those of the trimmed text and not
 * those of the file, and would send you to read the wrong place.
 */

export function withoutComments(source: string): string {
  return (
    source
      // Blocks that open a line: `/** …` or `/* …`, up to their close.
      .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, (m) => m.replace(/[^\n]/g, " "))
      .split("\n")
      .map((l) => (l.trimStart().startsWith("//") ? "" : l))
      .join("\n")
  );
}
