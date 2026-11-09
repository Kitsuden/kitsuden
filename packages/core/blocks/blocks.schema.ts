/**
 * Kitsuden CMS — Page Builder (Blocks) Schema
 *
 * Drizzle ORM schema for dynamic page layouts with block-based content.
 * Supports drag & drop positioning and multiple block types.
 */

import { relations } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";

// ═══════════════════════════════════════════════
// Enums
// ═══════════════════════════════════════════════

export const pageStatusEnum = pgEnum("block_page_status", ["draft", "published", "archived"]);

/**
 * The block types a builder page can SAVE.
 * ============================================================================
 *
 * This WAS a Postgres enum (`block_content_type`) and no longer is. The reason
 * is measurable: from 0002 to 0008, SEVEN consecutive migrations did nothing but
 * add values to it. Every new block meant touching the PRODUCTION database,
 * and `deck` could not be saved in a page waiting for exactly
 * that.
 *
 * And for that price it only half protected: the blocks of an ARTICLE go in
 * `blog_posts.blocks`, an unconstrained jsonb, so the enum only guarded
 * the builder pages.
 *
 * Now the column is text and THIS list is the only authority. Whoever publishes
 * validates against it (`blocks.routes.ts`) and a guard checks that it contains
 * everything the editor offers (`tests/unit/blocks-that-do-not-fit.test.ts`), which
 * is the failure the enum was meant to catch. Adding a block is adding one
 * line here, and it travels with the code that renders it: no migration.
 *
 * Those of the first batch (`text`, `cards`, `cta`, `spacer`…) are from another
 * era and the renderer does not know how to render them. They stay because they do no harm and
 * old pages may have them saved; what cannot happen
 * is that one the editor offers is MISSING.
 */
export const BLOCK_TYPES = [
  // ── The originals, some already without a renderer ──
  "hero",
  "text",
  "image",
  "video",
  "grid",
  "cards",
  "quote",
  "cta",
  "embed",
  "divider",
  "spacer",
  "custom",
  // ── Those the editor really offers today ──
  "richtext",
  "image-gallery",
  "game-map",
  "tier-list",
  "character-builder",
  "comments",
  "streamer-widget",
  "callout",
  // Invitation to a Facebook group inside an entry (card with a link)
  "facebook-group",
  "dynamic-carousel",
  "smart-filter",
  "comparison-slider",
  "smart-grid",
  // ── 0003: Aniimo proof of concept ──
  "habitat-map",
  "stat-compare",
  // ── 0004: index with detail pages (Aniidex) ──
  "dex",
  // ── 0005: affinity calculator (inheritance from Umamusume) ──
  "affinity",
  // ── 0006: the other two Umamusume tools ──
  "event-search",
  "race-planner",
  // ── 0007: card games ──
  "card-browser",
  "deck-builder",
  "deck-showcase",
  // ── 0008: a deck embedded in an article (0007 left it out) ──
  "deck",
] as const;

/** A block type among those this installation knows how to save. */
export type BlockType = (typeof BLOCK_TYPES)[number];

// ═══════════════════════════════════════════════
// Pages Table (Layout containers)
// ═══════════════════════════════════════════════

export const pages = pgTable(
  "block_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: varchar("title", { length: 500 }).notNull(),
    slug: varchar("slug", { length: 500 }).notNull().unique(),
    description: text("description"),
    status: pageStatusEnum("status").default("draft").notNull(),

    // SEO & Meta
    metaTitle: varchar("meta_title", { length: 500 }),
    metaDescription: text("meta_description"),
    ogImageId: uuid("og_image_id"), // References media.id

    // Layout settings
    layout: varchar("layout", { length: 50 }).default("default").notNull(), // default, full-width, sidebar-left, sidebar-right
    cssClass: varchar("css_class", { length: 200 }),
    customCss: text("custom_css"),

    // Publishing
    publishedAt: timestamp("published_at", { withTimezone: true }),
    authorId: uuid("author_id"), // References users.id

    // Settings
    isHomepage: boolean("is_homepage").default(false).notNull(),
    requireAuth: boolean("require_auth").default(false).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("block_pages_slug_idx").on(t.slug),
    index("block_pages_status_idx").on(t.status),
    index("block_pages_homepage_idx").on(t.isHomepage),
    index("block_pages_published_idx").on(t.publishedAt),
  ]
);

// ═══════════════════════════════════════════════
// Blocks Table (Content blocks within pages)
// ═══════════════════════════════════════════════

export const blocks = pgTable(
  "block_contents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),

    // Block configuration
    type: varchar("type", { length: 64 }).$type<BlockType>().notNull(),
    name: varchar("name", { length: 200 }), // Human-readable label

    // Positioning (for drag & drop)
    sortOrder: integer("sort_order").default(0).notNull(),
    columnSpan: integer("column_span").default(12).notNull(), // 1-12 grid system

    // Content (varies by block type)
    content: jsonb("content").$type<BlockContent>().notNull(),

    // Styling
    cssClass: varchar("css_class", { length: 200 }),
    backgroundColor: varchar("background_color", { length: 50 }),
    textColor: varchar("text_color", { length: 50 }),
    padding: varchar("padding", { length: 50 }), // sm, md, lg, xl

    // Visibility
    isVisible: boolean("is_visible").default(true).notNull(),
    visibleFrom: timestamp("visible_from", { withTimezone: true }),
    visibleUntil: timestamp("visible_until", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("block_contents_page_idx").on(t.pageId),
    index("block_contents_type_idx").on(t.type),
    index("block_contents_order_idx").on(t.pageId, t.sortOrder),
  ]
);

