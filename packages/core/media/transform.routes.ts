import path from "path";

import {
  defineOperation,
  isUuid,
  messageOf,
  operationsRouter,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";

import { KON_ID } from "./media.routes";
import { media } from "./media.schema";
import {
  CacheDeleted,
  ParamId,
  ParamPreset,
  FocalPointInput,
  FocalPointSaved,
  FocalPointRead,
  TransformQuery,
} from "./media.wire-schemas";
import { ImageTransformer, transformPresets, type TransformOptions } from "./src/transformer.js";

/**
 * Create transform routes for on-the-fly image transformation
 *
 * Routes:
 * - GET /transform/:id?w=800&h=600&fit=cover&f=webp
 * - GET /preset/:id/:preset (thumbnail, small, medium, large, hero)
 * - POST /focal-point/:id (set focal point for smart cropping)
 */
export function transformationOperations(ctx: KonContext): AnyOperation[] {
  /**
   * What does not need the request's transaction, outside of it.
   *
   * A transformation is LONG work (read the original from the store, sharp,
   * save the result) and only needs the medium's row from the database. Read
   * outside the transaction (`background`, as the system: the route is
   * public and serves any medium by id, so nothing is opened that RLS
   * would have closed), the request does not hold a connection busy while sharp works
   * (kon SDK rule 3).
   */
  const outside = <T>(fn: () => Promise<T>): Promise<T> =>
    ctx.db.background ? ctx.db.background(fn) : fn();

  /**
   * GET /transform/:id - Transform image on-the-fly
   *
   * Query params:
   * - w, width: Target width
   * - h, height: Target height
   * - fit: resize fit (cover, contain, fill, inside, outside)
   * - pos, position: crop position (center, top, right, bottom, left)
   * - f, format: output format (jpeg, png, webp, avif)
   * - q, quality: quality 1-100
   * - fp: focal point (format: "x,y" where x,y are 0-1)
   */
  /**
   * Generates (or reuses) a transformation and SERVES its bytes.
   *
   * Before, it redirected to `getSignedDownloadUrl(transformKey)` without checking that
   * it existed: with local storage that function only composes the public
   * URL, so EVERY preset URL ended in a 404 from `/media/...` for a
   * file nobody had generated. And if it did get to generate, it read the original
   * with `fetch` on a relative path (fails on the server) and saved with
   * `ctx.storage.upload`, which does not exist.
   *
   * Now it reads with `ctx.storage.get` (same on disk and on S3): if the
   * transformation is saved it is served as is; if not, it is generated from the
   * original, saved for next time and served.
   */
  async function serveTransformation(c: Context, id: string, query: Record<string, string>) {
    if (!isUuid(id)) return c.json({ error: "Media not found" }, 404);

    try {
      const [doc] = await outside(
        async () => await ctx.db.instance.select().from(media).where(eq(media.id, id)).limit(1)
      );
      if (!doc) return c.json({ error: "Media not found" }, 404);
      if (!doc.mimeType?.startsWith("image/")) {
        return c.json({ error: "Not an image file" }, 400);
      }

      // What arrives in the URL can be requested by ANYONE (the route is public): out
      // of range is 400, not work for sharp.
      let options: TransformOptions;
      try {
        options = readTransformOptions(query, doc.metadata as Record<string, unknown> | undefined);
      } catch (err) {
        return c.json({ error: messageOf(err) }, 400);
      }

      // The output format is fixed BEFORE looking in the cache: the key and the
      // Content-Type of what is stored depend on it. Without a requested format, the
      // original's is kept (what sharp would do), or webp if sharp does not know how to
      // write it (svg, ico…).
      const format = outputFormat(options.format, doc.mimeType);
      options.format = format;

      const cacheKey = ImageTransformer.generateKey(options);
      const transformKey = `transforms/${doc.id}/${path.parse(doc.filename).name}_${cacheKey}.${format}`;
      const type = `image/${format}`;

      const saved = await ctx.storage.get(transformKey);
      if (saved) return serveImage(c, saved, type);

      const original = await ctx.storage.get(doc.key);
      if (!original) {
        ctx.logger.warn("Transform: original is missing", { id: doc.id });
        return c.json({ error: "Original file not found" }, 404);
      }

      const transformer = new ImageTransformer(original);
      const result = await transformer.transform(options);
      transformer.destroy();

      // Saving is an optimization: if it fails, it is served anyway.
      try {
        await ctx.storage.put(transformKey, result.buffer, type);
      } catch (err) {
        ctx.logger.warn("Transform: could not save to cache", { error: messageOf(err) });
      }

      return serveImage(c, result.buffer, type);
    } catch (err: unknown) {
      ctx.logger.error("Transform failed:", { error: messageOf(err) });
      return c.json({ error: "Transform failed" }, 500);
    }
  }

  /**
   * GET /transform/:id - Transform image on-the-fly
   *
   * Query params:
   * - w, width: Target width
   * - h, height: Target height
   * - fit: resize fit (cover, contain, fill, inside, outside)
   * - pos, position: crop position (center, top, right, bottom, left)
   * - f, format: output format (jpeg, png, webp, avif)
   * - q, quality: quality 1-100
   * - fp: focal point (format: "x,y" where x,y are 0-1)
   */
  const ops: AnyOperation[] = [];

  ops.push(
    defineOperation({
      id: "transform-image",
      method: "GET",
      route: "/transform/:id",
      summary: "Transform an image on the fly",
      description:
        "Serves the image resized/cropped/converted as asked (w, h, fit, pos, f, q, fp). The result is cached in storage and served with a one-year immutable Cache-Control.",
      access: "public",
      input: { params: ParamId, query: TransformQuery },
      output: { type: "image/*", description: "The transformed image bytes" },
      errors: ["KITSUDEN_E_BAD_REQUEST", "KITSUDEN_E_NOT_FOUND"],
      mcp: { exclude: "returns image bytes, not JSON; agents use the URL instead" },
      handle: async (_input, { c }) =>
        serveTransformation(c, c.req.param("id") as string, c.req.query()),
    })
  );

  /**
   * GET /preset/:id/:preset - Apply named preset
   *
   * Presets: thumbnail, small, medium, large, hero
   *
   * It is served right here, without redirecting to `/api/media/transform/...`: the
   * redirect assumed the mount point and cost one more request.
   */
  ops.push(
    defineOperation({
      id: "image-with-preset",
      method: "GET",
      route: "/preset/:id/:preset",
      summary: "Image with a named preset",
      description:
        "Serves the image with a named size: thumbnail (150x150), small (400x300), medium (800x600), large (1200x800) or hero (1920x1080).",
      access: "public",
      input: { params: ParamPreset },
      output: { type: "image/*", description: "The transformed image bytes" },
      errors: ["KITSUDEN_E_BAD_REQUEST", "KITSUDEN_E_NOT_FOUND"],
      mcp: { exclude: "returns image bytes, not JSON; agents use the URL instead" },
      handle: async (input, { c }) => {
        const id = input.params.id;
        const presetName = input.params.preset;
        if (!isUuid(id)) return c.json({ error: "Media not found" }, 404);

        const preset = Object.hasOwn(transformPresets, presetName)
          ? transformPresets[presetName]
          : undefined;
        if (!preset) {
          return c.json(
            {
              error: "Unknown preset",
              available: Object.keys(transformPresets),
            },
            400
          );
        }

        const query: Record<string, string> = {};
        if (preset.width) query.w = String(preset.width);
        if (preset.height) query.h = String(preset.height);
        if (preset.fit) query.fit = preset.fit;
        if (preset.position) query.pos = preset.position;
        if (preset.format) query.f = preset.format;
        if (preset.quality) query.q = String(preset.quality);

        return serveTransformation(c, id, query);
      },
    })
  );

  /**
   * POST /focal-point/:id - Set focal point for smart cropping
   *
   * Body: { x: number, y: number } (0-1)
   */
  ops.push(
    defineOperation({
      id: "set-focal-point",
      method: "POST",
      route: "/focal-point/:id",
      summary: "Set the focal point of an image",
      description:
        "Stores the point (x, y between 0 and 1) that smart crops keep in frame. Setting the same point twice leaves the same state.",
      access: "session",
      permission: { policy: { resource: "media", action: "update" } },
      idempotent: true,
      input: { params: ParamId, body: FocalPointInput },
      output: { schema: FocalPointSaved },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        const id = c.req.param("id") as string;
        if (!isUuid(id)) return c.json({ error: "Media not found" }, 404);
        const body = input.body ?? {};

        if (typeof body.x !== "number" || typeof body.y !== "number") {
          return c.json({ error: "x and y must be numbers" }, 400);
        }

        if (body.x < 0 || body.x > 1 || body.y < 0 || body.y > 1) {
          return c.json({ error: "x and y must be between 0 and 1" }, 400);
        }

        try {
          const [doc] = await ctx.db.instance.select().from(media).where(eq(media.id, id)).limit(1);

          if (!doc) {
            return c.json({ error: "Media not found" }, 404);
          }

          // Update metadata with focal point
          const metadata = {
            ...doc.metadata,
            focalPoint: { x: body.x, y: body.y },
          };

          await ctx.db.instance
            .update(media)
            .set({ metadata, updatedAt: new Date() })
            .where(eq(media.id, id));

          return c.json({
            success: true,
            focalPoint: metadata.focalPoint,
          });
        } catch (err: unknown) {
          ctx.logger.error("Failed to set focal point:", { error: messageOf(err) });
          return c.json({ error: messageOf(err) }, 500);
        }
      },
    })
  );

  /**
   * GET /focal-point/:id - Get focal point
   */
  ops.push(
    defineOperation({
      id: "read-focal-point",
      method: "GET",
      route: "/focal-point/:id",
      summary: "Get the focal point of an image",
      description: "The stored focal point, or the centre (0.5, 0.5) when none was set.",
      access: "public",
      input: { params: ParamId },
      output: { schema: FocalPointRead },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (_input, { c }) => {
        const id = c.req.param("id") as string;
        if (!isUuid(id)) return c.json({ error: "Media not found" }, 404);

        const [doc] = await ctx.db.instance.select().from(media).where(eq(media.id, id)).limit(1);

        if (!doc) {
          return c.json({ error: "Media not found" }, 404);
        }

        return c.json({
          focalPoint: doc.metadata?.focalPoint || { x: 0.5, y: 0.5 },
        });
      },
    })
  );

  /**
   * DELETE /cache/:id - Clear all transforms for an image
   */
  ops.push(
    defineOperation({
      id: "clear-image-cache",
      method: "DELETE",
      route: "/cache/:id",
      summary: "Clear the cached transforms of an image",
      description:
        "Deletes every stored transformation of the image; they are regenerated on the next request. The original is not touched.",
      access: "session",
      permission: { policy: { resource: "media", action: "update" } },
      // It deletes cache that can be regenerated, not data: it is not "sensitive".
      sensitive: false,
      input: { params: ParamId },
      output: { schema: CacheDeleted },
      handle: async (_input, { c }) => {
        const id = c.req.param("id") as string;
        // The id goes inside a store path (`transforms/<id>/`): without this,
        // `..` or `/` in the parameter listed and deleted outside that folder.
        if (!isUuid(id)) return c.json({ error: "Media not found" }, 404);

        try {
          // `ctx.storage.list` returns keys. Before it called a `list` that did not
          // exist in any store (with an `as any` hiding it): always 500.
          const transforms = await ctx.storage.list(`transforms/${id}/`);

          for (const key of transforms) {
            await ctx.storage.delete(key);
          }

          return c.json({
            success: true,
            cleared: transforms.length,
          });
        } catch (err: unknown) {
          ctx.logger.error("Failed to clear cache:", { error: messageOf(err) });
          return c.json({ error: messageOf(err) }, 500);
        }
      },
    })
  );

  return ops;
}

