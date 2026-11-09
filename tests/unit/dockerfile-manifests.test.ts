/**
 * The Dockerfile has to copy ALL the workspace manifests
 * ============================================================================
 *
 * The dependencies stage copies only the `package.json` files before installing,
 * so that changing code does not invalidate the install. The idea is right; the
 * implementation was a hand-written list of 14 paths, and the workspace has
 * 53 projects.
 *
 * What was missing gave no error. Its dependencies simply were not installed, and
 * the build died much later with a `Could not resolve "openai"` that looked like
 * another problem — `openai` is declared by `packages/core/vector-search`, a
 * package of its own whose manifest nobody copied.
 *
 * Worse still: `COPY packages/kons/*​/package.json ./packages/kons/` **flattens**
 * the 30 files onto the same destination, because Docker does not preserve the
 * path with globs. Only the last one survived. No kon had its dependencies.
 *
 * ── THE RULE THAT IS GUARDED ───────────────────────────────────────────────
 *
 * The manifests are copied with `COPY --parents` and globs that follow
 * `pnpm-workspace.yaml`, not with a list. A list always goes stale: the
 * previous one did, and nobody noticed until the build failed for something else.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const DOCKERFILE = join(ROOT, "docker", "Dockerfile.prod");

/** Active COPY lines (without comments). */
function copies(source: string): string[] {
  return source
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .filter((l) => /^\s*COPY\b/.test(l));
}

describe("the Dockerfile copies the manifests by glob, not by hand", () => {
  const source = readFileSync(DOCKERFILE, "utf-8");
  const lines = copies(source);

  it("there are COPYs to inspect", () => {
    expect(lines.length).toBeGreaterThan(5);
  });

  it("uses COPY --parents for the workspace's package.json files", () => {
    const withParents = lines.filter((l) => l.includes("--parents") && l.includes("package.json"));
    expect(
      withParents.length,
      `docker/Dockerfile.prod no longer copies the package.json files with 'COPY --parents'. ` +
        `Without --parents, Docker does not preserve the source path and a glob like ` +
        `'packages/kons/*/package.json' flattens the 30 files onto the same ` +
        `destination: only the last one survives and no kon installs its dependencies.`
    ).toBeGreaterThan(0);
  });

  it("there is no longer a hand-written list of package.json files", () => {
    /**
     * Copying the root `package.json` is allowed —it is needed and is not part of
     * the workspace—, but not specific package paths.
     */
    const byHand = lines.filter((l) => {
      if (l.includes("--parents")) return false;
      if (!l.includes("package.json")) return false;
      // `COPY package.json pnpm-lock.yaml ... ./` is the root one: legitimate.
      return /COPY\s+(apps|packages)\//.test(l);
    });

    expect(
      byHand,
      `docker/Dockerfile.prod enumerates package.json files of packages one by ` +
        `one:\n\n${byHand.join("\n")}\n\n` +
        `That list goes stale silently: it came to copy 14 manifests out of ` +
        `53, and the missing packages did not fail on copy but much later, ` +
        `with a 'Could not resolve' in the middle of the build. Use 'COPY --parents' with ` +
        `globs that follow pnpm-workspace.yaml.`
    ).toEqual([]);
  });

  it("the globs cover the depth declared by pnpm-workspace.yaml", () => {
    /**
     * `pnpm-workspace.yaml` declares packages at one and two levels
     * (`packages/*` and `packages/core/*`, `packages/kons/*`, …). If the glob only
     * covered one level, the two-level ones would be left out again — which is
     * exactly how `packages/core/vector-search` was lost.
     */
    const line = lines.find((l) => l.includes("--parents") && l.includes("package.json")) ?? "";

    expect(
      line.includes("packages/*/*/package.json"),
      `The manifests glob does not cover packages at two levels ` +
        `(packages/core/*, packages/kons/*, packages/starters/*). That is how ` +
        `'packages/core/vector-search' was lost, and with it the 'openai' dependency.\n` +
        `Current line: ${line.trim()}`
    ).toBe(true);
  });
});
