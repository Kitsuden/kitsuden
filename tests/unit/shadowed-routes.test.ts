/**
 * No literal route can be registered behind a wildcard that covers it
 * ============================================================================
 *
 * Hono resolves by REGISTRATION ORDER among patterns of the same length. A
 * route declared like this:
 *
 *     app.get("/:id", ...)          // line 145
 *     app.get("/collections", ...)  // line 283  ← never runs
 *
 * leaves the second one unreachable. And the failure does not look like a routing
 * problem, which is what makes it expensive:
 *
 *   · `GET /api/games/collections` came in through `/:id` with `id="collections"`,
 *     queried `WHERE games.id = 'collections'` and Postgres returned
 *     `invalid input syntax for type uuid`. A **500**, not a 404.
 *   · `GET /api/explorer/schema/json/courses` came in through `/schema/:kon/:table`
 *     with `kon="json"`. It returned 404 «table json not found» — the panel
 *     read it as «this table has no schema» and showed an empty form.
 *
 * In both cases the warning «parametric routes go last» was already
 * written in the file itself. A comment does not prevent it; this test does.
 *
 * ── WHAT COUNTS AS A SHADOW ────────────────────────────────────────────────
 *
 * A route A shadows B if, with the same method and the same number of
 * segments, A was registered earlier and every segment of A is either identical to that of
 * B or a parameter (`:x`). That is: A accepts everything B accepts.
 *
 * Two parameters with different names in the same position are NOT a shadow
 * of each other: `/:kon/:table` and `/:a/:b` accept the same thing, so the second one
 * loses nothing that the first had not already taken from it.
 */

import { readFileSync } from "node:fs";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { listFiles } from "./helpers/files";

const ROOT = join(__dirname, "..", "..");

interface Route {
  method: string;
  pattern: string;
  segments: string[];
  line: number;
  router: string;
}

/**
 * Extracts the `router.get("/x", …)` registrations from a file.
 *
 * They are grouped by router variable because a file can mount several, and
 * two different routers do not compete with each other.
 */
function routesOf(source: string): Route[] {
  const routes: Route[] = [];
  const re = /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|all)\(\s*(["'`])([^"'`]*)\3/g;

  for (const m of source.matchAll(re)) {
    const [, router, method, , pattern] = m;
    // `use("/*")` and global wildcards are not concrete routes.
    if (pattern.includes("*")) continue;
    if (!pattern.startsWith("/")) continue;

    routes.push({
      router,
      method,
      pattern,
      segments: pattern.split("/").filter(Boolean),
      line: source.slice(0, m.index).split("\n").length,
    });
  }
  return routes;
}

/** Does `a` accept everything `b` accepts, with a different from b? */
function overshadows(a: Route, b: Route): boolean {
  if (a.method !== b.method && a.method !== "all") return false;
  if (a.segments.length !== b.segments.length) return false;
  if (a.pattern === b.pattern) return false;

  let looser = false;
  for (let i = 0; i < a.segments.length; i++) {
    const sa = a.segments[i]!;
    const sb = b.segments[i]!;
    if (sa === sb) continue;
    if (sa.startsWith(":") && !sb.startsWith(":")) {
      looser = true; // wildcard where the other requires a literal
      continue;
    }
    return false;
  }
  return looser;
}

function routeFiles(): string[] {
  return [
    ...listFiles(join(ROOT, "apps", "api", "src"), ".ts"),
    ...listFiles(join(ROOT, "packages", "kons"), ".ts"),
    ...listFiles(join(ROOT, "packages", "core"), ".ts"),
  ].filter((f) => !f.includes("node_modules") && !f.endsWith(".d.ts") && !f.includes(".test."));
}

describe("route registration order", () => {
  const findings: string[] = [];

  for (const file of routeFiles()) {
    const source = readFileSync(file, "utf-8");
    if (!/\.(get|post|put|patch|delete)\(\s*["'`]\//.test(source)) continue;

    const routes = routesOf(source);
    const relativeValue = file
      .slice(ROOT.length + 1)
      .split(sep)
      .join("/");

    for (let i = 0; i < routes.length; i++) {
      for (let j = 0; j < i; j++) {
        const before = routes[j]!;
        const after = routes[i]!;
        if (before.router !== after.router) continue;
        if (overshadows(before, after)) {
          findings.push(
            `${relativeValue}:${after.line}  ${after.method.toUpperCase()} ${after.pattern} ` +
              `— unreachable: ${before.pattern} was registered at line ${before.line}`
          );
        }
      }
    }
  }

  it("no route is left unreachable", () => {
    expect(
      findings,
      `These routes never run because an earlier pattern covers them:\n\n` +
        `${findings.join("\n")}\n\n` +
        `Move them BEFORE the pattern that shadows them. Registering the ` +
        `literal route first and the parametric one after is the only way both ` +
        `can work: Hono does not retry with the next route when the handler ` +
        `of the first one fails.`
    ).toEqual([]);
  });
});
