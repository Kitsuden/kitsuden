/**
 * Cache invalidation by tag, and the conditional-GET helper (2026-11-20)
 * ============================================================================
 *
 * Invalidating by key pattern SCANs the whole keyspace and misses entries whose
 * key does not name what they were built from (a list, a search). A tag says it:
 * `invalidateTags("page:<id>")` drops exactly what read that page. And the page
 * builder's ETag helpers are now the engine's, for any kon.
 */

import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cachedQuery, cacheSetTagged, invalidateTags } from "../../apps/api/src/lib/cache";
import { conditionalJson, etagMatches, weakEtag } from "../../packages/engine/src/http-cache";

const saved = process.env.VALKEY_URL;
beforeAll(() => {
  delete process.env.VALKEY_URL; // the in-process cache
});
afterAll(() => {
  if (saved !== undefined) process.env.VALKEY_URL = saved;
});

describe("invalidateTags", () => {
  it("drops every entry stored with the tag, and only those", async () => {
    let builds = 0;
    const build = async () => ++builds;
    const k = `t-${Date.now()}`;
    await cachedQuery(`${k}:list`, 60, build, { tags: ["page:1", "pages"] });
    await cachedQuery(`${k}:one`, 60, build, { tags: ["page:1"] });
    await cachedQuery(`${k}:other`, 60, build, { tags: ["page:2"] });
    expect(builds).toBe(3);

    // Cached: no rebuild.
    await cachedQuery(`${k}:list`, 60, build, { tags: ["page:1", "pages"] });
    expect(builds).toBe(3);

    await invalidateTags("page:1");
    await cachedQuery(`${k}:list`, 60, build, { tags: ["page:1", "pages"] });
    await cachedQuery(`${k}:one`, 60, build, { tags: ["page:1"] });
    await cachedQuery(`${k}:other`, 60, build, { tags: ["page:2"] });
    expect(builds).toBe(5); // list and one rebuilt, other kept
  });

  it("cacheSetTagged stores with tags; a malformed tag is ignored", async () => {
    let builds = 0;
    const k = `s-${Date.now()}`;
    await cacheSetTagged(k, "v", 60, ["dataset:9", "bad tag with spaces"]);
    expect(await cachedQuery(k, 60, async () => (++builds, "rebuilt"))).toBe("v");
    await invalidateTags("dataset:9");
    expect(await cachedQuery(k, 60, async () => (++builds, "rebuilt"))).toBe("rebuilt");
    await invalidateTags(); // nothing to do, no error
  });
});

describe("conditional GET helpers", () => {
  it("a weak ETag that changes with the body, matched weakly", () => {
    const a = weakEtag({ x: 1 });
    expect(a).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(weakEtag({ x: 2 })).not.toBe(a);
    expect(etagMatches(a, a)).toBe(true);
    expect(etagMatches(a.replace(/^W\//, ""), a)).toBe(true);
    expect(etagMatches(`"other", ${a}`, a)).toBe(true);
    expect(etagMatches("*", a)).toBe(true);
    expect(etagMatches(undefined, a)).toBe(false);
  });

  it("conditionalJson answers 304 with no body when nothing changed", async () => {
    const app = new Hono();
    const body = { id: 1, title: "Home" };
    app.get("/x", (c) =>
      conditionalJson(c, body, {
        lastModified: "2026-11-20T00:00:00Z",
        cacheControl: "no-cache",
      })
    );
    const first = await app.request("/x");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag")!;
    expect(first.headers.get("last-modified")).toBe("Fri, 20 Nov 2026 00:00:00 GMT");
    expect(first.headers.get("cache-control")).toBe("no-cache");

    const again = await app.request("/x", { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  it("the page builder uses the engine's helpers", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const routes = readFileSync(
      join(__dirname, "..", "..", "packages", "core", "blocks", "blocks.routes.ts"),
      "utf8"
    );
    expect(routes).toContain("weakEtag(body)");
    expect(routes).not.toContain("function etagOf(");
  });
});
