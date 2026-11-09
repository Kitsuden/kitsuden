/**
 * Security (data): kon-media
 * ============================================================================
 *
 *   · Own authorization (policy "media"): before, the routes only asked for a session
 *     and the only thing stopping an arbitrary account was the prefix rule
 *     in `auth-guard.ts`. The list, the detail, the folders and the
 *     CONFIGURATION (with S3/R2 credentials) were read without being on the team.
 *   · REAL type by content: the `Content-Type` and the name sent by the
 *     client were stored; an SVG/HTML with `<script>` got in as an «image».
 *   · `PATCH` did `set({...body})`: the file's `key` could be changed.
 *   · Public transformations with no limits (width, format, quality).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { respondError } from "@kitsuden/engine";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../apps/api/src/lib/test-kon-context";
import { registerMediaPolicy } from "../../packages/core/media/media.policy";
import { createMediaRouter } from "../../packages/core/media/media.routes";
import { detectRealType, safeName } from "../../packages/core/media/real-type";
import {
  createTransformRouter,
  readTransformOptions,
} from "../../packages/core/media/transform.routes";

const EDITOR = { id: "u-editor", role: "editor" };
const ADMIN = { id: "u-admin", role: "admin" };
const ANA = { id: "u-ana", role: "user" };

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>'
);
const HTML = new TextEncoder().encode("<!doctype html><script>fetch('/api/auth')</script>");

let client: PGlite;
let app: Hono;
const saved: { key: string; type: string }[] = [];

function req(method: string, route: string, user: object | null, init: RequestInit = {}) {
  return app.request(route, {
    method,
    ...init,
    headers: {
      ...(init.headers as Record<string, string>),
      ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
    },
  });
}

function upload(name: string, bytes: Uint8Array, declaredType: string) {
  const form = new FormData();
  form.append("files", new File([bytes as BlobPart], name, { type: declaredType }));
  return { body: form };
}

beforeEach(() => {
  registerMediaPolicy();
});

afterAll(async () => {
  await client?.close();
});

beforeAll(async () => {
  client = new PGlite();
  await client.exec(
    readFileSync(join(__dirname, "../../packages/core/media/migrations/0000_initial.sql"), "utf8")
  );
  const db = drizzle(client);
  const requireAuth = async (c: any, next: any) =>
    c.get("user") ? next() : c.json({ error: "Unauthorized" }, 401);
  const ctx = createTestKonContext({
    db: { instance: db } as any,
    auth: { requireAuth } as any,
    storage: {
      put: async (key: string, content: Buffer, type: string) => {
        saved.push({ key, type });
        return { key, url: `/media/${key}`, bytes: content.length };
      },
      delete: async () => {},
      publicUrl: (k: string) => `/media/${k}`,
      getSignedDownloadUrl: async (k: string) => `/media/${k}`,
    } as any,
  });
  app = new Hono();
  app.onError((err, c) => respondError(c, err));
  app.use("*", async (c, next) => {
    const raw = c.req.header("x-test-user");
    c.set("user" as never, (raw ? JSON.parse(raw) : null) as never);
    await next();
  });
  app.route("/", createMediaRouter(ctx));
  app.route("/", createTransformRouter(ctx));

  await client.query(
    `INSERT INTO media (id, filename, original_name, mime_type, size, key, bucket, public_url)
     VALUES ('3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'a.png', 'a.png', 'image/png', 10, 'uploads/1_a.png', 'b', '/media/uploads/1_a.png')`
  );
});

describe("real type by content and safe name", () => {
  it("detects by the first bytes, not by what the client says", () => {
    expect(detectRealType(PNG)?.mime).toBe("image/png");
    expect(detectRealType(SVG)).toBeNull();
    expect(detectRealType(HTML)).toBeNull();
    expect(detectRealType(new TextEncoder().encode("%PDF-1.7\n"))?.mime).toBe("application/pdf");
  });

  it("the stored name carries no paths or the extension the client chose", () => {
    const png = { mime: "image/png", extension: "png" };
    expect(safeName("../../etc/passwd", png)).toBe("passwd.png");
    expect(safeName("..\\..\\x.html", png)).toBe("x.png");
    expect(safeName("ｐｈｏｔｏ．ｓｖｇ", png)).toBe("photo.png");
    expect(safeName("logo.svg", png)).toBe("logo.png");
    expect(safeName("", png)).toBe("file.png");
  });
});

describe("media library authorization", () => {
  it("the catalog is neither public nor open to any account", async () => {
    expect((await req("GET", "/", null)).status).toBe(401);
    expect((await req("GET", "/", ANA)).status).toBe(403);
    expect((await req("GET", "/folders", ANA)).status).toBe(403);
    expect((await req("GET", "/3f2504e0-4f89-41d3-9a0c-0305e82c3301", null)).status).toBe(401);
    expect((await req("GET", "/", EDITOR)).status).toBe(200);
  });

  it("the configuration (storage credentials) is admin only", async () => {
    expect((await req("GET", "/config", ANA)).status).toBe(403);
    expect((await req("GET", "/config", EDITOR)).status).toBe(403);
    const test = await req("POST", "/config/test-storage", EDITOR, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storage: { provider: "local", path: "/tmp/x" } }),
    });
    expect(test.status).toBe(403);
  });

  it("a normal account does not upload, edit or delete", async () => {
    expect((await req("POST", "/upload", ANA, upload("a.png", PNG, "image/png"))).status).toBe(403);
    const patch = await req("PATCH", "/3f2504e0-4f89-41d3-9a0c-0305e82c3301", ANA, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ altText: "x" }),
    });
    expect(patch.status).toBe(403);
    expect((await req("DELETE", "/3f2504e0-4f89-41d3-9a0c-0305e82c3301", ANA)).status).toBe(403);
    expect(
      (
        await req("POST", "/focal-point/3f2504e0-4f89-41d3-9a0c-0305e82c3301", ANA, {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ x: 0.5, y: 0.5 }),
        })
      ).status
    ).toBe(403);
  });
});

describe("team upload", () => {
  it("rejects SVG and HTML even if they claim to be images", async () => {
    for (const [name, bytes] of [
      ["logo.svg", SVG],
      ["photo.png", HTML],
    ] as const) {
      const r = await req("POST", "/upload", EDITOR, upload(name, bytes, "image/png"));
      const body = (await r.json()) as any;
      expect(body.files[0].success, name).toBe(false);
    }
    expect(saved.length).toBe(0);
  });

  it("stores a PNG with the detected type and a unique key with its extension", async () => {
    const r = await req("POST", "/upload", EDITOR, upload("../x.html", PNG, "text/html"));
    expect(r.status).toBe(201);
    const body = (await r.json()) as any;
    expect(body.files[0].mimeType).toBe("image/png");
    expect(saved.at(-1)!.type).toBe("image/png");
    expect(saved.at(-1)!.key).toMatch(/^uploads\/[0-9]+_[0-9a-f]{12}_x\.png$/);
  });

  it("PATCH only changes what is editable (not the key or the URL)", async () => {
    const r = await req("PATCH", "/3f2504e0-4f89-41d3-9a0c-0305e82c3301", ADMIN, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        altText: "Alt",
        key: "games/something-else.webp",
        publicUrl: "https://evil",
      }),
    });
    expect(r.status).toBe(200);
    const row = await client.query<{ key: string; public_url: string; alt_text: string }>(
      `SELECT key, public_url, alt_text FROM media WHERE id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'`
    );
    expect(row.rows[0]).toEqual({
      key: "uploads/1_a.png",
      public_url: "/media/uploads/1_a.png",
      alt_text: "Alt",
    });
  });
});

describe("public transformations with limits", () => {
  it("validates width, height, quality, format, fit and focal point", () => {
    expect(readTransformOptions({ w: "800", h: "600", fit: "inside", f: "png" })).toMatchObject({
      width: 800,
      height: 600,
      fit: "inside",
      format: "png",
    });
    for (const bad of <Record<string, string>[]>[
      { w: "100000" },
      { w: "-5" },
      { w: "abc" },
      { h: "0" },
      { q: "1000" },
      { f: "svg" },
      { f: "heif" },
      { fit: "__proto__" },
      { pos: "x" },
      { fp: "5,5" },
    ]) {
      expect(
        () => readTransformOptions(bad as Record<string, string>),
        JSON.stringify(bad)
      ).toThrow();
    }
  });

  it("an id that is not a uuid (e.g. with `..`) is a 404 in cache and transformations", async () => {
    expect((await req("GET", "/transform/..%2F..%2Fetc", null)).status).toBe(404);
    expect((await req("DELETE", "/cache/..", EDITOR)).status).toBe(404);
    expect(
      (await req("GET", "/transform/3f2504e0-4f89-41d3-9a0c-0305e82c3301?w=999999", null)).status
    ).toBe(400);
  });
});
