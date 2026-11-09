/**
 * The `/api/*` 404 suggests routes without hanging the API (security review F3/F8)
 *
 * An anonymous caller writes the path (up to ~16 KB) and it was compared with
 * every route using a full edit distance: O(routes × length²) on the single thread.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  boundedDistance,
  canSuggest,
  forgetKonRouters,
  forgetSuggestionSpend,
  registerKonRouter,
  SUGGESTIONS_PER_MINUTE,
  suggestRoutes,
} from "../../apps/api/src/lib/kon-routes";

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

const noop = () => undefined;

beforeAll(() => {
  forgetKonRouters();
  const routes: { method: string; path: string; handler: unknown }[] = [
    { method: "GET", path: "/tournaments/:id", handler: noop },
    { method: "GET", path: "/tournaments/:id/report", handler: noop },
    { method: "POST", path: "/tournaments/:id/report", handler: noop },
    { method: "GET", path: "/players", handler: noop },
    { method: "GET", path: "/files/*", handler: noop },
  ];
  // Many routes with a parameter, with the same segment count as the attack.
  for (let i = 0; i < 300; i++) routes.push({ method: "GET", path: `/r${i}/:id`, handler: noop });
  // And with literals on both sides of the parameter: the common part cannot be trimmed.
  for (let i = 0; i < 300; i++)
    routes.push({ method: "GET", path: `/x${i}/:id/report`, handler: noop });
  registerKonRouter("kon-test-routes", "/api/esports", { routes });
});

afterAll(() => forgetKonRouters());

describe("boundedDistance", () => {
  it("matches Levenshtein up to the cap and gives cap+1 above it", () => {
    const pairs = [
      ["", ""],
      ["abc", "abc"],
      ["kitten", "sitting"],
      ["/api/esports/tournaments/x/reports", "/api/esports/tournaments/x/report"],
      ["abcdef", "azced"],
      ["flaw", "lawn"],
      ["a", "bbbbbbbb"],
      ["/api/a/b/c", "/api/x/y/z/w"],
    ] as const;
    for (const [a, b] of pairs) {
      const real = levenshtein(a, b);
      for (const cap of [0, 1, 2, 3, 5, 10]) {
        expect(boundedDistance(a, b, cap), `${a}|${b}|${cap}`).toBe(real <= cap ? real : cap + 1);
      }
    }
  });
});

describe("suggestRoutes", () => {
  it("still suggests the route with a typo and the Allow for the wrong method", () => {
    const s = suggestRoutes("GET", "/api/esports/tournaments/abc/reports");
    expect(s.didYouMean[0]).toEqual({ method: "GET", path: "/api/esports/tournaments/:id/report" });
    expect(suggestRoutes("DELETE", "/api/esports/tournaments/abc/report").allow).toEqual([
      "GET",
      "POST",
    ]);
    expect(suggestRoutes("GET", "/api/esports/files/a/b").allow).toEqual(["GET"]);
  });

  it("a huge path is compared with nothing and answers at once", () => {
    for (const length of [201, 2_000, 16_000]) {
      const path = `/api/esports/r1/${"x".repeat(length)}`;
      const start = performance.now();
      const s = suggestRoutes("GET", path);
      expect(performance.now() - start, `length ${length}`).toBeLessThan(50);
      expect(s.didYouMean).toEqual([]);
    }
    const slashes = `/api/${"/".repeat(16_000)}x`;
    const start = performance.now();
    suggestRoutes("GET", slashes);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it("at the length cap, 600 routes with a parameter do not cost either", () => {
    const path = `/api/esports/r1/${"y".repeat(180)}`;
    const both = `/api/esports/q1/${"y".repeat(170)}/repord`;
    expect(both.length).toBeLessThanOrEqual(200);
    const start = performance.now();
    for (let i = 0; i < 20; i++) {
      suggestRoutes("GET", path + i);
      suggestRoutes("GET", both.slice(0, -1) + (i % 10));
    }
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("per-client suggestion budget", () => {
  it("past the minute's budget no more are computed; another client is not affected", () => {
    forgetSuggestionSpend();
    const t0 = 1_000_000;
    for (let i = 0; i < SUGGESTIONS_PER_MINUTE; i++)
      expect(canSuggest("203.0.113.9", t0 + i)).toBe(true);
    expect(canSuggest("203.0.113.9", t0 + 100)).toBe(false);
    expect(canSuggest("198.51.100.7", t0 + 100)).toBe(true);
    // Once the minute is over, it has a budget again.
    expect(canSuggest("203.0.113.9", t0 + 60_000)).toBe(true);
  });
});
