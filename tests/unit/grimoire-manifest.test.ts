/**
 * The theme is not the grimoire
 * ============================================================================
 *
 * In `packages/grimoires/<id>/` there are two manifests and they look similar enough
 * to be confused: both carry `id`, `name` and `version`.
 *
 *   grimoire.json → type: "grimoire", id: "grimoire-viggo", kons: [...]
 *   kitsuden.json → type: "theme",    id: "kitsuden-viggo", css_entry
 *
 * Six places read the second as a fallback for the first without checking which
 * was which. Since the theme has no `kons`, a missing or broken `grimoire.json` did not
 * give an error: it gave a grimoire with the theme's id and ZERO kons mounted.
 *
 * What is protected here is exactly that: that the fallback keeps existing for
 * legacy grimoires that only ship kitsuden.json, but NEVER accepts
 * the theme in its place.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  readGrimoireKons,
  readGrimoireManifest,
  manifestIsOfType,
} from "../../apps/api/src/lib/grimoire-manifest";

const ROOT = join(__dirname, "..", "..");
const GRIMOIRES = join(ROOT, "packages", "grimoires");

const temporary: string[] = [];

/** Creates a fake grimoire directory with the files passed to it. */
function dirWithManifests(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "kitsuden-grimoire-"));
  temporary.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

const TOPIC = {
  id: "kitsuden-viggo",
  name: "Viggo",
  version: "1.0.0",
  type: "theme",
  css_entry: "variables.css",
};

const GRIMOIRE = {
  id: "grimoire-viggo",
  name: "Viggo",
  version: "1.0.0",
  type: "grimoire",
  kons: ["kon-esports", "kon-broadcast"],
};

describe("manifestIsOfType", () => {
  it("rejects the theme manifest when a grimoire is expected", () => {
    expect(manifestIsOfType(TOPIC, "grimoire")).toBe(false);
  });

  it("accepts the grimoire manifest", () => {
    expect(manifestIsOfType(GRIMOIRE, "grimoire")).toBe(true);
  });

  it("accepts a legacy manifest without `type`", () => {
    // The old form declared no type. Rejecting it would break third-party
    // grimoires that load fine today, and the fallback exists precisely for them.
    expect(manifestIsOfType({ id: "something", name: "Something" }, "grimoire")).toBe(true);
  });

  it("rejects what is not an object with an id", () => {
    expect(manifestIsOfType(null, "grimoire")).toBe(false);
    expect(manifestIsOfType("grimoire-viggo", "grimoire")).toBe(false);
    expect(manifestIsOfType({ name: "no id" }, "grimoire")).toBe(false);
    expect(manifestIsOfType({ id: "" }, "grimoire")).toBe(false);
  });

  it("separates kon from grimoire in both directions", () => {
    expect(manifestIsOfType({ id: "kon-crm", type: "kon" }, "kon")).toBe(true);
    expect(manifestIsOfType({ id: "kon-crm", type: "kon" }, "grimoire")).toBe(false);
    expect(manifestIsOfType(GRIMOIRE, "kon")).toBe(false);
  });
});

describe("readGrimoireManifest", () => {
  it("prefers grimoire.json even if kitsuden.json is next to it", async () => {
    const dir = dirWithManifests({ "grimoire.json": GRIMOIRE, "kitsuden.json": TOPIC });

    const read = await readGrimoireManifest(dir);

    expect(read?.id).toBe("grimoire-viggo");
    expect(read?.kons).toEqual(["kon-esports", "kon-broadcast"]);
  });

  it("does NOT fall back to the theme when grimoire.json is missing", async () => {
    // This is the regression. It used to return the theme: id "kitsuden-viggo" and
    // zero kons, with no error, and the grimoire ended up falsely registered.
    const dir = dirWithManifests({ "kitsuden.json": TOPIC });

    expect(await readGrimoireManifest(dir)).toBeNull();
    expect(await readGrimoireKons(dir)).toEqual([]);
  });

  it("does NOT fall back to the theme when grimoire.json is corrupt", async () => {
    const dir = dirWithManifests({ "grimoire.json": "{ this is not json", "kitsuden.json": TOPIC });

    expect(await readGrimoireManifest(dir)).toBeNull();
  });

  it("still accepts the kitsuden.json of a legacy grimoire", async () => {
    const dir = dirWithManifests({
      "kitsuden.json": { id: "grimoire-legacy", name: "Legacy", bundled_modules: ["kon-blog"] },
    });

    expect((await readGrimoireManifest(dir))?.id).toBe("grimoire-legacy");
    expect(await readGrimoireKons(dir)).toEqual(["kon-blog"]);
  });

  it("returns null if there is no manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kitsuden-empty-"));
    temporary.push(dir);
    mkdirSync(join(dir, "sub"), { recursive: true });

    expect(await readGrimoireManifest(dir)).toBeNull();
  });
});

describe("the repository's real grimoires", () => {
  const IDS = [
    "grimoire-corporate",
    "grimoire-default",
    "grimoire-sharepoint",
    "grimoire-documents",
  ];

  it.each(IDS)("%s resolves to its own id, not the theme's", async (id) => {
    const manifest = await readGrimoireManifest(join(GRIMOIRES, id));

    expect(manifest).not.toBeNull();
    expect(manifest!.id).toBe(id);
    expect(manifest!.type).toBe("grimoire");
    // The theme's id starts with "kitsuden-" (or is "sharepoint"): if it ever
    // sneaks back in, this catches it.
    expect(manifest!.id.startsWith("kitsuden-")).toBe(false);
  });
});
