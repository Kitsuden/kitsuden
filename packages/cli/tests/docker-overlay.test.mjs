/**
 * docker-compose.kons.yml follows kitsuden.kons.json
 * ============================================================================
 *
 *   pnpm --filter @kitsuden/cli build && node --test tests/docker-overlay.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { syncDockerOverlay } from "../dist/kons/docker-overlay.js";

function project(kons) {
  const root = mkdtempSync(join(tmpdir(), "kitsuden-overlay-"));
  mkdirSync(join(root, "packages", "kons"), { recursive: true });
  writeFileSync(join(root, "kitsuden.kons.json"), JSON.stringify({ kons }, null, 2));
  return root;
}

describe("docker-compose.kons.yml", () => {
  it("is not created unless asked, and lists the copied kons once created", () => {
    const root = project({
      "kon-blog": { source: "../kitsuden-kons", mode: "copy" },
      "kon-wiki": { source: "../kitsuden-kons", mode: "copy" },
      "kon-dev": { source: "./packages/kons/kon-dev", mode: "link" },
    });
    assert.equal(syncDockerOverlay(root), null);
    assert.equal(existsSync(join(root, "docker-compose.kons.yml")), false);

    const r = syncDockerOverlay(root, true);
    assert.equal(r.written, true);
    assert.deepEqual(r.kons, ["blog", "wiki"]);
    const yaml = readFileSync(join(root, "docker-compose.kons.yml"), "utf8");
    assert.match(yaml, /KITSUDEN_KONS: "blog,wiki"/);
    assert.match(yaml, /kons: \.\.\/kitsuden-kons/);
  });

  it("once it exists, a later sync rewrites it without being asked", () => {
    const root = project({ "kon-blog": { source: "../kitsuden-kons", mode: "copy" } });
    syncDockerOverlay(root, true);
    writeFileSync(
      join(root, "kitsuden.kons.json"),
      JSON.stringify({ kons: { "kon-crm": { source: "../kitsuden-kons", mode: "copy" } } })
    );
    assert.equal(syncDockerOverlay(root).written, true);
    assert.match(
      readFileSync(join(root, "docker-compose.kons.yml"), "utf8"),
      /KITSUDEN_KONS: "crm"/
    );
  });

  it("refuses to write what would be wrong: a git source, or two folders", () => {
    const git = project({
      "kon-blog": { source: "https://github.com/Kitsuden/kitsuden-kons.git", mode: "copy" },
    });
    assert.equal(syncDockerOverlay(git, true).written, false);
    const two = project({
      "kon-blog": { source: "../a", mode: "copy" },
      "kon-wiki": { source: "../b", mode: "copy" },
    });
    assert.equal(syncDockerOverlay(two, true).written, false);
  });
});
