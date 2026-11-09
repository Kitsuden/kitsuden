/**
 * A kon's admin assets: only what its declared views need
 * ============================================================================
 *
 * Security review 2026-11-03: `GET /api/kons/:konId/admin-asset/*` (no session)
 * served any `.js`/`.mjs`/`.css`/`.map` in the kon's directory. Now only the
 * `src` of a view in `admin.views[]`, files under that view's directory, and
 * `dist/admin/`. Everything else answers 404, like a missing file.
 *
 * A throwaway kon is written under packages/kons for the test and removed after.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { declaredViewSources, isDeclaredAdminAsset } from "@kitsuden/shared";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import konAssets from "../routes/kon-assets";

const KON = `kon-zz-assets-${process.pid}`;
const DIR = join(import.meta.dir, "..", "..", "..", "..", "packages", "kons", KON);

const FILES: Record<string, string> = {
  "kon.json": JSON.stringify({
    id: KON,
    name: "Asset scope test",
    version: "0.0.0",
    admin: {
      views: [
        { id: "board", type: "element", element: "zz-board", src: "./admin/board.js" },
        { id: "root", type: "element", element: "zz-root", src: "./root-view.js" },
      ],
    },
  }),
  "admin/board.js": "export {};",
  "admin/board.js.map": "{}",
  "admin/chunks/part.js": "export {};",
  "admin/board.css": ":host{}",
  "root-view.js": "export {};",
  "root-view.js.map": "{}",
  "dist/admin/built.js": "export {};",
  "server.js": "export const secret = 'server code';",
  "src/routes.js": "export {};",
  "dist/server/index.js.map": "{}",
};

const get = (path: string) => konAssets.request(`/${KON}/admin-asset/${path}`);

describe("kon admin assets are limited to declared views", () => {
  beforeAll(() => {
    for (const [rel, content] of Object.entries(FILES)) {
      const target = join(DIR, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  });

  afterAll(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  it("serves the declared views, the files next to them and dist/admin", async () => {
    for (const path of [
      "admin/board.js",
      "admin/board.js.map",
      "admin/chunks/part.js",
      "admin/board.css",
      "root-view.js",
      "root-view.js.map",
      "dist/admin/built.js",
    ]) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
    }
  });

  it("does not serve the rest of the package", async () => {
    for (const path of ["server.js", "src/routes.js", "dist/server/index.js.map"]) {
      const r = await get(path);
      expect(r.status, path).toBe(404);
      expect(await r.text()).not.toContain("server code");
    }
  });

  it("the rule, without the route", () => {
    const srcs = declaredViewSources(JSON.parse(FILES["kon.json"]!));
    expect(srcs).toEqual(["./admin/board.js", "./root-view.js"]);
    expect(isDeclaredAdminAsset("./admin/board.js", srcs)).toBe(true);
    // A view at the package root opens its own file, not the whole root
    expect(isDeclaredAdminAsset("root-view.js", srcs)).toBe(true);
    expect(isDeclaredAdminAsset("other.js", srcs)).toBe(false);
    expect(isDeclaredAdminAsset("administrator/x.js", srcs)).toBe(false);
    expect(isDeclaredAdminAsset("admin/", srcs)).toBe(false);
    // Without declared views only dist/admin
    expect(isDeclaredAdminAsset("dist/admin/x.js", [])).toBe(true);
    expect(isDeclaredAdminAsset("admin/board.js", [])).toBe(false);
    expect(declaredViewSources(null)).toEqual([]);
    expect(declaredViewSources({ admin: { views: [{ id: "grid", type: "grid" }] } })).toEqual([]);
  });
});
