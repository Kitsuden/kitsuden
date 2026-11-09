/**
 * Image presets and transformations with local storage.
 *
 * `/preset/:id/:preset` redirected to `/transform/:id`, and that redirected to
 * `getSignedDownloadUrl(transformKey)` WITHOUT checking that it existed: with local
 * disk that function only composes `/media/transforms/...`, so every preset
 * URL ended in a 404 (the `/media/*` originals were visible). Now the
 * transformation is read with `ctx.storage.get`, generated if missing and served.
 *
 * The store here is a Map, like a disk: `get` returns null if there is
 * nothing, just like `readObject` locally and on S3.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../apps/api/src/lib/test-kon-context";
import { registerMediaPolicy } from "../../packages/core/media/media.policy";
import { createTransformRouter, outputFormat } from "../../packages/core/media/transform.routes";

const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const WITHOUT_ORIGINAL = "9b2f5c3e-1d4a-4c8b-9e7f-2a6b8c0d1e3f";

const store = new Map<string, { bytes: Buffer; type: string }>();
let writes = 0;
let client: PGlite;
let app: Hono;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(
    readFileSync(join(__dirname, "../../packages/core/media/migrations/0000_initial.sql"), "utf8")
  );
  const original = await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 40, b: 90 } },
  })
    .png()
    .toBuffer();
  store.set("uploads/1_photo.png", { bytes: original, type: "image/png" });

  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as never,
    // The focal point and cache routes require a session: here they are let through
    // (the authorization of `DELETE /cache/:id` is covered by the matrix).
    auth: { requireAuth: async (_c: unknown, next: () => Promise<void>) => next() } as never,
    storage: {
      put: async (key: string, bytes: Buffer, type: string) => {
        writes++;
        store.set(key, { bytes, type });
        return { key, url: `/media/${key}`, bytes: bytes.length };
      },
      get: async (key: string) => store.get(key)?.bytes ?? null,
      list: async (prefix: string) => [...store.keys()].filter((k) => k.startsWith(prefix)),
      delete: async (key: string) => {
        store.delete(key);
      },
      publicUrl: (k: string) => `/media/${k}`,
      // What local mode does: compose the URL, whether it exists or not.
      getSignedDownloadUrl: async (k: string) => `/media/${k}`,
      getSignedUploadUrl: async () => {
        throw new Error("S3 only");
      },
    },
  });
  registerMediaPolicy();
  app = new Hono();
  // `DELETE /cache/:id` requires media permission: an administrator.
  app.use("*", async (c, next) => {
    c.set("user" as never, { id: "u-admin", role: "admin" } as never);
    await next();
  });
  app.route("/", createTransformRouter(ctx));

  await client.query(
    `INSERT INTO media (id, filename, original_name, mime_type, size, key, bucket, public_url) VALUES
     ('${ID}', 'photo.png', 'photo.png', 'image/png', 10, 'uploads/1_photo.png', 'b', '/media/uploads/1_photo.png'),
     ('${WITHOUT_ORIGINAL}', 'lost.png', 'lost.png', 'image/png', 10, 'uploads/2_lost.png', 'b', '/media/uploads/2_lost.png')`
  );
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  for (const k of [...store.keys()]) if (k.startsWith("transforms/")) store.delete(k);
  writes = 0;
});

describe("presets with local storage", () => {
  it("/preset/:id/thumbnail returns the image (200), not a redirect to a nonexistent file", async () => {
    const r = await app.request(`/preset/${ID}/thumbnail`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/webp");
    const meta = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(150);
    expect(meta.height).toBe(150);
  });

  it("the second time the stored one is served, without generating again", async () => {
    await app.request(`/preset/${ID}/medium`);
    expect(writes).toBe(1);
    const r = await app.request(`/preset/${ID}/medium`);
    expect(r.status).toBe(200);
    expect(writes).toBe(1);
    expect(
      [...store.keys()].some((k) => k.startsWith(`transforms/${ID}/`) && k.endsWith(".webp"))
    ).toBe(true);
  });

  it("without a requested format the original's is kept", async () => {
    const r = await app.request(`/transform/${ID}?w=100`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect((await sharp(Buffer.from(await r.arrayBuffer())).metadata()).width).toBe(100);
  });

  it("if the original is missing, 404 (not 500)", async () => {
    expect((await app.request(`/preset/${WITHOUT_ORIGINAL}/thumbnail`)).status).toBe(404);
  });

  it("outputFormat: the requested one, else the original's, else webp", () => {
    expect(outputFormat("avif", "image/png")).toBe("avif");
    expect(outputFormat("auto", "image/jpeg")).toBe("jpeg");
    expect(outputFormat(undefined, "image/svg+xml")).toBe("webp");
  });
});

describe("DELETE /cache/:id", () => {
  it("deletes the stored transformations of that image and only those (before: storage.list did not exist, 500)", async () => {
    await app.request(`/preset/${ID}/thumbnail`);
    await app.request(`/preset/${ID}/small`);
    store.set(`transforms/${WITHOUT_ORIGINAL}/other.webp`, {
      bytes: Buffer.from("x"),
      type: "image/webp",
    });

    const r = await app.request(`/cache/${ID}`, { method: "DELETE" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ success: true, cleared: 2 });
    expect([...store.keys()].filter((k) => k.startsWith(`transforms/${ID}/`))).toEqual([]);
    expect(store.has(`transforms/${WITHOUT_ORIGINAL}/other.webp`)).toBe(true);
    expect(store.has("uploads/1_photo.png")).toBe(true);
  });

  it("without stored transformations, cleared: 0", async () => {
    const r = await app.request(`/cache/${ID}`, { method: "DELETE" });
    expect(await r.json()).toEqual({ success: true, cleared: 0 });
  });
});
