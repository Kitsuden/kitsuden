/**
 * Page builder: what a visual editor (Inti's Kitsuden adapter) needs from the API
 *
 * Each case is a failure seen against a real instance:
 *   - a clone dropped `visibleFrom`/`visibleUntil`, so publishing a draft made a scheduled
 *     block public early and next to the hidden original;
 *   - publishing a draft took ~3N+6 calls and, cut by the agent quota, left the public page
 *     with 3 of its 25 blocks (now `POST /pages/:id/publish-draft`, one transaction);
 *   - two editors saving two fields of one block lost one (now `contentPatch` + If-Match);
 *   - a block edit left the page's `updatedAt` (the sitemap's lastmod) old;
 *   - `/block-types` listed 12 types while the API saves 36+;
 *   - nothing told a site its page changed (now `page:updated`), and GET sent no ETag.
 */
import { describe, it, expect, beforeAll } from "bun:test";

import { app } from "../index";
import { events } from "../lib/events";

import { isDatabaseAvailable, generateTestId, enterAs } from "./setup";

let dbAvailable = false;
let cookie = "";

function req(path: string, opts: RequestInit = {}): Request {
  const headers = new Headers(opts.headers);
  if (cookie) headers.set("Cookie", cookie);
  headers.set("Content-Type", "application/json");
  return new Request(`http://localhost:3000/api/page-builder${path}`, { ...opts, headers });
}

