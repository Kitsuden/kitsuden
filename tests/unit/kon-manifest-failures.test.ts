/**
 * A kon that does not load has to be noticed
 * ============================================================================
 *
 * `readKonManifest` ended in a `catch { return null }` that wrapped the entire
 * function. With that, three very different situations produced exactly the same
 * result and none said anything:
 *
 *   - the directory is not a kon        → correct, that is normal
 *   - the kon.json has an extra comma   → the kon vanishes from startup
 *   - the file cannot be read           → the kon vanishes from startup
 *
 * The last two are faults. These tests pin down that they are reported, and that a
 * manifest that does not declare a kon does not slip in as if it did.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readKonJsonManifest } from "../../apps/api/src/lib/grimoire-manifest";

const temporary: string[] = [];

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kitsuden-kon-"));
  temporary.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

let warnings: string[] = [];

beforeEach(() => {
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reading a kon's manifest", () => {
  it("reads a correct kon.json without saying anything", async () => {
    const dir = dirWith({
      "kon.json": JSON.stringify({ id: "kon-test", name: "Test", type: "kon" }),
    });

    expect((await readKonJsonManifest(dir))?.id).toBe("kon-test");
    expect(warnings).toEqual([]);
  });

  it("warns when the kon.json is broken, instead of swallowing it", async () => {
    const dir = dirWith({ "kon.json": '{ "id": "kon-broken",, }' });

    expect(await readKonJsonManifest(dir)).toBeNull();
    expect(warnings.join("\n")).toContain("is not valid JSON");
  });

  it("distinguishes 'there is no manifest' from 'the manifest is broken'", async () => {
    // Without a kon.json nothing bad happens: most directories are not kons.
    const dir = dirWith({ "something-else.txt": "hello" });

    expect(await readKonJsonManifest(dir)).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("does not accept as a kon a manifest that declares something else", async () => {
    const dir = dirWith({
      "kon.json": JSON.stringify({ id: "kitsuden-viggo", name: "Viggo", type: "theme" }),
    });

    expect(await readKonJsonManifest(dir)).toBeNull();
    expect(warnings.join("\n")).toContain("does not declare a kon");
  });

  it("still accepts the legacy manifest without `type`", async () => {
    const dir = dirWith({ "kon.json": JSON.stringify({ id: "kon-legacy", name: "Legacy" }) });

    expect((await readKonJsonManifest(dir))?.id).toBe("kon-legacy");
    expect(warnings).toEqual([]);
  });
});
