/**
 * `listObjects` on local disk.
 *
 * `DELETE /api/media/cache/:id` called `ctx.storage.list`, which did not exist in
 * any store: it always answered 500. Now it exists and locally it walks the
 * prefix's folder; here it is checked against a real temporary directory
 * (keys come out with `/` on Windows too, and a prefix with `..`
 * does not list outside the store).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let dir: string;
let listObjects: (prefix: string) => Promise<string[]>;
const prior = { route: process.env.STORAGE_LOCAL_PATH, prov: process.env.DEFAULT_STORAGE_PROVIDER };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kitsuden-store-"));
  mkdirSync(join(dir, "transforms", "abc", "sub"), { recursive: true });
  mkdirSync(join(dir, "transforms", "abcd"), { recursive: true });
  writeFileSync(join(dir, "transforms", "abc", "a.webp"), "a");
  writeFileSync(join(dir, "transforms", "abc", "sub", "b.webp"), "b");
  writeFileSync(join(dir, "transforms", "abcd", "c.webp"), "c");

  process.env.STORAGE_LOCAL_PATH = dir;
  process.env.DEFAULT_STORAGE_PROVIDER = "local";
  vi.resetModules();
  ({ listObjects } = await import("../../apps/api/src/lib/store"));
});

afterAll(() => {
  if (prior.route === undefined) delete process.env.STORAGE_LOCAL_PATH;
  else process.env.STORAGE_LOCAL_PATH = prior.route;
  if (prior.prov === undefined) delete process.env.DEFAULT_STORAGE_PROVIDER;
  else process.env.DEFAULT_STORAGE_PROVIDER = prior.prov;
  rmSync(dir, { recursive: true, force: true });
});

describe("listObjects (local disk)", () => {
  it("returns the keys under the prefix folder, with subfolders and / separator", async () => {
    expect(await listObjects("transforms/abc/")).toEqual([
      "transforms/abc/a.webp",
      "transforms/abc/sub/b.webp",
    ]);
  });

  it("a folder that does not exist is an empty list, not an error", async () => {
    expect(await listObjects("transforms/does-not-exist/")).toEqual([]);
  });

  it("a prefix that leaves the store throws instead of listing outside", async () => {
    await expect(listObjects("../../")).rejects.toThrow(/outside the allowed directory/);
  });
});
