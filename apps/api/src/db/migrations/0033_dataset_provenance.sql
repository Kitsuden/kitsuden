-- 0032 — Provenance of datasets
-- ============================================================================
-- Idempotent.
--
-- Where a dataset came from, when, under what terms and from which patch.
--
-- All NULLABLE: a hand-written dataset has no source, and forcing
-- people to invent one would be worse than leaving it empty. It matters when the dataset comes
-- from OUTSIDE: an imported catalog without this is a mystery after three months.
ALTER TABLE data_sets ADD COLUMN IF NOT EXISTS source_name VARCHAR(300);
ALTER TABLE data_sets ADD COLUMN IF NOT EXISTS source_url TEXT;
-- Terms as long text, not a license identifier: "CC-BY-SA" does not say
-- whether a specific dump can be republished.
ALTER TABLE data_sets ADD COLUMN IF NOT EXISTS source_license TEXT;
ALTER TABLE data_sets ADD COLUMN IF NOT EXISTS source_version VARCHAR(60);
-- Different from updated_at, which is when it was touched HERE.
ALTER TABLE data_sets ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ;
ALTER TABLE data_sets ADD COLUMN IF NOT EXISTS source_caveats JSONB DEFAULT '[]';

-- The index that makes it possible to filter without scanning the whole table.
CREATE INDEX IF NOT EXISTS data_entries_set_status_idx
  ON data_entries (data_set_id, status);

-- The text search index goes SEPARATELY, in 0034, and not on a whim:
-- pg_trgm is an extension and pg-mem —the in-memory Postgres used by the tests— does not
-- understand it. Mixing them in one file makes the whole migration fail when
-- loading the test schema, and with it ALL the tables that came after.
--
-- Separated, the tests load the structural part and skip what their engine does not
-- support; on real Postgres both are applied.
