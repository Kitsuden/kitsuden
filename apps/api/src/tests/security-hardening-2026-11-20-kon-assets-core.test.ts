/**
 * Kon assets: a folder in packages/core is served only if it is a core kon (H23, H42, 2026-11-20)
 * ============================================================================
 *
 * `konDirectory` fell back to `packages/core/<id without kon->` for any id, so a
 * folder there that is not a kon (no kon.json: scripts, node_modules…) was served
 * as if it were one, and the id `kon-` (stripped to "") resolved to packages/core
 * itself. Core kons are in the installed list already; the fallback is gone.
 * Throwaway files are written under packages/core and removed after.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import konAssets from "../routes/kon-assets";

const CORE = join(import.meta.dir, "..", "..", "..", "..", "packages", "core");
const NAME = `zz-not-a-kon-${process.pid}`;
const DIR = join(CORE, NAME);
// For `kon-`: a graphic directly under packages/core/graphics.
const CORE_GRAPHICS = join(CORE, "graphics");
const CORE_PAGE = `zz-h42-${process.pid}.html`;
const coreGraphicsExisted = existsSync(CORE_GRAPHICS);

describe("kon assets and packages/core", () => {
  beforeAll(() => {
    const target = join(DIR, "graphics", "page.html");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "<p>not a kon</p>");
    mkdirSync(CORE_GRAPHICS, { recursive: true });
    writeFileSync(join(CORE_GRAPHICS, CORE_PAGE), "<p>packages/core itself</p>");
  });

  afterAll(() => {
    rmSync(DIR, { recursive: true, force: true });
    if (coreGraphicsExisted) rmSync(join(CORE_GRAPHICS, CORE_PAGE), { force: true });
    else rmSync(CORE_GRAPHICS, { recursive: true, force: true });
  });

  it("a folder without kon.json under packages/core is not a kon", async () => {
    const res = await konAssets.request(`/kon-${NAME}/graphics/page.html`);
    expect(res.status).toBe(404);
  });

  it("the id `kon-` does not resolve to packages/core itself (H42)", async () => {
    const res = await konAssets.request(`/kon-/graphics/${CORE_PAGE}`);
    expect(res.status).toBe(404);
  });
});
