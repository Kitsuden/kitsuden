/**
 * Media — input and output schemas of its operations (kon SDK)
 * ============================================================================
 *
 * The OpenAPI and the MCP tools of `/api/media` come from here. As
 * in the page builder, inputs check the shape and let extra fields
 * through: the 400s with their own message ("folderId is not valid", "x and y must be
 * numbers"…) stay in the handlers, which is what the tests already pin down.
 */
import { z } from "zod";

const servedDate = () => z.string().datetime({ offset: true });

export const ParamId = z.object({
  id: z.string().describe("Media id (uuid; anything else is a 404)"),
});
export const ParamPreset = z.object({
  id: z.string().describe("Media id (uuid)"),
  preset: z.string().describe("thumbnail | small | medium | large | hero"),
});

export const ListQuery = z
  .object({
    limit: z.string().optional().describe("1-200, default 50"),
    offset: z.string().optional(),
    folderId: z.string().optional(),
    search: z.string().optional().describe("File name contains (case-insensitive)"),
    type: z.string().optional().describe("image | video | application (MIME prefix)"),
  })
  .passthrough();

export const UploadQuery = z
  .object({
    folderId: z.string().optional().describe("Folder uuid"),
    thumbnails: z.enum(["true", "false"]).optional(),
  })
  .passthrough();

export const TransformQuery = z
  .object({
    w: z.string().optional().describe("Width 1-4096"),
    width: z.string().optional(),
    h: z.string().optional().describe("Height 1-4096"),
    height: z.string().optional(),
    fit: z.string().optional().describe("cover | contain | fill | inside | outside"),
    pos: z
      .string()
      .optional()
      .describe("center | top | right | bottom | left | entropy | attention"),
    position: z.string().optional(),
    f: z.string().optional().describe("jpeg | png | webp | avif | gif | auto"),
    format: z.string().optional(),
    q: z.string().optional().describe("Quality 1-100"),
    quality: z.string().optional(),
    fp: z.string().optional().describe("Focal point 'x,y', each 0-1"),
  })
  .passthrough();

export const Upload = z
  .object({ files: z.unknown().describe("One or more files in the multipart field `files`") })
  .passthrough()
  .optional();

export const InputDir = z
  .object({
    name: z.string().optional().describe("Required, max 200 chars"),
    parentId: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  })
  .passthrough()
  .optional();

export const MediaChanges = z
  .object({
    altText: z.string().nullable().optional(),
    caption: z.string().nullable().optional(),
    filename: z.string().optional(),
    folderId: z.string().nullable().optional(),
  })
  .passthrough()
  .optional();

export const InputConfig = z
  .object({
    config: z.record(z.string(), z.unknown()).describe("MediaKonConfig: storage, features, limits"),
  })
  .passthrough()
  .optional();

export const StoreTest = z
  .object({
    storage: z
      .record(z.string(), z.unknown())
      .describe("StorageConfig to test (provider, bucket…)"),
  })
  .passthrough()
  .optional();

export const FocalPointInput = z
  .object({
    x: z.number().optional().describe("0-1"),
    y: z.number().optional().describe("0-1"),
  })
  .passthrough()
  .optional();

// ── Outputs ──────────────────────────────────────────────────────────────────

export const Media = z
  .object({
    id: z.guid(),
    filename: z.string(),
    originalName: z.string(),
    mimeType: z.string(),
    size: z.number().int(),
    key: z.string(),
    publicUrl: z.string().nullable(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    folderId: z.guid().nullable(),
    altText: z.string().nullable(),
    caption: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    createdAt: servedDate().nullable(),
    updatedAt: servedDate().nullable(),
  })
  .passthrough();

export const MediaWithUrl = Media.extend({
  url: z.string().nullable(),
  thumbnails: z.record(z.string(), z.string()).optional(),
}).passthrough();

export const MediaList = z.object({
  docs: z.array(MediaWithUrl),
  totalDocs: z.number().int().describe("Items in this page (not the library total)"),
});

export const UploadResult = z.object({
  success: z.boolean().describe("true when every file was stored (201); false = partial (207)"),
  files: z.array(
    z
      .object({
        id: z.guid().optional(),
        filename: z.string(),
        mimeType: z.string().optional(),
        size: z.number().int().optional(),
        url: z.string().optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        success: z.boolean(),
        error: z.string().optional(),
      })
      .passthrough()
  ),
});

export const Dir = z
  .object({
    id: z.guid(),
    name: z.string(),
    slug: z.string(),
    parentId: z.guid().nullable(),
    path: z.string(),
    description: z.string().nullable(),
  })
  .passthrough();

export const DirsList = z.object({ docs: z.array(Dir) });

export const Configuration = z.object({ config: z.record(z.string(), z.unknown()) });
export const SavedConfiguration = z.object({
  success: z.literal(true),
  config: z.record(z.string(), z.unknown()),
});
export const TestResult = z
  .object({ success: z.boolean(), message: z.string().optional() })
  .passthrough();

export const FocalPoint = z.object({ x: z.number(), y: z.number() });
export const FocalPointSaved = z.object({ success: z.literal(true), focalPoint: FocalPoint });
export const FocalPointRead = z.object({ focalPoint: FocalPoint });
export const CacheDeleted = z.object({ success: z.literal(true), cleared: z.number().int() });
export const Success = z.object({ success: z.literal(true) });
