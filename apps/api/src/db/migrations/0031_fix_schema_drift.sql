-- 0031 — Repair of schema drift in kon endpoints
-- ============================================================================
-- It used to be called fix_schema_drift.sql and said "run this manually". That
-- a manual patch was needed WAS the problem: the migration chain did not
-- produce the schema the code expected, and every database ended up different.
--
-- Now it is part of the chain and the runner applies it. It is still idempotent
-- (IF NOT EXISTS / EXCEPTION WHEN duplicate_object), so reapplying it
-- does nothing on a database that is already right.

-- ═══════════════════════════════════════════════════════════════════════════
-- Missing enums
-- ═══════════════════════════════════════════════════════════════════════════
DO $$ BEGIN CREATE TYPE "games_content_status" AS ENUM('draft', 'published', 'archived'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "streamers_platform" AS ENUM('twitch', 'youtube', 'kick'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- games: align enum + add missing cover_focal_point
-- ═══════════════════════════════════════════════════════════════════════════
-- The DEFAULT has to be dropped BEFORE changing the type and restored afterwards:
-- Postgres cannot cast the default value on its own and aborts with
-- `default for column "status" cannot be cast automatically`.
ALTER TABLE games ALTER COLUMN status DROP DEFAULT;
ALTER TABLE games ALTER COLUMN status TYPE games_content_status USING status::text::games_content_status;
ALTER TABLE games ALTER COLUMN status SET DEFAULT 'draft'::games_content_status;
ALTER TABLE games ADD COLUMN IF NOT EXISTS cover_focal_point jsonb;

-- ═══════════════════════════════════════════════════════════════════════════
-- streamers: align enum
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE streamers ALTER COLUMN platform TYPE streamers_platform USING platform::text::streamers_platform;

-- ═══════════════════════════════════════════════════════════════════════════
-- blog_posts: add missing GEO/SEO columns
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS bluf_text text;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS faq_data jsonb;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS dataset_url text;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS meta_title varchar(70);
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS meta_description varchar(170);
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS og_image_id uuid;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS featured_image_focal_point jsonb;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS source jsonb;

-- ═══════════════════════════════════════════════════════════════════════════
-- media: rename old columns + add missing ones to match current schema
-- ═══════════════════════════════════════════════════════════════════════════
DROP INDEX IF EXISTS media_s3key_idx;

ALTER TABLE media RENAME COLUMN s3_key TO "key";
ALTER TABLE media RENAME COLUMN url TO public_url;
ALTER TABLE media RENAME COLUMN alt TO alt_text;
ALTER TABLE media RENAME COLUMN uploaded_by_id TO created_by_id;

ALTER TABLE media ADD COLUMN IF NOT EXISTS original_name varchar(500);
ALTER TABLE media ADD COLUMN IF NOT EXISTS bucket varchar(100);
ALTER TABLE media ADD COLUMN IF NOT EXISTS thumbnails jsonb DEFAULT '{}'::jsonb;
ALTER TABLE media ADD COLUMN IF NOT EXISTS folder_id uuid;
ALTER TABLE media ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;
ALTER TABLE media ADD COLUMN IF NOT EXISTS status varchar(50) DEFAULT 'active';
ALTER TABLE media ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS media_key_idx ON media USING btree ("key");