/** The transformations REST router, generated from their operations. */
export function createTransformRouter(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, transformationOperations(ctx), ctx);
}

/**
 * Limits of a transformation requested by URL.
 *
 * `GET /transform/:id` is PUBLIC (the webs use it for logos and covers), and
 * every distinct combination of parameters is new sharp work and a new
 * cache entry. Before, `w`/`h`/`q` passed as-is (`parseInt`
 * with no cap, NaN included) and `fit`/`format`/`position` were passed to sharp without
 * checking: an unknown format or a width of 10^9 turned into a 500 or
 * useless work.
 */
export const TRANSFORM_LIMITS = { side: 4096 } as const;

/** Side steps (px): the usual `srcset` widths up to 4096. */
const SIDE_TIERS = [
  16, 32, 48, 64, 96, 100, 128, 150, 160, 192, 200, 256, 300, 320, 384, 400, 480, 512, 600, 640,
  720, 768, 800, 960, 1024, 1080, 1200, 1280, 1440, 1536, 1600, 1920, 2048, 2560, 3072, 3840, 4096,
];
const QUALITY_TIERS = [40, 50, 60, 70, 75, 80, 85, 90, 95, 100];

/** The first step ≥ n (the last if n exceeds it). */
function stagger(n: number | undefined, tiers: readonly number[]): number | undefined {
  if (n === undefined) return undefined;
  return tiers.find((e) => e >= n) ?? tiers[tiers.length - 1];
}

