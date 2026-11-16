-- A timestamp that may not be one (docs/reports.md).
--
-- Dataset fields live in `data_entries.data` (jsonb), where anything can be stored:
-- `2026-02-31` has the shape of a date and is not one. A report that groups by month
-- reads every row of the dataset, and a single such value made `::timestamptz` fail
-- the whole statement. This function gives NULL instead, and the row counts as having
-- no date.
--
-- Only reached for values that already look like a date (the caller checks the shape
-- first), so the exception block costs nothing on the usual path.

CREATE OR REPLACE FUNCTION kitsuden_try_timestamptz(value text) RETURNS timestamptz
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN value::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
