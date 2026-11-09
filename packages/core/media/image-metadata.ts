/**
 * Dimensions of an image on upload
 * ============================================================================
 *
 * `width` and `height` stayed `null` FOREVER. In the upload endpoint
 * there was a `// For now, we'll skip dimensions` and nobody came back to it.
 *
 * What they are for, specifically:
 *
 *   · **Validating the Open Graph image.** `validateWhatsAppImage` (kon-blog)
 *     checks that it reaches the 400×400 minimum (below that, WhatsApp does not
 *     show the link preview) and recommends 1200×630. Its warnings
 *     subtract points from the post's SEO score. It received `width` and
 *     `height` from the `media` row, where they were NULL, so those two
 *     checks could not say anything.
 *   · **Reserving space for it in the published page.** An `<img>` without `width` or
 *     `height` makes the browser reflow the content when the image
 *     finishes loading (*layout shift*). This is true of the web in general;
 *     Kitsuden does NOT measure it in its score today.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `sharp` IS LOADED ON DEMAND
 *
 * `sharp` is a NATIVE module: it is compiled on install and genuinely fails on
 * some platforms and in some containers. Declaring it as a hard dependency of
 * `@kitsuden/core` would mean a Kitsuden installation could
 * break entirely for not being able to measure a PNG.
 *
 * So it is imported inside a `try` and, if missing, the dimensions
 * stay as they were: null. Uploading the image is what matters; measuring it is an
 * improvement. Degrading is the right answer.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

/** The failure is remembered so the import is not retried for every file. */
let sharpUnavailable = false;

/**
 * Measures an image. `null` if it cannot be done — never throws.
 *
 * This failing must not bring down an upload: the file is already saved
 * when it is called.
 */
export async function measureImage(
  buffer: Buffer,
  mimeType: string
): Promise<ImageDimensions | null> {
  // A PDF or a video has no "dimensions" useful for reserving space,
  // and `sharp` with an MP4 in front of it only wastes time before failing.
  if (!mimeType.startsWith("image/")) return null;

  // SVGs are not measured: they are vector. Their `width` depends on the `viewBox` and on
  // how CSS scales them, so a number here would be a lie useful to
  // nobody.
  if (mimeType === "image/svg+xml") return null;

  if (sharpUnavailable) return null;

  try {
    const { default: sharp } = await import("sharp");
    const metadata = await sharp(buffer).metadata();

    if (!metadata.width || !metadata.height) return null;

    /**
     * The EXIF ORIENTATION rules.
     *
     * A phone photo taken in portrait is stored as landscape with a tag
     * that says "rotate it 90°". `sharp` returns the size of the stored pixels, so
     * without this a portrait photo is declared landscape — and the space reserved
     * for it in the page comes out the wrong shape, which is worse than reserving
     * none.
     */
    const rotated = metadata.orientation !== undefined && metadata.orientation >= 5;

    return rotated
      ? { width: metadata.height, height: metadata.width }
      : { width: metadata.width, height: metadata.height };
  } catch (err) {
    // It is only marked unavailable if the failure is the module's own. A
    // corrupt image cannot disable measurement for the rest.
    if (err instanceof Error && /Cannot find module|ERR_MODULE_NOT_FOUND/i.test(err.message)) {
      sharpUnavailable = true;
    }
    return null;
  }
}
