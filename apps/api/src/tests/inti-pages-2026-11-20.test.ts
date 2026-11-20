/**
 * What Inti (and any site that caches pages) asked of the page builder, 2026-11-20
 *
 *   - renaming a page emitted `page:updated` with the NEW slug only: a site kept the page
 *     cached under the old address; now it carries `previousSlug`, and the API's own cache
 *     for the old slug is purged too;
 *   - walking every page paid a `count(*)` per batch and an OFFSET that re-reads the
 *     batches before; now `?paging=cursor` / `?cursor=` keyset-pages and counts nothing;
 *   - `/api/search` did not search pages at all; now it answers `pages` beside `results`,
 *     only what anyone may see (published, not session-only, visible blocks).
 */
import { describe, it, expect, beforeAll } from "bun:test";

import { app } from "../index";
import { events } from "../lib/events";

import { isDatabaseAvailable, generateTestId, enterAs } from "./setup";

let dbAvailable = false;
let cookie = "";
const marker = `zq${generateTestId()
  .replace(/[^a-z0-9]/gi, "")
  .toLowerCase()}`;

async function call(path: string, method = "GET", body?: unknown, withCookie = true) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (withCookie && cookie) headers.set("Cookie", cookie);
  const res = await app.request(
    new Request(`http://localhost:3000${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

async function newPage(over: Record<string, unknown> = {}) {
  const slug = `inti-${generateTestId()}`.toLowerCase();
  const { status, body } = await call("/api/page-builder/pages", "POST", {
    title: "Inti page",
    slug,
    status: "published",
    ...over,
  });
  expect(status).toBe(201);
  return body as { id: string; slug: string };
}

describe("page builder for Inti", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    ({ cookie } = await enterAs(app, {
      email: `inti-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Inti",
      role: "admin",
    }));
  });

  it("a rename emits page:updated with the previous slug", async () => {
    if (!dbAvailable) return;
    const page = await newPage();
    const seen: Array<Record<string, unknown>> = [];
    const listener = (data: unknown) => seen.push(data as Record<string, unknown>);
    events.on("page:updated", listener);
    try {
      const renamed = `${page.slug}-new`;
      expect(
        (await call(`/api/page-builder/pages/${page.id}`, "PATCH", { slug: renamed })).status
      ).toBe(200);
      expect(
        (await call(`/api/page-builder/pages/${page.id}`, "PATCH", { title: "Same slug" })).status
      ).toBe(200);
      await Bun.sleep(20);
      const mine = seen.filter((e) => e.id === page.id);
      expect(mine[0]).toEqual({ id: page.id, slug: renamed, previousSlug: page.slug });
      // An edit that keeps the slug does not claim a rename.
      expect(mine[1]).toEqual({ id: page.id, slug: renamed });
      // The old address is gone from the API too.
      expect(
        (await call(`/api/page-builder/pages/${page.slug}`, "GET", undefined, false)).status
      ).toBe(404);
    } finally {
      events.off("page:updated", listener);
    }
  });

  it("cursor paging walks every page once, without a count", async () => {
    if (!dbAvailable) return;
    const layout = `l${generateTestId()}`.toLowerCase().slice(0, 40);
    const made = new Set<string>();
    for (let i = 0; i < 5; i++) made.add((await newPage({ layout })).id);

    const seen: string[] = [];
    let cursor: string | null = null;
    let first = true;
    for (let guard = 0; guard < 10; guard++) {
      const q: string = first ? "paging=cursor" : `cursor=${encodeURIComponent(cursor!)}`;
      first = false;
      const r = await call(`/api/page-builder/pages?layout=${layout}&limit=2&${q}`);
      expect(r.status).toBe(200);
      expect(r.body.totalDocs).toBeUndefined();
      expect(r.body.docs.length).toBeLessThanOrEqual(2);
      seen.push(...r.body.docs.map((d: { id: string }) => d.id));
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen.length).toBe(5);
    expect(new Set(seen)).toEqual(made);

    // The offset form still answers as before.
    const offset = await call(`/api/page-builder/pages?layout=${layout}&limit=2&offset=2`);
    expect(offset.body.totalDocs).toBe(5);
    expect(offset.body.offset).toBe(2);

    expect((await call(`/api/page-builder/pages?cursor=not-a-cursor`)).status).toBe(400);
  });

  it("/api/search answers the pages anyone may see", async () => {
    if (!dbAvailable) return;
    const visible = await newPage({
      title: `Guide ${marker}`,
      blocks: [{ type: "text", content: { text: `inside ${marker}block words` } }],
    });
    const draft = await newPage({ title: `Draft ${marker}`, status: "draft" });
    const privatePage = await newPage({ title: `Members ${marker}`, requireAuth: true });

    const r = await call("/api/search", "POST", { query: marker, type: "fulltext" }, false);
    expect(r.status).toBe(200);
    const ids = (r.body.pages as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(visible.id);
    expect(ids).not.toContain(draft.id);
    expect(ids).not.toContain(privatePage.id);
    const hit = r.body.pages.find((p: { id: string }) => p.id === visible.id);
    expect(hit).toMatchObject({ type: "page", slug: visible.slug });

    // Text that only lives in a block is found too.
    const inBlock = await call(
      "/api/search",
      "POST",
      { query: `${marker}block`, type: "fulltext" },
      false
    );
    expect(inBlock.body.pages.map((p: { id: string }) => p.id)).toContain(visible.id);

    // A hidden block's text is not searchable.
    const hiddenPage = await newPage({
      blocks: [{ type: "text", isVisible: false, content: { text: `${marker}hidden` } }],
    });
    const hidden = await call(
      "/api/search",
      "POST",
      { query: `${marker}hidden`, type: "fulltext" },
      false
    );
    expect(hidden.body.pages.map((p: { id: string }) => p.id)).not.toContain(hiddenPage.id);

    // Opting out, and the second page of results, carry no pages.
    expect(
      (await call("/api/search", "POST", { query: marker, pages: false }, false)).body.pages
    ).toEqual([]);
    expect(
      (await call("/api/search", "POST", { query: marker, offset: 20 }, false)).body.pages
    ).toEqual([]);
  });
});
