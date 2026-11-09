-- Migration: Add blocks JSONB column to blog_posts and games
-- Purpose: Page Builder "Lego" architecture — stores ordered array of PageBlock objects
-- Structure: [{ id, type, data, order }]
-- Run: psql -d kitsuden -f 0002_add_blocks_column.sql

-- ═══ Blog Posts ═══
ALTER TABLE blog_posts
  ADD COLUMN IF NOT EXISTS blocks jsonb DEFAULT '[]'::jsonb;

COMMENT ON COLUMN blog_posts.blocks IS 'Page Builder blocks: array of {id, type, data, order}';

-- ═══ Games ═══
ALTER TABLE games
  ADD COLUMN IF NOT EXISTS blocks jsonb DEFAULT '[]'::jsonb;

COMMENT ON COLUMN games.blocks IS 'Page Builder blocks: array of {id, type, data, order}';

-- ═══ Index for GIN queries on block types (optional, for future filtering) ═══
CREATE INDEX IF NOT EXISTS blog_posts_blocks_gin ON blog_posts USING gin (blocks);
CREATE INDEX IF NOT EXISTS games_blocks_gin ON games USING gin (blocks);
