// kitsuden-test: needs-no-kons
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  derivativePathOf,
  ensureDerivative,
  isResizable,
  requestedWidth,
} from "../../apps/api/src/lib/derivatives";

describe("media on-the-fly derivatives (?w=)", () => {
  let workDir: string;
  let pngPath: string;
  let webpPath: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "kitsuden-derivatives-"));
    await mkdir(join(workDir, "uploads"), { recursive: true });

    const pngBuf = await sharp({
      create: {
        width: 400,
        height: 200,
        channels: 4,
        background: { r: 20, g: 120, b: 220, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    pngPath = join(workDir, "uploads", "banner.png");
    await writeFile(pngPath, pngBuf);

    const webpBuf = await sharp({
      create: {
        width: 300,
        height: 150,
        channels: 4,
        background: { r: 220, g: 80, b: 40, alpha: 1 },
      },
    })
      .webp()
      .toBuffer();
    webpPath = join(workDir, "uploads", "card.webp");
    await writeFile(webpPath, webpBuf);
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  describe("requestedWidth", () => {
    it("accepts integer widths within [16, 2400]", () => {
      expect(requestedWidth("16")).toBe(16);
      expect(requestedWidth("320")).toBe(320);
      expect(requestedWidth("2400")).toBe(2400);
    });

    it("rejects missing, non-integer, negative, and out-of-range values", () => {
      expect(requestedWidth(undefined)).toBeNull();
      expect(requestedWidth("")).toBeNull();
      expect(requestedWidth("15")).toBeNull();
      expect(requestedWidth("2401")).toBeNull();
      expect(requestedWidth("320.5")).toBeNull();
      expect(requestedWidth("-100")).toBeNull();
      expect(requestedWidth("320px")).toBeNull();
      expect(requestedWidth("1e2")).toBeNull();
    });
  });

  describe("isResizable", () => {
    it("accepts raster image formats and rejects non-images and derivative paths", () => {
      expect(isResizable("uploads/hero.png")).toBe(true);
      expect(isResizable("uploads/photo.JPG")).toBe(true);
      expect(isResizable("uploads/art.webp")).toBe(true);
      expect(isResizable("uploads/art.avif")).toBe(true);

      expect(isResizable("uploads/logo.svg")).toBe(false);
      expect(isResizable("uploads/doc.pdf")).toBe(false);
      expect(isResizable(".derivatives/320/uploads/hero.webp")).toBe(false);
    });
  });

  describe("derivativePathOf", () => {
    it("maps png/jpg keys to .webp and rejects directory traversal", () => {
      const p = derivativePathOf("uploads/banner.png", 160, workDir);
      expect(p).toBe(join(workDir, ".derivatives", "160", "uploads", "banner.webp"));

      const w = derivativePathOf("uploads/card.webp", 160, workDir);
      expect(w).toBe(join(workDir, ".derivatives", "160", "uploads", "card.webp"));

      expect(() => derivativePathOf("../../etc/passwd.png", 160, workDir)).toThrow(
        /outside the allowed directory/
      );
    });
  });

  describe("ensureDerivative", () => {
    it("downscales PNG into cached WebP with matching extension and dimensions", async () => {
      const out = await ensureDerivative("uploads/banner.png", pngPath, 160, workDir);
      expect(out).not.toBeNull();
      expect(out!.endsWith(".webp")).toBe(true);

      const meta = await sharp(await readFile(out!)).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.width).toBe(160);
      expect(meta.height).toBe(80);

      // Second call returns the existing cached derivative without regenerating it.
      const firstMtime = (await stat(out!)).mtimeMs;
      const cached = await ensureDerivative("uploads/banner.png", pngPath, 160, workDir);
      expect(cached).toBe(out);
      expect((await stat(cached!)).mtimeMs).toBe(firstMtime);
    });

    it("keeps WebP format when downscaling a WebP original", async () => {
      const out = await ensureDerivative("uploads/card.webp", webpPath, 120, workDir);
      expect(out).not.toBeNull();
      const meta = await sharp(await readFile(out!)).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.width).toBe(120);
    });

    it("returns null instead of upscaling when requested width >= original width", async () => {
      expect(await ensureDerivative("uploads/banner.png", pngPath, 400, workDir)).toBeNull();
      expect(await ensureDerivative("uploads/banner.png", pngPath, 800, workDir)).toBeNull();
    });

    it("returns null for traversal keys", async () => {
      expect(await ensureDerivative("../../escape.png", pngPath, 160, workDir)).toBeNull();
    });
  });
});
