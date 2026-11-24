/**
 * Public S3 addresses for a host that is the bucket (S3_PUBLIC_URL_STYLE)
 * ============================================================================
 *
 * A Cloudflare R2 bucket on a custom domain serves `https://media.example.com/<key>`. The API always built
 * `S3_PUBLIC_URL/<bucket>/<key>`, which only the S3 endpoint itself serves, so on R2 every public file was a
 * 404. `S3_PUBLIC_URL_STYLE=domain` drops the bucket segment; `path` (the default) keeps it.
 */
import { afterEach, describe, expect, it } from "vitest";

const store = await import("../../apps/api/src/lib/store");

const KEYS = ["S3_PUBLIC_URL", "S3_PUBLIC_URL_STYLE", "S3_BUCKET"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("s3PublicUrl", () => {
  it("path style (the default) puts the bucket in the address", () => {
    process.env.S3_PUBLIC_URL = "http://localhost:9000";
    process.env.S3_BUCKET = "kitsuden-media";
    delete process.env.S3_PUBLIC_URL_STYLE;
    expect(store.s3PublicUrl("uploads/1_a.png")).toBe(
      "http://localhost:9000/kitsuden-media/uploads/1_a.png"
    );
    process.env.S3_PUBLIC_URL_STYLE = "path";
    expect(store.s3PublicUrl("uploads/1_a.png")).toBe(
      "http://localhost:9000/kitsuden-media/uploads/1_a.png"
    );
  });

  it("domain style serves the key at the root of the host", () => {
    process.env.S3_PUBLIC_URL = "https://media.example.com/";
    process.env.S3_BUCKET = "kitsuden-media";
    process.env.S3_PUBLIC_URL_STYLE = "domain";
    expect(store.s3PublicUrl("uploads/1_a.png")).toBe("https://media.example.com/uploads/1_a.png");
    expect(store.s3PublicUrl("/cartas/x.webp")).toBe("https://media.example.com/cartas/x.webp");
  });

  it("a CDN path prefix is kept and trailing slashes do not double", () => {
    process.env.S3_PUBLIC_URL = "https://cdn.example.com/media//";
    process.env.S3_PUBLIC_URL_STYLE = "domain";
    expect(store.s3PublicUrl("uploads/a.png")).toBe("https://cdn.example.com/media/uploads/a.png");
  });
});
