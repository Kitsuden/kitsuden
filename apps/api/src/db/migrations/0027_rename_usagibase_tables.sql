-- 0027 — Rebrand: rename legacy vek_* / varco_* tables to usagibase_*
-- ============================================================================
-- Historical chain of brands: vek → varco → usagibase.
-- NEW databases create usagibase_* directly (earlier migrations
-- were updated); EXISTING ones need this rename.
-- Idempotent: if the old table does not exist, or the new one already exists, it does nothing.

DO $$
DECLARE
  legacy TEXT;
  target TEXT;
BEGIN
  FOREACH legacy IN ARRAY ARRAY[
    'vek_functions', 'varco_functions',
    'vek_secrets',   'varco_secrets'
  ] LOOP
    target := 'usagibase_' || split_part(legacy, '_', 2);

    IF EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = legacy
    ) AND NOT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = target
    ) THEN
      EXECUTE format('ALTER TABLE public.%I RENAME TO %I', legacy, target);
      RAISE NOTICE 'renamed table % -> %', legacy, target;
    END IF;
  END LOOP;
END $$;

-- Associated indexes (a table rename does not rename its indexes).
DO $$
DECLARE
  legacy TEXT;
  target TEXT;
BEGIN
  FOREACH legacy IN ARRAY ARRAY[
    'vek_secrets_key_unique', 'varco_secrets_key_unique'
  ] LOOP
    target := 'usagibase_secrets_key_unique';

    IF EXISTS (
      SELECT FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = legacy AND c.relkind = 'i'
    ) AND NOT EXISTS (
      SELECT FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = target AND c.relkind = 'i'
    ) THEN
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', legacy, target);
      RAISE NOTICE 'renamed index % -> %', legacy, target;
    END IF;
  END LOOP;
END $$;
