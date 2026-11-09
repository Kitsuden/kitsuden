/**
 * Healthchecks have to point to routes that exist
 * ============================================================================
 *
 * A healthcheck against a nonexistent route **always fails**, and the symptom
 * looks nothing like the cause. It happened twice in a row:
 *
 *   · `docker-compose.yml` queried `/api/live`. The observability routes
 *     are mounted at the ROOT (`app.route("/", observabilityRoutes)`), so the
 *     right one is `/live`. The API started, answered 200 on `/api/health`, and
 *     compose said `dependency failed to start ... is unhealthy`. The admin
 *     never came up, because it depends on `service_healthy`.
 *
 *   · `Dockerfile.prod` queried `http://localhost:80/` in the admin
 *     image. There `localhost` resolves first to `::1`, and nginx listens only on
 *     IPv4 (`listen 80;`). The site was served perfectly on port 3001 and
 *     the container showed as `unhealthy` forever, with
 *     `wget: can't connect to remote host: Connection refused` as the only clue.
 *
 * Both are one-line mistakes that cost one build cycle each.
 *
 * ── WHAT IT CHECKS ─────────────────────────────────────────────────────────
 *
 * 1. That the HTTP route of each healthcheck is declared in the code.
 * 2. That none uses `localhost` as a target, because of the IPv6 problem.
 *
 * It starts nothing: it reads the files. A test that needed Docker would not
 * run in CI and would be useless.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

interface Check {
  file: string;
  url: string;
  route: string;
  host: string;
}

/** Extracts the http(s) URLs that appear inside a healthcheck. */
function checksOf(file: string): Check[] {
  const route = join(ROOT, file);
  if (!existsSync(route)) return [];

  const text = readFileSync(route, "utf-8");
  const output: Check[] = [];

  for (const line of text.split("\n")) {
    // Only lines that are part of a healthcheck: those that invoke wget or
    // curl. That way URLs from comments or environment variables do not slip in.
    if (!/\b(wget|curl)\b/.test(line)) continue;
    if (line.trimStart().startsWith("#")) continue;

    for (const m of line.matchAll(/https?:\/\/([^/\s"']+)(\/[^\s"'|)]*)?/g)) {
      output.push({
        file,
        url: m[0],
        host: m[1] ?? "",
        route: (m[2] ?? "/").replace(/\/$/, "") || "/",
      });
    }
  }
  return output;
}

/**
 * HTTP routes that the application really declares.
 *
 * They are computed by joining the mount prefix with each handler's path,
 * because the `/api/live` failure was exactly that: the route existed, the
 * prefix did not.
 */
function declaredRoutes(): Set<string> {
  const routes = new Set<string>(["/"]);

  // Handlers mounted at the root by critical-features.
  const observability = join(ROOT, "apps", "api", "src", "lib", "observability.ts");
  if (existsSync(observability)) {
    const source = readFileSync(observability, "utf-8");
    for (const m of source.matchAll(/observabilityRoutes\.get\(\s*["'](\/[^"']*)["']/g)) {
      routes.add(m[1]!);
    }
  }

  // Handlers declared with their full path in the API index.
  const index = join(ROOT, "apps", "api", "src", "index.ts");
  if (existsSync(index)) {
    const source = readFileSync(index, "utf-8");
    for (const m of source.matchAll(/app\.(?:get|all)\(\s*["'](\/[^"']*)["']/g)) {
      routes.add(m[1]!);
    }
  }

  return routes;
}

/**
 * Healthchecks of THIRD-PARTY services, which do not query our API: their route is not
 * in our code. They are listed by name, checked by hand,
 * so that a misspelled API route does not pass as «it belongs to someone else».
 *
 *   · SeaweedFS (s3 profile): its S3 exposes `/healthz` on 8333. Checked
 *     with image 4.47: 200, and the container ends up `healthy`.
 */
const OF_THIRD_PARTY_SERVICES: Record<string, string[]> = {
  "127.0.0.1:8333": ["/healthz"],
};

describe("healthchecks point to real routes", () => {
  const checks = [...checksOf("docker-compose.yml"), ...checksOf("docker/Dockerfile.prod")];
  const declaredMany = declaredRoutes();

  it("healthchecks were found", () => {
    // If the extractor stops matching, this test would pass without looking at anything.
    expect(checks.length).toBeGreaterThan(0);
  });

  it("declared routes were found", () => {
    expect(declaredMany.size).toBeGreaterThan(2);
  });

  for (const c of checks) {
    it(`${c.file}: ${c.url}`, () => {
      // The admin is nginx serving static files: its "/" is not in the
      // API code, so only the host is required.
      const isRoot = c.route === "/";
      const isFromOtherService = OF_THIRD_PARTY_SERVICES[c.host]?.includes(c.route) ?? false;

      expect(
        isRoot || isFromOtherService || declaredMany.has(c.route),
        `The healthcheck of ${c.file} query '${c.route}', which the application ` +
          `does not declare. A healthcheck against a nonexistent route always fails: ` +
          `the container stays 'unhealthy' even though it works, and everything that ` +
          `depends on 'service_healthy' never starts.\n` +
          `Declared routes: ${[...declaredMany].sort().join(", ")}`
      ).toBe(true);

      expect(
        c.host.startsWith("localhost"),
        `The healthcheck of ${c.file} uses 'localhost'. In alpine images ` +
          `that resolves to ::1 first, and a server that listens only on IPv4 ` +
          `—like nginx with 'listen 80;'— refuses the connection. Use 127.0.0.1.`
      ).toBe(false);
    });
  }
});
