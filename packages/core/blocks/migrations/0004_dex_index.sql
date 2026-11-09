-- 0004 — New block the editor offers: dex (index with detail pages)
-- ============================================================================
-- Idempotent.
--
-- It comes from the Aniimo proof of concept (the "Aniidex"):
--
--   dex   the rows of a dataset as a filterable index, and a detail page per row
--         at `/<game>/<segment>/<row>` composed with other datasets
--         (facets with icon, skills, trait, evolution line).
--
-- Same rule as 0002 and 0003: what the editor offers has to fit in the
-- enum. `ADD VALUE` cannot go inside a transaction; the runner executes
-- statement by statement.

ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'dex';
