import { describe, it, expect, mock, beforeAll, beforeEach, afterAll } from "bun:test";

let optimizeImage: typeof import("../lib/image").optimizeImage;
let getImageDimensions: typeof import("../lib/image").getImageDimensions;

let shouldThrow = false;
let mockMetadata = { width: 100, height: 200 };
let mockOptimizedBuffer = Buffer.from("optimized-webp");

mock.module("sharp", () => ({
  default: function sharp() {
    return {
      metadata: async () => {
        if (shouldThrow) throw new Error("sharp error");
        return mockMetadata;
      },
      webp: () => ({
        toBuffer: async () => {
          if (shouldThrow) throw new Error("sharp error");
          return mockOptimizedBuffer;
        },
      }),
    };
  },
}));

beforeAll(async () => {
  const mod = await import("../lib/image");
  optimizeImage = mod.optimizeImage;
  getImageDimensions = mod.getImageDimensions;
});

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  shouldThrow = false;
  mockMetadata = { width: 100, height: 200 };
  mockOptimizedBuffer = Buffer.from("optimized-webp");
});

describe("image utilities", () => {
  it("optimizeImage returns null for non-optimizable mime type", async () => {
    const result = await optimizeImage(Buffer.from("pdf"), "application/pdf");
    expect(result).toBeNull();
  });

  it("optimizeImage returns OptimizedImage for image/jpeg", async () => {
    const originalBuffer = Buffer.from("jpeg-image");
    const result = await optimizeImage(originalBuffer, "image/jpeg");
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe("image/webp");
    expect(result!.width).toBe(100);
    expect(result!.height).toBe(200);
    expect(result!.originalSize).toBe(originalBuffer.length);
    expect(result!.optimizedSize).toBe(mockOptimizedBuffer.length);
    expect(result!.buffer).toEqual(mockOptimizedBuffer);
  });

  it("optimizeImage returns null when sharp throws", async () => {
    shouldThrow = true;
    const result = await optimizeImage(Buffer.from("jpeg-image"), "image/jpeg");
    expect(result).toBeNull();
  });

  it("getImageDimensions returns width/height from sharp metadata", async () => {
    const result = await getImageDimensions(Buffer.from("image"));
    expect(result).not.toBeNull();
    expect(result!.width).toBe(100);
    expect(result!.height).toBe(200);
  });

  it("getImageDimensions returns null when sharp throws", async () => {
    shouldThrow = true;
    const result = await getImageDimensions(Buffer.from("image"));
    expect(result).toBeNull();
  });
});
