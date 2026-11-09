/**
 * How long each `/media` file is cached
 * ============================================================================
 *
 * They were served without `Cache-Control`: every visit downloaded every card again. Long
 * caching is only safe where a key NEVER changes content, and
 * getting it wrong the other way —marking `immutable` something that does get overwritten— would
 * make a change never show up in the browser of whoever already had it.
 */
import { describe, expect, it } from "vitest";

import { mediaCache } from "../../apps/api/src/lib/store";

describe("media caching", () => {
  it("mirrored cards are immutable: their key is the hash of their origin", () => {
    expect(mediaCache("cartas/ygoprodeck/0a1b2c3d4e5f60718293.webp")).toContain("immutable");
    expect(mediaCache("cartas/ygoprodeck/0a1b2c3d4e5f60718293.webp")).toContain("max-age=31536000");
  });

  it("images and videos of the other games, same: same mirror, same hash key", () => {
    expect(mediaCache("juegos/enka/0a1b2c3d4e5f60718293.webp")).toContain("immutable");
    expect(mediaCache("juegos/aniimo/0a1b2c3d4e5f60718293.mp4")).toContain("immutable");
  });

  it("panel uploads too: they carry the time up front and never overwrite each other", () => {
    expect(mediaCache("uploads/1789927732748_cover.webp")).toContain("immutable");
  });

  it("everything else is cached briefly and NEVER as immutable", () => {
    expect(mediaCache("_health/check.txt")).toBe("public, max-age=3600");
    expect(mediaCache("other-thing/file.png")).not.toContain("immutable");
  });

  it("a similar prefix does not slip through", () => {
    // «cartas-old/» is not «cartas/» (the persisted prefix of mirrored cards): it lacks the hash guarantee
    expect(mediaCache("cartas-old/x.webp")).not.toContain("immutable");
    expect(mediaCache("my-uploads/x.webp")).not.toContain("immutable");
    expect(mediaCache("juegos-old/x.webp")).not.toContain("immutable");
  });
});
