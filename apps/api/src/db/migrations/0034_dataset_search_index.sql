-- 0034 — Text search index on dataset entries
-- ============================================================================
-- Idempotent. SEPARATE from 0033 on purpose.
--
-- pg_trgm is a Postgres extension, and pg-mem —the in-memory engine the tests
-- use— does not support it. If this lived in the same file as the
-- provenance columns, the whole migration would fail when mounting the
-- test schema and would take the columns with it, which ARE structural.
--
-- Without this index search works just the same: an ILIKE '%text%' without an index reads
-- the whole table, which at 500 entries is not noticeable and at 50,000 is. That is why it is a
-- separate file and not a requirement.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS data_entries_title_trgm_idx
  ON data_entries USING gin (title gin_trgm_ops);
