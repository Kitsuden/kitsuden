-- 0002 — The page store accepts the blocks the editor offers
-- ============================================================================
-- Idempotent.
--
-- ── THE BUG, AND IT IS A BIG ONE ───────────────────────────────────────────
--
-- There were THREE block vocabularies and they did not match:
--
--   1. The enum `block_content_type`, which is what `block_contents` can
--      store:   hero, text, image, video, grid, cards, quote, cta, embed,
--                 divider, spacer, custom
--   2. The panel registry, which is what the editor OFFERS:
--                 hero, richtext, image-gallery, game-map, tier-list,
--                 character-builder, comments, streamer-widget, embed,
--                 callout, divider, dynamic-carousel, smart-filter,
--                 comparison-slider, smart-grid
--   3. The renderer, which is what can be RENDERED: the same set as 2.
--
-- The intersection of 1 and 2 is THREE types: hero, embed and divider. That is:
-- of the fifteen blocks the builder offers, twelve **cannot be
-- saved** in a page. The INSERT fails with an invalid enum value.
--
-- ── WHY IT WAS NOT NOTICED ─────────────────────────────────────────────────
--
-- Because the blocks of an ARTICLE do not go through here: `blog_posts.blocks` is
-- unconstrained jsonb, so there all fifteen work. Only builder pages
-- have the enum, and none had been created (0 pages, 0
-- blocks when this was applied). The bug was waiting for the first page.
--
-- ── WHAT TAKES PRECEDENCE ──────────────────────────────────────────────────
--
-- The registry and the renderer MATCH each other; the enum is the one that was left
-- behind, with names from another era (`text`, `cards`, `cta`, `spacer`). The missing ones are added
-- and none is removed: deleting enum values in Postgres
-- is expensive and the legacy ones bother nobody.
--
-- `IF NOT EXISTS` requires Postgres 12+; 16 runs here. And `ADD VALUE` cannot
-- go inside a transaction: the runner executes statement by statement without
-- wrapping, which is exactly what is needed.

ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'richtext';
ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'image-gallery';
ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'game-map';
ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'tier-list';
ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'character-builder';
ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'comments';
ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'streamer-widget';
ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'callout';
ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'dynamic-carousel';
ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'smart-filter';
ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'comparison-slider';
ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'smart-grid';
