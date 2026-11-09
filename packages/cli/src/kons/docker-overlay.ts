/**
 * docker-compose.kons.yml, kept in step with what the project installed
 * ============================================================================
 *
 * The API image installs the kons named in its `KITSUDEN_KONS` build argument, copied from an extra
 * build context `kons` (a checkout of a kons repository): see docs/kons/installing.md. People kept
 * that list by hand, next to `kitsuden.kons.json`, and the two drifted: a kon added locally was
 * missing from the image, or the image asked for one that was removed.
 *
 * `kitsuden kon add --docker` writes the overlay once; from then on every `kon add` and
 * `kon remove` rewrites it from `kitsuden.kons.json`. It is only written when it can be right: all
 * the copied kons come from ONE local folder (the build context). A git source or kons from two
 * folders would need two contexts, which the image does not take; then it says so and leaves the
 * file alone.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { readKonsFile } from "./installation.js";

export const DOCKER_OVERLAY = "docker-compose.kons.yml";

export type OverlayResult =
  | { written: true; path: string; kons: string[]; context: string }
  | { written: false; reason: string };

const isGit = (source: string) =>
  /^(https?:|git@|ssh:|git:)/.test(source) || source.endsWith(".git");

/**
 * Rewrites the overlay when it exists or `create` is set. Returns what it did, or why it did not.
 */
export function syncDockerOverlay(root: string, create = false): OverlayResult | null {
  const path = join(root, DOCKER_OVERLAY);
  if (!create && !existsSync(path)) return null;

  const installed = Object.entries(readKonsFile(root).kons).filter(([, k]) => k.mode !== "link");
  const sources = new Set<string>();
  for (const [, k] of installed) {
    if (!k.source) continue;
    if (isGit(k.source)) {
      return {
        written: false,
        reason: `a kon comes from a git source (${k.source}); the image needs a local checkout as its build context`,
      };
    }
    sources.add(resolve(root, k.source));
  }
  if (sources.size > 1) {
    return {
      written: false,
      reason: `the kons come from ${sources.size} folders; the image takes one build context`,
    };
  }

  const ids = installed.map(([id]) => id.replace(/^kon-/, "")).sort();
  const [source] = [...sources];
  const context = source ? toPosix(relativeOrAbsolute(root, source)) : "../kitsuden-kons";

  const yaml = `# Written by \`kitsuden kon add/remove\` from kitsuden.kons.json — do not edit by hand.
# The kons this project installed, for the API image (docs/kons/installing.md):
#   docker compose -f docker-compose.yml -f ${DOCKER_OVERLAY} build kitsuden_api
services:
  kitsuden_api:
    build:
      additional_contexts:
        kons: ${context}
      args:
        KITSUDEN_KONS: "${ids.join(",")}"
`;
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (before !== yaml) writeFileSync(path, yaml, "utf8");
  return { written: true, path, kons: ids, context };
}

function relativeOrAbsolute(from: string, to: string): string {
  const rel = relative(from, to);
  return rel && !isAbsolute(rel) ? rel : to;
}

const toPosix = (p: string) => p.split("\\").join("/");
