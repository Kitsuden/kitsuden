/**
 * Every third-party container image is pinned by digest
 * ============================================================================
 *
 * A tag (`pgvector/pgvector:pg16`, `oven/bun:1.4.4-alpine`) can be moved by
 * whoever controls the upstream repository; a digest cannot. The compose files
 * and Dockerfiles pin `name:tag@sha256:…` (the tag stays for humans and for
 * Dependabot, which updates both together). See docs/install/verify-images.md.
 *
 * Our own images are the exception: their reference comes from an environment
 * variable (`KITSUDEN_API_IMAGE`…), so an operator pins THEM by digest at deploy
 * time, after verifying the signature.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

/** Image references that are ours and configurable: pinned by the operator. */
const OWN =
  /^\$\{KITSUDEN_(API|ADMIN|WEB|MCP)_IMAGE:-ghcr\.io\/kitsuden\/kitsuden\/[a-z]+:[^}]+\}$/;
/** FROM targets that are not images: earlier stages and `scratch`. */
const STAGE = /^(scratch|base|dependencies|builder|production|api|admin|web|kons)$/;

function files(): string[] {
  const compose = readdirSync(ROOT)
    .filter((f) => /^docker-compose.*\.ya?ml$/.test(f))
    .map((f) => join(ROOT, f));
  const docker = join(ROOT, "docker");
  const dockerfiles: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^Dockerfile/.test(e.name)) dockerfiles.push(p);
    }
  };
  walk(docker);
  return [...compose, ...dockerfiles];
}

function references(path: string): { line: number; ref: string }[] {
  const out: { line: number; ref: string }[] = [];
  readFileSync(path, "utf8")
    .split(/\r?\n/)
    .forEach((text, i) => {
      if (text.trimStart().startsWith("#")) return;
      const image = /^\s*image:\s*["']?([^"'\s#]+)/.exec(text);
      const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(text);
      const ref = image?.[1] ?? from?.[1];
      if (ref) out.push({ line: i + 1, ref });
    });
  return out;
}

describe("container images", () => {
  it("every third-party image is pinned by digest", () => {
    const unpinned: string[] = [];
    for (const f of files()) {
      for (const { line, ref } of references(f)) {
        if (STAGE.test(ref) || OWN.test(ref)) continue;
        if (!/@sha256:[0-9a-f]{64}$/.test(ref))
          unpinned.push(`${f.slice(ROOT.length + 1)}:${line} ${ref}`);
      }
    }
    expect(unpinned).toEqual([]);
  });

  it("the guard actually reads the files (it is not passing on nothing)", () => {
    const all = files().flatMap(references);
    expect(all.filter((r) => r.ref.includes("@sha256:")).length).toBeGreaterThanOrEqual(10);
  });
});
