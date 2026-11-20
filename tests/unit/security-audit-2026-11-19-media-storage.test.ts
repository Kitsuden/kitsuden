/**
 * Security audit 2026-11-19: private media stays private
 * ============================================================================
 *
 *   - The bundled SeaweedFS gave the anonymous identity `Read:<bucket>`, so every `private/` key could be read
 *     unsigned by whoever knew it (and every presigned URL shows its key). Anonymous now reads only the public
 *     prefixes, and `private` can never be one of them.
 *   - The local `/media` route decided "private" on the raw key and opened the normalized one, so
 *     `uploads/../private/x` skipped the signature. `isPrivateKey` now normalizes the same way.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const store = await import("../../apps/api/src/lib/store");

const SCRIPT = resolve(__dirname, "../../docker/seaweedfs-startup.sh");
const hasSh = spawnSync("sh", ["-c", "exit 0"]).status === 0;

function anonymousGrants(env: Record<string, string> = {}) {
  const r = spawnSync("sh", [SCRIPT], {
    env: { PATH: process.env.PATH ?? "", SEAWEEDFS_PRINT_ANONYMOUS: "1", ...env },
    encoding: "utf8",
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

describe("SeaweedFS anonymous identity", () => {
  it("is never granted the whole bucket", () => {
    const text = readFileSync(SCRIPT, "utf8");
    expect(text).not.toMatch(/"Read:\$BUCKET"/);
    expect(text).not.toMatch(/"Read:\$\{?BUCKET\}?"\s*\]/);
  });

  it.skipIf(!hasSh)("reads only the public prefixes, never private/", () => {
    const r = anonymousGrants();
    expect(r.status).toBe(0);
    const grants = JSON.parse(r.out) as string[];
    expect(grants).toContain("Read:kitsuden-media/uploads/*");
    for (const g of grants) {
      expect(g).toMatch(/^Read:kitsuden-media\/[A-Za-z0-9._-]+\/\*$/);
      expect(g.toLowerCase()).not.toContain("/private/");
    }
  });

  it.skipIf(!hasSh)("takes S3_PUBLIC_PREFIXES and refuses private or anything wider", () => {
    const ok = anonymousGrants({ S3_PUBLIC_PREFIXES: "uploads, avatars", S3_BUCKET: "media-b" });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.out)).toEqual(["Read:media-b/uploads/*", "Read:media-b/avatars/*"]);
    for (const bad of ["private", "uploads,Private", "*", "a/b", "..", " , "]) {
      const r = anonymousGrants({ S3_PUBLIC_PREFIXES: bad });
      expect(r.status, bad).not.toBe(0);
      expect(r.out, bad).toBe("");
    }
    expect(anonymousGrants({ S3_BUCKET: "a/b" }).status).not.toBe(0);
  });
});

describe("isPrivateKey sees the key the disk will open", () => {
  it("dot segments, backslashes and case do not hide private/", () => {
    for (const key of [
      "uploads/../private/koe/media/c/x.ogg",
      "./private/x",
      "uploads/./../private/x",
      "uploads\\..\\private\\x",
      "Private/x",
      "PRIVATE/x",
      "//private/x",
      "private",
    ]) {
      expect(store.isPrivateKey(key), key).toBe(true);
    }
  });

  it("a key that climbs above the root fails closed", () => {
    expect(store.isPrivateKey("../uploads/private/x")).toBe(true);
    expect(store.isPrivateKey("a/../../uploads/private/x")).toBe(true);
  });

  it("public keys stay public", () => {
    for (const key of [
      "uploads/a.png",
      "uploads/private-notes.png",
      "privately/a.png",
      "cartas/x/y.webp",
    ]) {
      expect(store.isPrivateKey(key), key).toBe(false);
    }
  });
});
