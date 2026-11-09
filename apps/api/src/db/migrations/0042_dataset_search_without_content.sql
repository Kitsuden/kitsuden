-- ═══════════════════════════════════════════════════════════════════════════════
-- 0042 — The data_entries search trigger stops reading `content`
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 0022_critical_features.sql created `data_entries_search_update()` with
--
--     COALESCE(NEW.content, '')
--
-- and `data_entries` NEVER had a `content` column. Result: on EVERY database
-- migrated from scratch, any INSERT or UPDATE of a dataset row fails
-- with `42703: record "new" has no field "content"`. No dataset could
-- receive rows, not from the panel, not from the API, not from an import.
--
-- It was thought to be an artifact of one particular database (see the script
-- `scripts/repair-dataset-search.ts`); a new database migrated for a
-- test reproduced it, so it comes from the chain and is fixed in the chain.
-- 0022 is not edited: it is already applied on existing databases and the runner rejects
-- an applied migration whose content changes.
--
-- Same search vector, with the columns that exist: title and data.
-- Idempotent: on a database already repaired by hand it leaves the same function.

CREATE OR REPLACE FUNCTION data_entries_search_update()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.title, '') || ' ' ||
    COALESCE(NEW.data::text, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
