/**
 * Page builder — input and output schemas of its operations (kon SDK)
 * ============================================================================
 *
 * The OpenAPI and the MCP tools of `/api/page-builder` come from here.
 *
 * The INPUTS are deliberately loose semantically: they check the shape
 * (types) and let extra fields through (`passthrough`), because this kon's contract
 * (`page-builder`, see `@kitsuden/shared/contracts.ts`) already published
 * its 400s with their own message ("Invalid status", "`slug` only allows…") and
 * clients such as Inti or the panel send the whole object they read. Those
 * checks remain in the handler; the schema adds the 422 for what used to
 * blow up (a `visibleFrom` that is not a date reached Postgres).
 *
 * The OUTPUTS describe what is served (and `inti-contract.test.ts` pins it).
 */
import { dateSchema } from "@kitsuden/engine";
import { z } from "zod";

const text = () => z.string();
const textOrNull = () => z.string().nullable().optional();
/** Served date: Postgres → `Date` → JSON = ISO 8601 text. */
const servedDate = () => z.string().datetime({ offset: true });

export const ParamId = z.object({
  id: z.string().describe("Page/block/template id (uuid; anything else is a 404)"),
});
export const PageParam = z.object({ pageId: z.string().describe("Page id (uuid)") });
export const ParamSlug = z.object({ slug: z.string() });

/** A block as it comes in (when creating a page or a block). */
export const BlockInput = z
  .object({
    type: text().optional().describe("Block type (GET /block-types); unknown types are a 400"),
    name: textOrNull(),
    sortOrder: z.number().int().optional(),
    columnSpan: z.number().int().min(1).max(12).optional(),
    content: z.record(z.string(), z.unknown()).optional(),
    cssClass: textOrNull(),
    backgroundColor: textOrNull(),
    textColor: textOrNull(),
    padding: textOrNull(),
    isVisible: z.boolean().optional(),
    visibleFrom: dateSchema().nullable().optional(),
    visibleUntil: dateSchema().nullable().optional(),
  })
  .passthrough();

/** The changes to a block (PATCH): everything optional. */
export const BlockChanges = BlockInput.partial().passthrough();

/** A page as it comes in (create or edit). */
export const PageInput = z
  .object({
    title: text().optional(),
    slug: text().optional(),
    description: textOrNull(),
    status: text().optional().describe("draft | published | archived"),
    layout: text().optional(),
    metaTitle: textOrNull(),
    metaDescription: textOrNull(),
    ogImageId: textOrNull(),
    cssClass: textOrNull(),
    customCss: textOrNull(),
    isHomepage: z.unknown().optional().describe("boolean (staff only)"),
    requireAuth: z.unknown().optional().describe("boolean"),
    publishedAt: dateSchema().nullable().optional(),
    blocks: z.array(z.unknown()).optional().describe("Blocks to create with the page"),
  })
  .passthrough();

export const PageFromBlock = z
  .object({
    blockType: text().optional(),
    content: z.record(z.string(), z.unknown()).optional(),
    title: text().optional(),
    slug: text().optional(),
    status: text().optional(),
  })
  .passthrough();

export const Reordenar = z
  .object({
    blockOrders: z
      .array(z.object({ id: z.string(), sortOrder: z.number().int() }).passthrough())
      .optional(),
  })
  .passthrough();

export const Clone = z
  .object({ slug: z.unknown().optional(), title: z.unknown().optional() })
  .passthrough()
  .optional();

export const TemplateEntry = z
  .object({
    name: text().optional(),
    description: textOrNull(),
    category: textOrNull(),
    type: text().optional(),
    content: z.record(z.string(), z.unknown()).optional(),
    cssClass: textOrNull(),
    backgroundColor: textOrNull(),
    textColor: textOrNull(),
    padding: textOrNull(),
  })
  .passthrough();

export const PageListQuery = z
  .object({
    status: text()
      .optional()
      .describe("draft | published | archived (only staff see non-published)"),
    limit: text().optional().describe("1-100, default 50"),
    offset: text().optional(),
    layout: text().optional(),
    search: text().optional().describe("Title contains (max 200 chars)"),
  })
  .passthrough();

export const PageQuery = z
  .object({ include_blocks: z.enum(["true", "false"]).optional() })
  .passthrough();

export const TemplatesQuery = z
  .object({ category: text().optional(), type: text().optional() })
  .passthrough();

// ── Outputs ──────────────────────────────────────────────────────────────────

export const Block = z
  .object({
    id: z.guid(),
    pageId: z.guid(),
    type: z.string(),
    name: z.string().nullable(),
    sortOrder: z.number().int(),
    columnSpan: z.number().int(),
    content: z.record(z.string(), z.unknown()),
    cssClass: z.string().nullable(),
    backgroundColor: z.string().nullable(),
    textColor: z.string().nullable(),
    padding: z.string().nullable(),
    isVisible: z.boolean(),
    visibleFrom: servedDate().nullable(),
    visibleUntil: servedDate().nullable(),
    createdAt: servedDate(),
    updatedAt: servedDate(),
  })
  .passthrough();

export const Page = z
  .object({
    id: z.guid(),
    title: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    status: z.enum(["draft", "published", "archived"]),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    ogImageId: z.string().nullable(),
    layout: z.string(),
    cssClass: z.string().nullable(),
    customCss: z.string().nullable(),
    publishedAt: servedDate().nullable(),
    isHomepage: z.boolean(),
    requireAuth: z.boolean(),
    createdAt: servedDate(),
    updatedAt: servedDate(),
  })
  .passthrough();

export const PageWithBlocks = Page.extend({ blocks: z.array(Block) }).passthrough();

export const PagesList = z.object({
  docs: z.array(
    Page.pick({
      id: true,
      title: true,
      slug: true,
      description: true,
      status: true,
      layout: true,
      isHomepage: true,
      publishedAt: true,
      updatedAt: true,
    })
  ),
  totalDocs: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

export const RenderedPage = z.object({
  page: z
    .object({
      id: z.guid(),
      title: z.string(),
      slug: z.string(),
      description: z.string().nullable(),
      metaTitle: z.string().nullable(),
      metaDescription: z.string().nullable(),
      layout: z.string(),
      cssClass: z.string().nullable(),
      customCss: z.string().nullable(),
      publishedAt: servedDate().nullable(),
    })
    .passthrough(),
  blocks: z.array(
    z
      .object({
        id: z.guid(),
        type: z.string(),
        content: z.record(z.string(), z.unknown()),
        columnSpan: z.number().int(),
        mediaUrls: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Transform URLs for media blocks"),
      })
      .passthrough()
  ),
});

export const Template = z
  .object({
    id: z.guid(),
    name: z.string(),
    description: z.string().nullable(),
    category: z.string(),
    type: z.string(),
    content: z.record(z.string(), z.unknown()),
    usageCount: z.number().int(),
  })
  .passthrough();

export const TemplatesList = z.object({ docs: z.array(Template) });

export const BlockTypes = z.object({
  blockTypes: z.array(
    z
      .object({
        type: z.string(),
        name: z.string(),
        category: z.string(),
        icon: z.string(),
        description: z.string(),
        schema: z
          .record(z.string(), z.unknown())
          .describe("Field descriptors of the block content"),
      })
      .passthrough()
  ),
});

export const PageFromBlockOutput = z.object({
  data: z.object({ id: z.guid(), slug: z.string(), title: z.string(), status: z.string() }),
  created: z.boolean().describe("false when an existing page with that slug was updated (200)"),
});

export const Success = z.object({ success: z.literal(true) }).passthrough();
