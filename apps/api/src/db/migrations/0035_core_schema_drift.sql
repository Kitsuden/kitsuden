-- 0035 — Schema drift in packages/core
-- ============================================================================
-- Idempotent.
--
-- Three `packages/core` tables declared columns —and one whole table— that
-- no migration ever created. It is not a typing detail: a `.select()` from
-- Drizzle with no arguments enumerates ALL the declared columns, so a single
-- missing one takes down the ENTIRE query, not just the column.
--
-- It was found by RUNNING the queries against the migrated schema, not by reading the
-- .sql files: a first attempt comparing lists with regular expressions gave three
-- false positives (`active` and `published` are default values, not columns)
-- and left out the media_folders part.
--
-- The test that pins it down: tests/unit/core-schema-drift.test.ts

-- ═══════════════════════════════════════════════════════════════════════════
-- data_sets: updated_at is missing
-- ═══════════════════════════════════════════════════════════════════════════
-- packages/core/datasets/datasets.schema.ts has always declared it. Without it,
-- ANY read of datasets by that module fails against real Postgres.
ALTER TABLE data_sets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- ═══════════════════════════════════════════════════════════════════════════
-- data_entries: the audit columns are missing
-- ═══════════════════════════════════════════════════════════════════════════
-- The table already has `owner_id` (who owns the row, which is what RLS
-- uses). These two are something else: WHO created it and who last touched it.
-- No FK to auth_users on purpose: an entry must not disappear because the
-- account of whoever wrote it is deleted.
ALTER TABLE data_entries ADD COLUMN IF NOT EXISTS created_by_id TEXT;
ALTER TABLE data_entries ADD COLUMN IF NOT EXISTS updated_by_id TEXT;

-- ═══════════════════════════════════════════════════════════════════════════
-- media_folders: the TABLE did not exist
-- ═══════════════════════════════════════════════════════════════════════════
-- packages/core/media declares it and apps/api/src/db/schema-kons.generated.ts
-- re-exports it, so the application mounts it. It was never created.
--
-- `media.folder_id` (which does exist, 0031 added it) pointed at nothing.
CREATE TABLE IF NOT EXISTS media_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(200) NOT NULL,

  -- Hierarchy. Self-reference without ON DELETE CASCADE: deleting a parent folder
  -- must not take the children with it and, with them, the reference of their files.
  parent_id UUID REFERENCES media_folders(id) ON DELETE SET NULL,

  -- Full path to search without walking the hierarchy: "/images/products".
  path TEXT NOT NULL,
  description TEXT,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_folders_parent_idx ON media_folders (parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS media_folders_path_idx ON media_folders (path);