async function call(
  path: string,
  method = "GET",
  body?: unknown,
  headers?: Record<string, string>
) {
  const res = await app.request(
    req(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  );
  const text = await res.text();
  return { res, status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

async function newPage(blocks: unknown[] = []) {
  const slug = `pb-${generateTestId()}`.toLowerCase();
  const { status, body } = await call("/pages", "POST", {
    title: "Contract page",
    slug,
    status: "published",
    blocks,
  });
  expect(status).toBe(201);
  return body as { id: string; slug: string; updatedAt: string };
}

async function rawBlocks(pageId: string) {
  // As the team sees them, hidden ones included: straight from the table
  const { db } = await import("../db");
  const { sql } = await import("drizzle-orm");
  const result: any = await db.execute(
    sql`SELECT id, type, sort_order, is_visible, visible_from, visible_until, content
        FROM block_contents WHERE page_id = ${pageId} ORDER BY sort_order`
  );
  return (result.rows ?? result) as any[];
}

const NEXT_WEEK = new Date(Date.now() + 7 * 86400_000).toISOString();

describe("page builder contract for visual editors", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    ({ cookie } = await enterAs(app, {
      email: `pb-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Page builder",
      role: "admin",
    }));
  });

  it("/api/version announces the two new capabilities", async () => {
    if (!dbAvailable) return;
    const res = await app.request(new Request("http://localhost:3000/api/version"));
    const body = (await res.json()) as any;
    expect(body.contracts["page-builder-publish"]).toBe(1);
    expect(body.contracts["page-builder-patch"]).toBe(1);
    expect(body.contracts["page-builder"]).toBe(1);
  });

  it("clone keeps each block's schedule", async () => {
    if (!dbAvailable) return;
    const page = await newPage([
      { type: "text", content: { text: "now" } },
      { type: "text", content: { text: "later" }, visibleFrom: NEXT_WEEK },
    ]);
    // `visibleFrom` is not accepted on page create: set it on the block
    const [, later] = await rawBlocks(page.id);
    await call(`/blocks/${later.id}`, "PATCH", { visibleFrom: NEXT_WEEK });

    const { status, body: copy } = await call(`/pages/${page.id}/clone`, "POST", {
      slug: `${page.slug}-draft`,
    });
    expect(status).toBe(201);
    const copied = await rawBlocks(copy.id);
    expect(copied).toHaveLength(2);
    expect(copied[1].visible_from).not.toBeNull();

    // And so the draft shows only the block that is public today
    const draft = await call(`/pages/${copy.id}`);
    expect(draft.body.blocks.map((b: any) => b.content.text)).toEqual(["now"]);
  });

  it("publish-draft replaces the shown blocks in one go and keeps hidden and scheduled ones", async () => {
    if (!dbAvailable) return;
    const page = await newPage([
      { type: "text", content: { text: "old A" } },
      { type: "text", content: { text: "hidden" }, isVisible: false },
      { type: "text", content: { text: "old B" } },
      { type: "text", content: { text: "scheduled" } },
    ]);
    const before = await rawBlocks(page.id);
    await call(`/blocks/${before[3].id}`, "PATCH", { visibleFrom: NEXT_WEEK });

    const { body: draft } = await call(`/pages/${page.id}/clone`, "POST", {
      slug: `${page.slug}-draft`,
      title: page.slug,
    });
    const draftShown = (await call(`/pages/${draft.id}`)).body.blocks;
    expect(draftShown).toHaveLength(2);
    await call(`/blocks/${draftShown[0].id}`, "PATCH", { content: { text: "new A" } });
    await call(`/pages/${draft.id}/blocks`, "POST", { type: "text", content: { text: "new C" } });
    await call(`/pages/${draft.id}`, "PATCH", { title: "Edited title", metaTitle: "SEO" });

    const published = await call(`/pages/${page.id}/publish-draft`, "POST", { draftId: draft.id });
    expect(published.status).toBe(200);
    expect(published.body.id).toBe(page.id);
    expect(published.body.slug).toBe(page.slug);
    expect(published.body.title).toBe("Edited title");
    expect(published.body.metaTitle).toBe("SEO");
    expect(published.body.blocks.map((b: any) => b.content.text)).toEqual([
      "new A",
      "old B",
      "new C",
    ]);

    const after = await rawBlocks(page.id);
    const texts = after.map((b) => b.content.text);
    // Hidden and scheduled blocks of the original are still there, once
    expect(texts.filter((t) => t === "hidden")).toHaveLength(1);
    expect(texts.filter((t) => t === "scheduled")).toHaveLength(1);
    expect(after.find((b) => b.content.text === "hidden").sort_order).toBe(1);
    expect(texts).not.toContain("old A");

    // The draft is gone
    expect((await call(`/pages/${draft.id}`)).status).toBe(404);
  });

  it("publish-draft refuses what is not a draft and changes nothing", async () => {
    if (!dbAvailable) return;
    const page = await newPage([{ type: "text", content: { text: "keep" } }]);
    const other = await newPage([{ type: "text", content: { text: "other" } }]);

    const notDraft = await call(`/pages/${page.id}/publish-draft`, "POST", { draftId: other.id });
    expect(notDraft.status).toBe(400);
    const self = await call(`/pages/${page.id}/publish-draft`, "POST", { draftId: page.id });
    expect(self.status).toBe(400);
    const missing = await call(`/pages/${page.id}/publish-draft`, "POST", {
      draftId: "00000000-0000-4000-8000-000000000000",
    });
    expect(missing.status).toBe(404);

    expect((await rawBlocks(page.id)).map((b) => b.content.text)).toEqual(["keep"]);
    expect((await call(`/pages/${other.id}`)).status).toBe(200);
  });

  it("publish-draft needs a session", async () => {
    if (!dbAvailable) return;
    const page = await newPage();
    const res = await app.request(
      new Request(`http://localhost:3000/api/page-builder/pages/${page.id}/publish-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId: page.id }),
      })
    );
    expect([401, 403]).toContain(res.status);
  });

  it("contentPatch changes one field and keeps the others", async () => {
    if (!dbAvailable) return;
    const page = await newPage([
      {
        type: "cards",
        content: {
          columns: 3,
          cards: [
            { id: "a", title: "One" },
            { id: "b", title: "Two" },
          ],
        },
      },
    ]);
    const [block] = await rawBlocks(page.id);

    // Two editors, two fields, one after the other: both survive
    await call(`/blocks/${block.id}`, "PATCH", {
      contentPatch: [{ path: "cards.0.title", value: "First" }],
    });
    const second = await call(`/blocks/${block.id}`, "PATCH", {
      contentPatch: [{ path: "cards.1.title", value: "Second" }],
    });
    expect(second.status).toBe(200);
    expect(second.body.content.cards.map((c: any) => c.title)).toEqual(["First", "Second"]);
    expect(second.body.content.columns).toBe(3);
  });

  it("contentPatch refuses prototype paths and mixing with content", async () => {
    if (!dbAvailable) return;
    const page = await newPage([{ type: "text", content: { text: "x" } }]);
    const [block] = await rawBlocks(page.id);
    for (const path of ["__proto__.polluted", "constructor.prototype.x", "a..b"]) {
      const r = await call(`/blocks/${block.id}`, "PATCH", { contentPatch: [{ path, value: 1 }] });
      expect(r.status).toBe(400);
    }
    const both = await call(`/blocks/${block.id}`, "PATCH", {
      content: { text: "y" },
      contentPatch: [{ path: "text", value: "z" }],
    });
    expect(both.status).toBe(400);
    expect(({} as any).polluted).toBeUndefined();
  });

  it("If-Match: a stale version is a 409 with the current block, the right one writes", async () => {
    if (!dbAvailable) return;
    const page = await newPage([{ type: "text", content: { text: "v1" } }]);
    const read = (await call(`/pages/${page.id}`)).body.blocks[0];

    const first = await call(
      `/blocks/${read.id}`,
      "PATCH",
      { contentPatch: [{ path: "text", value: "v2" }] },
      { "If-Match": `"${read.updatedAt}"` }
    );
    expect(first.status).toBe(200);

    // The second editor still holds the version read before
    const stale = await call(
      `/blocks/${read.id}`,
      "PATCH",
      { contentPatch: [{ path: "text", value: "v3" }] },
      { "If-Match": `"${read.updatedAt}"` }
    );
    expect(stale.status).toBe(409);
    expect(stale.body.current.content.text).toBe("v2");

    const retry = await call(`/blocks/${read.id}`, "PATCH", {
      contentPatch: [{ path: "text", value: "v3" }],
      expectedUpdatedAt: stale.body.current.updatedAt,
    });
    expect(retry.status).toBe(200);
    expect(retry.body.content.text).toBe("v3");

    const garbage = await call(
      `/blocks/${read.id}`,
      "PATCH",
      { name: "x" },
      { "If-Match": '"not a date"' }
    );
    expect(garbage.status).toBe(400);
  });

  it("block writes move the page's updatedAt and emit page:updated", async () => {
    if (!dbAvailable) return;
    const page = await newPage([{ type: "text", content: { text: "a" } }]);
    const seen: Array<{ id: string; slug: string }> = [];
    const listener = (data: unknown) => seen.push(data as any);
    events.on("page:updated", listener);
    try {
      let last = new Date((await call(`/pages/${page.id}`)).body.updatedAt).getTime();
      const [block] = await rawBlocks(page.id);
      const writes: Array<[string, string, unknown]> = [
        [`/pages/${page.id}/blocks`, "POST", { type: "text", content: { text: "b" } }],
        [`/blocks/${block.id}`, "PATCH", { content: { text: "a2" } }],
        [`/blocks/${block.id}/duplicate`, "POST", undefined],
        [
          `/pages/${page.id}/blocks/reorder`,
          "POST",
          { blockOrders: [{ id: block.id, sortOrder: 9 }] },
        ],
        [`/blocks/${block.id}`, "DELETE", undefined],
      ];
      for (const [path, method, body] of writes) {
        await Bun.sleep(5);
        const r = await call(path, method, body);
        expect(r.status).toBeLessThan(300);
        const now = new Date((await call(`/pages/${page.id}`)).body.updatedAt).getTime();
        expect(now).toBeGreaterThan(last);
        last = now;
      }
      // after commit: give the deferred emits a tick
      await Bun.sleep(20);
      expect(
        seen.filter((e) => e.id === page.id && e.slug === page.slug).length
      ).toBeGreaterThanOrEqual(writes.length);
    } finally {
      events.off("page:updated", listener);
    }
  });

  it("/block-types lists every type the API saves", async () => {
    if (!dbAvailable) return;
    const { body } = await call("/block-types");
    const { BLOCK_TYPES } = await import("../../../../packages/core/blocks/blocks.schema");
    const listed = body.blockTypes.map((t: any) => t.type);
    expect([...listed].sort()).toEqual([...BLOCK_TYPES].sort());
    expect(body.blockTypes.find((t: any) => t.type === "hero").described).toBe(true);
    const tierList = body.blockTypes.find((t: any) => t.type === "tier-list");
    expect(tierList.described).toBe(false);
    expect(tierList.schema).toEqual({});
  });

  it("GET /pages/:id sends ETag and Last-Modified and answers 304", async () => {
    if (!dbAvailable) return;
    const page = await newPage([{ type: "text", content: { text: "cached" } }]);
    const first = await call(`/pages/${page.id}`);
    const etag = first.res.headers.get("etag");
    expect(etag).toMatch(/^W\/".+"$/);
    expect(first.res.headers.get("last-modified")).toBeTruthy();
    expect(first.res.headers.get("cache-control")).toContain("no-cache");

    const again = await call(`/pages/${page.id}`, "GET", undefined, { "If-None-Match": etag! });
    expect(again.status).toBe(304);

    await call(`/blocks/${first.body.blocks[0].id}`, "PATCH", { content: { text: "changed" } });
    const changed = await call(`/pages/${page.id}`, "GET", undefined, { "If-None-Match": etag! });
    expect(changed.status).toBe(200);
    expect(changed.res.headers.get("etag")).not.toBe(etag);
  });
});
