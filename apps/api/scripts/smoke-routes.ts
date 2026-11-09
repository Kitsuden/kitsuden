#!/usr/bin/env bun
/**
 * Smoke test: no registered route may blow up
 * ============================================================================
 *
 * ── WHY IT IS NEEDED ───────────────────────────────────────────────────────
 *
 * `GET /api/games/collections` had been returning 500 in production for months and
 * no test saw it. The cause was routing —`/:id` was registered
 * earlier and captured `collections` as if it were a UUID— and that kind of failure does not
 * show up in a unit test: the right handler is well written, what
 * fails is which one runs.
 *
 * `tests/unit/shadowed-routes.test.ts` covers that specific cause by reading the
 * code. This covers the SYMPTOM, wherever it comes from: every route is requested and
 * it is checked that none answers 5xx.
 *
 * ── WHAT COUNTS AS A FAILURE ───────────────────────────────────────────────
 *
 * Only 5xx. A 401 or a 404 are legitimate responses without a session and without data:
 * they mean «authentication needed» and «that id does not exist», which is exactly
 * what it should answer. A 500 means the server did not know what to do
 * with its own route.
 *
 * ── WHAT IT DOES NOT COVER ─────────────────────────────────────────────────
 *
 * Everything behind authentication. That would need a session,
 * and creating a fake administrator in CI for every startup has its own
 * cost. This is a cheap safety net, not an integration test.
 *
 * ── HOW IT REQUESTS THE ROUTES ─────────────────────────────────────────────
 *
 * With `app.request()`, the Hono method that resolves a request IN PROCESS.
 * There is no need to listen on a port, there is no startup race and there is no need to
 * pick a free port — three things that make a smoke test flaky
 * and end up getting it disabled.
 *
 *   bun run scripts/smoke-routes.ts
 */

import { app } from "../src/index";

/** Placeholder value for each `:param` segment. */
const FILLER: Record<string, string> = {
  // A valid UUID where an id is expected: arbitrary text would give a parsing
  // 500 that is the test's fault, not the code's.
  id: "00000000-0000-0000-0000-000000000000",
  konId: "kon-blog",
  kon: "kon-blog",
  key: "kon-blog",
  table: "media",
  tableName: "media",
  collection: "media",
  slug: "does-not-exist",
  channel: "general",
};

function specify(pattern: string): string {
  return pattern
    .split("/")
    .map((seg) => {
      if (!seg.startsWith(":")) return seg;
      const name = seg.slice(1).replace(/[?{].*$/, "");
      return FILLER[name] ?? "00000000-0000-0000-0000-000000000000";
    })
    .join("/");
}

interface Failure {
  route: string;
  status: number;
  body: string;
}

async function main(): Promise<void> {
  // `app.routes` is Hono's table: each entry carries method and pattern.
  const routes = (app as unknown as { routes: { method: string; path: string }[] }).routes ?? [];

  const toTest = [
    ...new Set(
      routes
        .filter((r) => r.method === "GET" || r.method === "ALL")
        // Middleware wildcards (`/*`) are not concrete routes.
        .filter((r) => !r.path.includes("*"))
        .map((r) => specify(r.path))
    ),
  ].sort();

  if (toTest.length === 0) {
    console.error("ERROR: no route was registered. The app was not mounted correctly.");
    process.exit(1);
  }

  const failures: Failure[] = [];

  for (const route of toTest) {
    try {
      const res = await app.request(route, { method: "GET" });
      if (res.status >= 500) {
        failures.push({ route, status: res.status, body: (await res.text()).slice(0, 200) });
      }
    } catch (err) {
      // An exception with no response is worse than a 500: the process could crash.
      failures.push({
        route,
        status: 0,
        body: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log(`   Smoke: ${toTest.length} routes tested, ${failures.length} with a server error`);

  if (failures.length === 0) {
    process.exit(0);
  }

  console.error("");
  console.error("ERROR: these routes respond with a SERVER error.");
  console.error("");
  console.error("  A 401 or a 404 would be fine —a session is needed, the id does not exist—.");
  console.error("  A 5xx means the request reached a place that does not know how to");
  console.error("  handle it. The most common cause here has been REGISTRATION ORDER:");
  console.error("  a route with `:param` declared before a literal one keeps");
  console.error("  the request and queries the database with the segment as if it were");
  console.error("  an id.");
  console.error("");
  for (const f of failures) {
    console.error(`   · ${f.status || "exception"}  GET ${f.route}`);
    console.error(`       ${f.body.replace(/\n/g, " ").slice(0, 160)}`);
  }
  console.error("");
  process.exit(1);
}

// ALWAYS exit: `app` drags along the Postgres pool and the process would not end
// on its own. See tests/unit/startup-scripts-finish.test.ts.
main().catch((err) => {
  console.error("ERROR in the smoke test:", err instanceof Error ? err.message : err);
  process.exit(1);
});
