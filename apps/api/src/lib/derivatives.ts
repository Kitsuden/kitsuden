/**
 * On-the-fly derivatives for `/media`: `?w=320` serves the image at THAT width
 * ============================================================================
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 *
 * Public sites previously fetched every image at full size even when the slot
 * was 32 px wide. `/api/media/transform/:id` works by library UUID, while many
 * static/mirrored assets are referenced by storage key under `/media/<key>`.
 *
 * Any public image under `/media` can pass `?w=<width>`: a downscaled copy is
 * written once under `.derivatives/<width>/<key>` and served from disk on
 * subsequent requests. The original is never modified; requesting a width at
 * or above the original width falls back to the original (upscaling only wastes
 * bytes). PNG and JPEG derivatives are encoded as WebP (saved with a `.webp`
 * extension so `Content-Type` matches the bytes); WebP and AVIF keep their
 * original format.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";

import { LOCAL_DIR } from "./store";

/** Reasonable bounds: neither tiny nor a memory hazard for sharp. */
const WIDTH_MIN = 16;
const WIDTH_MAX = 2400;

const RESIZABLE_EXTENSIONS = /\.(webp|png|jpe?g|avif)$/i;
const CONVERT_TO_WEBP = /\.(png|jpe?g)$/i;

/** Parses `?w=<width>` strictly as an integer within [16, 2400], or null. */
export function requestedWidth(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const width = Number(value);
  if (!Number.isInteger(width) || width < WIDTH_MIN || width > WIDTH_MAX) return null;
  return width;
}

/** Whether the storage key points to a resizable raster image (never a derivative itself). */
export function isResizable(key: string): boolean {
  const clean = key.replace(/^\/+/, "");
  if (clean.startsWith(".derivatives/") || clean.startsWith(".derivados/")) return false;
  return RESIZABLE_EXTENSIONS.test(clean);
}

/**
 * Resolves the on-disk path for a derivative inside `<baseDir>/.derivatives/<width>/`,
 * rejecting any key that attempts to escape that directory.
 */
export function derivativePathOf(key: string, width: number, baseDir = LOCAL_DIR): string {
  const outKey = CONVERT_TO_WEBP.test(key) ? key.replace(CONVERT_TO_WEBP, ".webp") : key;
  const root = resolve(baseDir, ".derivatives", String(width));
  const target = resolve(join(root, normalize(outKey)));
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Derivative key outside the allowed directory: ${key}`);
  }
  return target;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Sharp = (input: string | Buffer) => any;

let _sharp: Sharp | null | undefined;

/** `sharp` is optional at runtime: if unavailable, the route falls back to the original. */
async function loadSharp(): Promise<Sharp | null> {
  if (_sharp !== undefined) return _sharp;
  try {
    const mod = (await import("sharp")) as unknown as { default: Sharp };
    _sharp = mod.default ?? (mod as unknown as Sharp);
  } catch {
    _sharp = null;
  }
  return _sharp;
}

/**
 * Ensures a cached derivative of `originalPath` at `width` exists and returns
 * its disk path, or `null` when sharp is missing or the original is already at
 * most `width` pixels wide (no upscaling).
 */
export async function ensureDerivative(
  key: string,
  originalPath: string,
  width: number,
  baseDir = LOCAL_DIR
): Promise<string | null> {
  let target: string;
  try {
    target = derivativePathOf(key, width, baseDir);
  } catch {
    return null;
  }

  try {
    const existing = await stat(target);
    if (existing.isFile() && existing.size > 0) return target;
  } catch {
    // Cache miss — generate below.
  }

  const sharp = await loadSharp();
  if (!sharp) return null;

  let tmpPath: string | null = null;
  try {
    const source = await readFile(originalPath);
    const { width: originalWidth = 0 } = await sharp(source).metadata();
    if (originalWidth > 0 && originalWidth <= width) return null;

    const pipeline = sharp(source).resize({ width, withoutEnlargement: true });
    const output = CONVERT_TO_WEBP.test(key) ? pipeline.webp({ quality: 82 }) : pipeline;
    const buffer = await output.toBuffer();

    await mkdir(dirname(target), { recursive: true });
    // Atomic write so concurrent readers never observe a half-written file.
    tmpPath = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmpPath, buffer);
    await rename(tmpPath, target);
    tmpPath = null;
    return target;
  } catch {
    if (tmpPath) await unlink(tmpPath).catch(() => {});
    return null;
  }
}
