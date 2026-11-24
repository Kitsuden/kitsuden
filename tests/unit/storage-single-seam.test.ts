/**
 * Storage has one seam: kons store files through `ctx.storage`, never with a raw S3 client
 * ============================================================================
 *
 * `apps/api/src/lib/storage.ts` picks the bucket for every key with `bucketFor` (`private/…` goes to
 * `S3_PRIVATE_BUCKET` when it is set). It used to export the raw client (`s3`, `getS3Client`) and `BUCKET`,
 * re-exported by `@kitsuden/engine`: a kon writing `PutObject({ Bucket: BUCKET, Key: "private/…" })`
 * would have put a customer's file in the public bucket. Nothing used them, which made it the cheap moment
 * to close the door. These checks keep it closed:
 *
 *   · storage.ts exports none of them, and neither the engine nor `services/storage` re-exports them;
 *   · no kon (`packages/core`, `packages/kons`, `packages/grimoires`) imports the AWS SDK or `lib/storage`
 *     directly. The one exception is the media kon's settings probe, which may only run `HeadBucket` on a
 *     bucket the admin typed in.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const RAW = ["s3", "getS3Client", "BUCKET", "PUBLIC_URL"];

/** Names a module exports with `export const|function|let|class <name>`. */
function declaredExports(source: string): string[] {
  return [...source.matchAll(/^export\s+(?:async\s+)?(?:const|let|function|class)\s+(\w+)/gm)].map(
    (m) => m[1]!
  );
}

/** Names inside every `export { … } from "<path ending in from>"` block. */
function reExportsFrom(source: string, from: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (!m[2]!.endsWith(from)) continue;
    for (const part of m[1]!.split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]!
        .trim();
      if (name) names.push(name);
    }
  }
  return names;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    // `scripts/` holds build tooling (bundler externals name the SDK), not kon code.
    if (["node_modules", "dist", "scripts"].includes(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|js|mjs|svelte)$/.test(name)) out.push(path);
  }
  return out;
}

describe("the raw S3 client stays inside storage.ts", () => {
  it("storage.ts exports no client and no bucket name", () => {
    const exported = declaredExports(read("apps/api/src/lib/storage.ts"));
    for (const name of RAW) expect(exported, name).not.toContain(name);
    expect(exported).toContain("bucketFor");
  });

  it("neither the engine nor services/storage re-exports them", () => {
    for (const file of ["packages/engine/index.ts", "apps/api/src/services/storage.ts"]) {
      const names = reExportsFrom(read(file), "lib/storage");
      expect(names.length, file).toBeGreaterThan(0);
      for (const name of RAW) expect(names, `${file}: ${name}`).not.toContain(name);
    }
  });
});

describe("kons store files only through ctx.storage", () => {
  const PROBE = ["packages", "core", "media", "storage.adapter.ts"].join(sep);
  const files = ["packages/core", "packages/kons", "packages/grimoires"].flatMap((d) =>
    sourceFiles(join(ROOT, d))
  );

  it("finds the kon sources it checks", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("no kon imports the AWS SDK or apps/api/src/lib/storage", () => {
    const offenders = files
      .filter((f) => !f.endsWith(PROBE))
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        return (
          /["']@aws-sdk\//.test(text) ||
          /from\s+["'][^"']*apps\/api\/src\/lib\/(storage|store)["']/.test(text)
        );
      })
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("the media settings probe only checks that a bucket answers", () => {
    const text = read("packages/core/media/storage.adapter.ts");
    const commands = [...text.matchAll(/\b(\w+Command)\b/g)].map((m) => m[1]);
    expect(new Set(commands)).toEqual(new Set(["HeadBucketCommand"]));
    expect(text).not.toMatch(/s3-request-presigner|getSignedUrl/);
    expect(declaredExports(text)).toEqual(["testStorageConnection"]);
  });
});
