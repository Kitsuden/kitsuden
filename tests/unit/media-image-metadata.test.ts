/**
 * Measuring an image on upload
 * ============================================================================
 *
 * `width` and `height` stayed `null` forever: the upload endpoint
 * carried a «For now, we'll skip dimensions» and nobody came back to it.
 *
 * It is not cosmetic: `validateWhatsAppImage` (kon-blog) checks that the Open Graph
 * image reaches 400×400 —below that, WhatsApp does not show the link
 * preview— and its warnings subtract SEO points. It received `width` and
 * `height` from the `media` row, where they were NULL, so those two
 * checks could say nothing.
 *
 * It is tested with GENERATED images, not sample files: that way the test does not
 * drag binaries into the repo and EXIF orientation —the interesting case—
 * can be built on purpose.
 */

import sharp from "sharp";
import { describe, expect, test } from "vitest";

import { measureImage } from "../../packages/core/media/image-metadata";

/** A plain PNG of the requested dimensions. */
const png = (width: number, height: number) =>
  sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();

describe("measure an image", () => {
  test("returns the real size", async () => {
    expect(await measureImage(await png(800, 450), "image/png")).toEqual({
      width: 800,
      height: 450,
    });
  });

  test("works with JPEG and WebP, not just PNG", async () => {
    const jpeg = await sharp(await png(200, 100))
      .jpeg()
      .toBuffer();
    const webp = await sharp(await png(120, 240))
      .webp()
      .toBuffer();

    expect(await measureImage(jpeg, "image/jpeg")).toEqual({ width: 200, height: 100 });
    expect(await measureImage(webp, "image/webp")).toEqual({ width: 120, height: 240 });
  });

  test("EXIF ORIENTATION rules: a portrait photo is declared portrait", async () => {
    // This is the case that really matters. A portrait phone photo is
    // STORED landscape with a tag that says «rotate it 90°». Without looking at it, it is
    // declared landscape and the space reserved for it on the page comes out with the
    // wrong shape — worse than reserving none.
    const landscapeWithLabel = await sharp(await png(400, 300))
      .withMetadata({ orientation: 6 }) // 6 = rotate 90° clockwise
      .jpeg()
      .toBuffer();

    expect(await measureImage(landscapeWithLabel, "image/jpeg")).toEqual({
      width: 300,
      height: 400,
    });
  });

  test("an orientation that does NOT rotate does not touch the dimensions", async () => {
    // 1..4 are flips and 180° rotations: the width is still the width.
    const flipped = await sharp(await png(400, 300))
      .withMetadata({ orientation: 2 })
      .jpeg()
      .toBuffer();

    expect(await measureImage(flipped, "image/jpeg")).toEqual({ width: 400, height: 300 });
  });
});

describe("what is NOT measured", () => {
  test("an SVG has no pixel size that means anything", async () => {
    // It is vector: its size depends on the `viewBox` and on how the CSS scales it.
    // A number here would be a lie that serves nobody.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    expect(await measureImage(svg, "image/svg+xml")).toBeNull();
  });

  test("a PDF or a video is discarded without opening it", async () => {
    expect(await measureImage(Buffer.from("%PDF-1.4"), "application/pdf")).toBeNull();
    expect(await measureImage(Buffer.from("ftypmp42"), "video/mp4")).toBeNull();
  });
});

describe("when it fails, it does NOT take the upload down with it", () => {
  test("a corrupt file returns null instead of throwing", async () => {
    // It is called AFTER saving: the file is already safe. If the measurement
    // blew up here it would turn a good upload into a 500.
    expect(await measureImage(Buffer.from("this is not an image"), "image/png")).toBeNull();
  });

  test("an empty buffer does not throw either", async () => {
    expect(await measureImage(Buffer.alloc(0), "image/jpeg")).toBeNull();
  });

  test("a corrupt image does NOT disable the measurement of the next ones", async () => {
    // The module remembers whether `sharp` is unavailable so as not to retry the
    // import for each file; that must NOT be confused with a bad file.
    await measureImage(Buffer.from("garbage"), "image/png");
    expect(await measureImage(await png(64, 64), "image/png")).toEqual({ width: 64, height: 64 });
  });
});