type OutputFormat = "jpeg" | "png" | "webp" | "avif" | "gif";
const WRITABLE_FORMATS: Record<string, OutputFormat> = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
};

/**
 * The format a transformation comes out in: the requested one, or the original's if
 * none was requested (or `auto` was), or webp if the original is not something
 * sharp can write.
 */
export function outputFormat(
  request: TransformOptions["format"],
  originalMime: string | null | undefined
): OutputFormat {
  if (request && request !== "auto") return request;
  return WRITABLE_FORMATS[(originalMime ?? "").toLowerCase()] ?? "webp";
}

/** The bytes of an image, cacheable for a year (the URL changes if the image changes). */
function serveImage(c: Context, bytes: Buffer, type: string) {
  c.header("Content-Type", type);
  c.header("Cache-Control", "public, max-age=31536000, immutable");
  c.header("X-Content-Type-Options", "nosniff");
  return c.body(new Uint8Array(bytes));
}

const SETTINGS = new Set(["cover", "contain", "fill", "inside", "outside"]);
const POSITIONS = new Set(["center", "top", "right", "bottom", "left", "entropy", "attention"]);
const FORMATS = new Set(["jpeg", "png", "webp", "avif", "gif", "auto"]);

function integer(
  value: string | undefined,
  name: string,
  min: number,
  max: number
): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^[0-9]{1,6}$/.test(value)) throw new Error(`${name} must be an integer`);
  const n = Number(value);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} y ${max}`);
  return n;
}

/**
 * Reads and VALIDATES the transformation options from the URL. Throws with a
 * readable message if anything is outside what is allowed (the route turns it into a 400).
 */
export function readTransformOptions(
  query: Record<string, string>,
  metadata?: Record<string, unknown>
): TransformOptions {
  const options: TransformOptions = {};
  const side = TRANSFORM_LIMITS.side;

  // Sizes and qualities on a fixed GRID (earlier audit): every
  // distinct combination is rendered with sharp and saved forever, and
  // `?w=4093`, `?w=4094`… burned CPU and disk endlessly from an
  // anonymous request. It is rounded up to the next step.
  options.width = stagger(integer(query.w ?? query.width, "w", 1, side), SIDE_TIERS);
  options.height = stagger(integer(query.h ?? query.height, "h", 1, side), SIDE_TIERS);
  if (options.width === undefined) delete options.width;
  if (options.height === undefined) delete options.height;

  if (query.fit) {
    if (!SETTINGS.has(query.fit)) throw new Error("fit is not valid");
    options.fit = query.fit as TransformOptions["fit"];
  }
  const pos = query.pos ?? query.position;
  if (pos) {
    if (!POSITIONS.has(pos)) throw new Error("position is not valid");
    options.position = pos as TransformOptions["position"];
  }
  const format = query.f ?? query.format;
  if (format) {
    if (!FORMATS.has(format)) throw new Error("format is not valid (jpeg, png, webp, avif, gif)");
    options.format = format as TransformOptions["format"];
  }
  const quality = stagger(integer(query.q ?? query.quality, "q", 1, 100), QUALITY_TIERS);
  if (quality !== undefined) options.quality = quality;

  const inside = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
  if (query.fp) {
    const [x, y] = query.fp.split(",").map(Number);
    if (!inside(x) || !inside(y)) throw new Error("fp must be x,y between 0 and 1");
    // In steps of 0.05 (21×21 positions), for the same reason as the sizes
    options.focalPoint = { x: Math.round(x * 20) / 20, y: Math.round(y * 20) / 20 };
  } else if (metadata?.focalPoint) {
    const fp = metadata.focalPoint as { x?: unknown; y?: unknown };
    if (inside(fp.x) && inside(fp.y)) options.focalPoint = { x: fp.x as number, y: fp.y as number };
  }

  return options;
}