// ═══════════════════════════════════════════════
// Block Content Types
// ═══════════════════════════════════════════════

export type BlockContent =
  | HeroBlockContent
  | TextBlockContent
  | ImageBlockContent
  | VideoBlockContent
  | GridBlockContent
  | CardsBlockContent
  | QuoteBlockContent
  | CtaBlockContent
  | EmbedBlockContent
  | DividerBlockContent
  | SpacerBlockContent
  | CustomBlockContent;

// Hero Block
export interface HeroBlockContent {
  headline: string;
  subheadline?: string;
  description?: string;
  mediaId?: string; // Background image/video
  mediaType?: "image" | "video";
  alignment?: "left" | "center" | "right";
  minHeight?: "sm" | "md" | "lg" | "xl";
  focalPoint?: { x: number; y: number }; // For smart cropping (0-1)
  primaryButton?: {
    label: string;
    url: string;
    variant?: "primary" | "secondary" | "outline";
  };
  secondaryButton?: {
    label: string;
    url: string;
  };
}

// Text Block
export interface TextBlockContent {
  text: string; // HTML or Markdown
  format?: "html" | "markdown" | "plain";
  alignment?: "left" | "center" | "right" | "justify";
  textSize?: "sm" | "md" | "lg" | "xl";
}

// Image Block
export interface ImageBlockContent {
  mediaId: string;
  altText?: string;
  caption?: string;
  alignment?: "left" | "center" | "right" | "full";
  linkUrl?: string;
  openInNewTab?: boolean;
}

// Video Block
export interface VideoBlockContent {
  mediaId?: string; // Self-hosted
  embedUrl?: string; // YouTube, Vimeo, etc.
  provider?: "youtube" | "vimeo" | "self";
  autoplay?: boolean;
  loop?: boolean;
  muted?: boolean;
  controls?: boolean;
}

// Grid Block (container for nested blocks)
export interface GridBlockContent {
  columns: number; // 1-4
  gap?: "sm" | "md" | "lg";
  items: GridItem[];
}

export interface GridItem {
  id: string;
  columnSpan: number; // 1-12
  content: BlockContent;
}

// Cards Block
export interface CardsBlockContent {
  cards: CardItem[];
  columns?: 1 | 2 | 3 | 4;
  variant?: "default" | "horizontal" | "compact";
}

export interface CardItem {
  id: string;
  title: string;
  description?: string;
  mediaId?: string;
  linkUrl?: string;
  tags?: string[];
}

// Quote Block
export interface QuoteBlockContent {
  quote: string;
  author?: string;
  authorTitle?: string;
  authorImageId?: string;
  style?: "default" | "large" | "minimal";
}

// CTA Block
export interface CtaBlockContent {
  title: string;
  description?: string;
  buttonLabel: string;
  buttonUrl: string;
  buttonVariant?: "primary" | "secondary" | "outline";
  alignment?: "left" | "center" | "right";
}

// Embed Block
export interface EmbedBlockContent {
  code: string; // HTML embed code
  caption?: string;
}

// Divider Block
export interface DividerBlockContent {
  style?: "solid" | "dashed" | "dotted";
  width?: "full" | "partial";
  color?: string;
}

// Spacer Block
export interface SpacerBlockContent {
  height: "sm" | "md" | "lg" | "xl" | "2xl";
}

// Custom Block (for extensibility)
export interface CustomBlockContent {
  component: string; // Component identifier
  props: Record<string, unknown>;
}

// ═══════════════════════════════════════════════
// Block Templates (Reusable block presets)
// ═══════════════════════════════════════════════

export const blockTemplates = pgTable(
  "block_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    category: varchar("category", { length: 100 }).notNull(), // layout, content, media, marketing

    type: varchar("type", { length: 64 }).$type<BlockType>().notNull(),
    content: jsonb("content").$type<BlockContent>().notNull(),

    // Default styling
    cssClass: varchar("css_class", { length: 200 }),
    backgroundColor: varchar("background_color", { length: 50 }),
    textColor: varchar("text_color", { length: 50 }),
    padding: varchar("padding", { length: 50 }),

    isActive: boolean("is_active").default(true).notNull(),
    usageCount: integer("usage_count").default(0).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("block_templates_category_idx").on(t.category),
    index("block_templates_type_idx").on(t.type),
    index("block_templates_active_idx").on(t.isActive),
  ]
);

// ═══════════════════════════════════════════════
// Relations
// ═══════════════════════════════════════════════

export const pagesRelations = relations(pages, ({ many }) => ({
  blocks: many(blocks),
}));

export const blocksRelations = relations(blocks, ({ one }) => ({
  page: one(pages, {
    fields: [blocks.pageId],
    references: [pages.id],
  }),
}));

// ═══════════════════════════════════════════════
// Type Exports
// ═══════════════════════════════════════════════

export type Page = typeof pages.$inferSelect;
export type NewPage = typeof pages.$inferInsert;
export type Block = typeof blocks.$inferSelect;
export type NewBlock = typeof blocks.$inferInsert;
export type BlockTemplate = typeof blockTemplates.$inferSelect;
export type NewBlockTemplate = typeof blockTemplates.$inferInsert;
