/**
 * `/api/*` does not read bodies over 10 MB (from an audit: there was no
 * limit and Bun accepts 128 MB per request). Uploads and imports have a bigger
 * limit of their own.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  bodyLimit,
  datasetImportMaxBytes,
  hasOwnLimit,
  MEDIA_UPLOAD_MAX_BYTES,
  routeLimits,
} from "../../apps/api/src/lib/body-limit";

function app() {
  const a = new Hono();
  a.use("/api/*", bodyLimit(1024));
  a.post("/api/*", async (c) => c.text(String((await c.req.text()).length)));
  return a;
}

describe("bodyLimit", () => {
  it("413 above the limit, 200 below", async () => {
    expect(
      (await app().request("/api/comments", { method: "POST", body: "x".repeat(2048) })).status
    ).toBe(413);
    expect(
      (await app().request("/api/comments", { method: "POST", body: "x".repeat(100) })).status
    ).toBe(200);
  });

  it("the kons' upload prefixes use their own limit", async () => {
    expect(hasOwnLimit("/api/dms/upload")).toBe(true);
    expect(hasOwnLimit("/api/dmsx")).toBe(false);
    expect(
      (await app().request("/api/dms/upload", { method: "POST", body: "x".repeat(2048) })).status
    ).toBe(200);
  });

  // Security review 2026-11-03: /api/media and /api/datasets/import were exempt
  // and read any size. Now they have a bigger limit of their own, on the exact path.
  it("core upload and import routes have a bigger limit of their own, not none", async () => {
    const a = new Hono();
    a.use("/api/*", bodyLimit(1024, [{ path: "/api/media/upload", maxBytes: 4096 }]));
    a.post("/api/*", async (c) => c.text(String((await c.req.text()).length)));
    const post = (path: string, n: number) =>
      Promise.resolve(a.request(path, { method: "POST", body: "x".repeat(n) })).then(
        (r) => r.status
      );
    expect(await post("/api/media/upload", 2048)).toBe(200);
    expect(await post("/api/media/upload", 8192)).toBe(413);
    // The rest of /api/media is no longer exempt
    expect(await post("/api/media/folders", 2048)).toBe(413);
    expect(hasOwnLimit("/api/media/upload")).toBe(false);
    expect(hasOwnLimit("/api/datasets/import")).toBe(false);
  });

  it("the real limits: 20 files of 10 MB for media, 100 MB (configurable) for imports", () => {
    const limits = Object.fromEntries(routeLimits().map((r) => [r.path, r.maxBytes]));
    expect(limits["/api/media/upload"]).toBe(MEDIA_UPLOAD_MAX_BYTES);
    expect(MEDIA_UPLOAD_MAX_BYTES).toBe(201 * 1024 * 1024);
    expect(limits["/api/datasets/import"]).toBe(100 * 1024 * 1024);
    expect(limits["/api/datasets/import/package"]).toBe(100 * 1024 * 1024);
    const saved = process.env.DATASET_IMPORT_MAX_MB;
    process.env.DATASET_IMPORT_MAX_MB = "250";
    try {
      expect(datasetImportMaxBytes()).toBe(250 * 1024 * 1024);
      process.env.DATASET_IMPORT_MAX_MB = "nonsense";
      expect(datasetImportMaxBytes()).toBe(100 * 1024 * 1024);
    } finally {
      if (saved === undefined) delete process.env.DATASET_IMPORT_MAX_MB;
      else process.env.DATASET_IMPORT_MAX_MB = saved;
    }
  });
});
