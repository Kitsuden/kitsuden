-- Trace partitions are reached only through their parent
-- ============================================================================
--
-- 0057 made `kitsuden_request_traces` INSERT-only for the application role:
-- it writes traces, and reads them only through the SECURITY DEFINER functions
-- (kitsuden_traces_list / _summary / _page). But the table is partitioned by
-- day, and each partition is a table of its own with its own privileges:
--
--   · `kitsuden_traces_rotate` (owned by the admin role) creates them, so the
--     startup script's `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT,
--     UPDATE, DELETE ON TABLES TO <app role>` applied to every new one;
--   · and its `GRANT … ON ALL TABLES` at each start re-granted the existing ones.
--
-- Result, found by the 2026-11-19 web app test: the app role could not
-- `SELECT * FROM kitsuden_request_traces`, but could read, edit and delete
-- `kitsuden_request_traces_20261119` directly.
--
-- A partition needs no privileges for the app to write through the parent:
-- Postgres checks INSERT on the table named in the statement, not on the
-- partition the row lands in. So every partition keeps only its owner.

CREATE OR REPLACE FUNCTION kitsuden_traces_private_partition(p_name text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_grantee text;
BEGIN
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', p_name);
  FOR v_grantee IN
    SELECT DISTINCT g.grantee
      FROM information_schema.role_table_grants g
      JOIN pg_class c ON c.relname = g.table_name
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = g.table_schema
     WHERE g.table_schema = 'public'
       AND g.table_name = p_name
       AND g.grantee <> pg_get_userbyid(c.relowner)
       AND g.grantee <> 'PUBLIC'
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM %I', p_name, v_grantee);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION kitsuden_traces_private_partition(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION kitsuden_traces_rotate(p_days integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_day date;
  v_name text;
  v_dropped integer := 0;
  v_part record;
BEGIN
  FOR i IN 0..2 LOOP
    v_day := (now() AT TIME ZONE 'UTC')::date + i;
    v_name := 'kitsuden_request_traces_' || to_char(v_day, 'YYYYMMDD');
    IF to_regclass('public.' || v_name) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.kitsuden_request_traces FOR VALUES FROM (%L) TO (%L)',
        v_name,
        (v_day::timestamp AT TIME ZONE 'UTC'),
        ((v_day + 1)::timestamp AT TIME ZONE 'UTC')
      );
      PERFORM kitsuden_traces_private_partition(v_name);
    END IF;
  END LOOP;

  FOR v_part IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'kitsuden_request_traces'
       AND c.relname ~ '^kitsuden_request_traces_[0-9]{8}$'
       AND to_date(substring(c.relname from '[0-9]{8}$'), 'YYYYMMDD')
           < (now() AT TIME ZONE 'UTC')::date - GREATEST(p_days, 1)
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I', v_part.relname);
    v_dropped := v_dropped + 1;
  END LOOP;
  RETURN v_dropped;
END;
$$;

-- The partitions that already exist.
DO $$
DECLARE
  v_part record;
BEGIN
  FOR v_part IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'kitsuden_request_traces'
  LOOP
    PERFORM kitsuden_traces_private_partition(v_part.relname);
  END LOOP;
END $$;
