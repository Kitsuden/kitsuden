/**
 * Kitsuden — AGGREGATED schema (AUTO-GENERATED)
 * ============================================================================
 * ⚠️ DO NOT EDIT BY HAND. Regenerate with:  kitsuden sync-schema
 *
 * Source: the `schema` block of each kon.json with strategy "drizzle".
 * Kons with strategy "sql" (own auto-migration) are excluded on
 * purpose to avoid collisions between global Postgres enums.
 *
 * It re-exports schema-core first; the explicit `export {}` of an
 * AUTHORITATIVE kon overrides core's `export *` (TS rule
 * explicit-wins-over-star), resolving collisions unambiguously.
 */

// Core first: authoritative kons (e.g. media) override its
// symbols via explicit export further down.
export * from "./schema-core";

// ── kon-media ──
export {
  media,
  mediaFolders,
} from "../../../../packages/core/media/media.schema";
export type {
  Media,
  MediaFolder,
  NewMedia,
  NewMediaFolder,
  ThumbnailInfo,
  ThumbnailsMap,
} from "../../../../packages/core/media/media.schema";

// ── kon-blocks ──
export {
  BLOCK_TYPES,
  blocks,
  blocksRelations,
  blockTemplates,
  pages,
  pagesRelations,
  pageStatusEnum,
} from "../../../../packages/core/blocks/blocks.schema";
export type {
  Block,
  BlockContent,
  BlockTemplate,
  BlockType,
  CardItem,
  CardsBlockContent,
  CtaBlockContent,
  CustomBlockContent,
  DividerBlockContent,
  EmbedBlockContent,
  GridBlockContent,
  GridItem,
  HeroBlockContent,
  ImageBlockContent,
  NewBlock,
  NewBlockTemplate,
  NewPage,
  Page,
  QuoteBlockContent,
  SpacerBlockContent,
  TextBlockContent,
  VideoBlockContent,
} from "../../../../packages/core/blocks/blocks.schema";
