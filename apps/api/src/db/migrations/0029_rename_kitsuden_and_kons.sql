-- 0029 — Rebrand: usagibase → kitsuden  y  pyon → kon
-- ============================================================================
-- Historical chain of brands: vek → varco → usagibase → kitsuden.
-- Historical chain of the concept: facet → pyon → kon.
--
-- NEW databases already create kitsuden_* / installed_kons (earlier migrations
-- were updated); EXISTING ones need these renames.
--
-- Idempotent: each step checks the state before acting, so the three
-- paths converge — new database, pyon-era database, and facet-era database
-- (which goes through 0028 and arrives here with the intermediate names).
--
-- WARNING when editing in bulk: like 0027 and 0028, this file mentions BOTH
-- brands on purpose. A global replace collapses it into `X RENAME TO X` and the
-- migration ends up doing nothing without failing. Exclude from any rebrand.

-- ── 1. Tables usagibase_* → kitsuden_* ───────────────────────────────────────
DO $$
DECLARE
  legacy TEXT;
  target TEXT;
BEGIN
  FOREACH legacy IN ARRAY ARRAY[
    'usagibase_functions', 'usagibase_secrets', 'usagibase_search_entries'
  ] LOOP
    target := replace(legacy, 'usagibase_', 'kitsuden_');
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

-- ── 2. Indexes that carry the old name ───────────────────────────────────────
-- Renaming a table does NOT rename its indexes or constraints: you have to
-- do it separately or they remain as fossils of the old name.
DO $$
DECLARE
  viejo TEXT;
  nuevo TEXT;
BEGIN
  FOR viejo IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('i', 'I')
      AND c.relname LIKE 'usagibase\_%'
  LOOP
    nuevo := replace(viejo, 'usagibase_', 'kitsuden_');
    IF NOT EXISTS (
      SELECT FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = nuevo
    ) THEN
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', viejo, nuevo);
      RAISE NOTICE 'renamed index % -> %', viejo, nuevo;
    END IF;
  END LOOP;
END $$;

-- ── 3. Table installed_pyons → installed_kons ────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'installed_pyons'
  ) AND NOT EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'installed_kons'
  ) THEN
    ALTER TABLE public.installed_pyons RENAME TO installed_kons;
    RAISE NOTICE 'renamed table installed_pyons -> installed_kons';
  END IF;
END $$;

-- ── 4. Column pyon_id → kon_id ───────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'installed_kons'
      AND column_name = 'pyon_id'
  ) AND NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'installed_kons'
      AND column_name = 'kon_id'
  ) THEN
    ALTER TABLE public.installed_kons RENAME COLUMN pyon_id TO kon_id;
    RAISE NOTICE 'renamed column installed_kons.pyon_id -> kon_id';
  END IF;
END $$;

-- ── 5. Enum type pyon_source → kon_source ────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'pyon_source'
  ) AND NOT EXISTS (
    SELECT FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'kon_source'
  ) THEN
    ALTER TYPE public.pyon_source RENAME TO kon_source;
    RAISE NOTICE 'renamed type pyon_source -> kon_source';
  END IF;
END $$;

-- ── 6. Indexes installed_pyon_*_idx → installed_kon_*_idx ────────────────────
DO $$
DECLARE
  viejo TEXT;
  nuevo TEXT;
BEGIN
  FOREACH viejo IN ARRAY ARRAY[
    'installed_pyon_id_idx', 'installed_pyon_source_idx', 'installed_pyon_enabled_idx'
  ] LOOP
    nuevo := replace(viejo, 'installed_pyon_', 'installed_kon_');
    IF EXISTS (
      SELECT FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = viejo AND c.relkind IN ('i', 'I')
    ) AND NOT EXISTS (
      SELECT FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = nuevo
    ) THEN
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', viejo, nuevo);
      RAISE NOTICE 'renamed index % -> %', viejo, nuevo;
    END IF;
  END LOOP;
END $$;

-- ── 7. Trigger installed_pyons_updated_at → installed_kons_updated_at ────────
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'installed_kons'
      AND tg.tgname = 'installed_pyons_updated_at'
  ) THEN
    ALTER TRIGGER installed_pyons_updated_at ON public.installed_kons
      RENAME TO installed_kons_updated_at;
    RAISE NOTICE 'renamed trigger installed_pyons_updated_at -> installed_kons_updated_at';
  END IF;
END $$;

-- ── 8. Enum value of brain_note_category: 'pyon' → 'kon' ─────────────────────
-- ALTER TYPE ... RENAME VALUE is transactional and does not rewrite rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'brain_note_category' AND e.enumlabel = 'pyon'
  ) AND NOT EXISTS (
    SELECT FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'brain_note_category' AND e.enumlabel = 'kon'
  ) THEN
    ALTER TYPE public.brain_note_category RENAME VALUE 'pyon' TO 'kon';
    RAISE NOTICE 'renamed enum value brain_note_category.pyon -> kon';
  END IF;
END $$;

-- ── 9. Data: modules and manifests that store the "pyon" type ────────────────
UPDATE public.modules
SET settings = jsonb_set(settings, '{type}', '"kon"')
WHERE settings ->> 'type' = 'pyon';

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'installed_kons'
  ) THEN
    UPDATE public.installed_kons
    SET manifest = jsonb_set(manifest, '{type}', '"kon"')
    WHERE manifest ->> 'type' = 'pyon';
  END IF;
END $$;
