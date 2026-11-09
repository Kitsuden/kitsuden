/**
 * Kitsuden — Image Optimization Pipeline
 *
 * Converts uploaded images (JPEG, PNG, GIF, TIFF) to WebP for optimal
 * delivery. Extracts dimensions. Non-image files pass through unchanged.
 *
 * Uses `sharp` — the fastest Node.js image processing library.
 */

import sharp from "sharp";

// MIME types eligible for WebP optimization
const OPTIMIZABLE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/tiff",
  "image/bmp",
]);

export interface OptimizedImage {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  originalSize: number;
  optimizedSize: number;
}

/**
 * Optimize an image buffer → WebP.
 * Returns the optimized buffer + metadata.
 * Non-image or unsupported types return null (caller should use original).
 */
export async function optimizeImage(
  buffer: Buffer,
  mimeType: string
): Promise<OptimizedImage | null> {
  if (!OPTIMIZABLE_TYPES.has(mimeType.toLowerCase())) {
    return null;
  }

  try {
    const image = sharp(buffer);
    const metadata = await image.metadata();

    const optimized = await image.webp({ quality: 82, effort: 4 }).toBuffer();

    return {
      buffer: optimized,
      mimeType: "image/webp",
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      originalSize: buffer.length,
      optimizedSize: optimized.length,
    };
  } catch (err) {
    console.warn("[Image] Optimization failed, using original:", (err as Error).message);
    return null;
  }
}

/**
 * Extract image dimensions without conversion.
 * Works for any image type sharp supports (JPEG, PNG, WebP, AVIF, etc).
 */
export async function getImageDimensions(
  buffer: Buffer
): Promise<{ width: number; height: number } | null> {
  try {
    const metadata = await sharp(buffer).metadata();
    return {
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
    };
  } catch {
    return null;
  }
}
