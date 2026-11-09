-- 0003 — Two new blocks the editor offers: habitat-map and stat-compare
-- ============================================================================
-- Idempotent.
--
-- They come from the Aniimo proof of concept:
--
--   habitat-map   which dataset rows are in each region. It is the "map" that
--                 can be published without coordinates: it invents no markers.
--   stat-compare  up to three dataset rows, stat by stat.
--
-- Same rule as 0002: what the editor offers has to fit in the enum, or
-- saving a page with that block fails with an invalid enum value.
-- `ADD VALUE` cannot go inside a transaction; the runner executes statement by
-- statement.

ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'habitat-map';
ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'stat-compare';
