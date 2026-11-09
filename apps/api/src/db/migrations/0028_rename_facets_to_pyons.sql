-- 0028 — Rebrand: facet → pyon
-- ============================================================================
-- The "facet" concept is now called "pyon". NEW databases already create
-- installed_pyons / pyon_source (earlier migrations were
-- updated); EXISTING ones need these renames.
--
-- Covers: table, column, enum type, index and enum values.
-- Idempotent: each step checks the state before acting.

-- ── 1. Table installed_facets → installed_pyons ──────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'installed_facets'
  ) AND NOT EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'installed_pyons'
  ) THEN
    ALTER TABLE public.installed_facets RENAME TO installed_pyons;
    RAISE NOTICE 'renamed table installed_facets -> installed_pyons';
  END IF;
END $$;

-- ── 2. Column facet_id → pyon_id ─────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'installed_pyons'
      AND column_name = 'facet_id'
  ) AND NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'installed_pyons'
      AND column_name = 'pyon_id'
  ) THEN
    ALTER TABLE public.installed_pyons RENAME COLUMN facet_id TO pyon_id;
    RAISE NOTICE 'renamed column installed_pyons.facet_id -> pyon_id';
  END IF;
END $$;

-- ── 3. Enum type facet_source → pyon_source ──────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'facet_source'
  ) AND NOT EXISTS (
    SELECT FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'pyon_source'
  ) THEN
    ALTER TYPE public.facet_source RENAME TO pyon_source;
    RAISE NOTICE 'renamed type facet_source -> pyon_source';
  END IF;
END $$;

-- ── 4. Index installed_facet_id_idx → installed_pyon_id_idx ──────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'installed_facet_id_idx' AND c.relkind = 'i'
  ) AND NOT EXISTS (
    SELECT FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'installed_pyon_id_idx' AND c.relkind = 'i'
  ) THEN
    ALTER INDEX public.installed_facet_id_idx RENAME TO installed_pyon_id_idx;
    RAISE NOTICE 'renamed index installed_facet_id_idx -> installed_pyon_id_idx';
  END IF;
END $$;

-- ── 5. Enum value of brain_note_category: 'facet' → 'pyon' ───────────────────
-- ALTER TYPE ... RENAME VALUE is transactional and does not require rewriting rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'brain_note_category' AND e.enumlabel = 'facet'
  ) AND NOT EXISTS (
    SELECT FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'brain_note_category' AND e.enumlabel = 'pyon'
  ) THEN
    ALTER TYPE public.brain_note_category RENAME VALUE 'facet' TO 'pyon';
    RAISE NOTICE 'renamed enum value brain_note_category.facet -> pyon';
  END IF;
END $$;

-- ── 6. Data: modules and manifests that store the "facet" type ───────────────
UPDATE public.modules
SET settings = jsonb_set(settings, '{type}', '"pyon"')
WHERE settings ->> 'type' = 'facet';

-- The table may not be called that: in a database created FROM SCRATCH after the
-- rebrand to kon, 0009 creates `installed_kons` directly and this table never
-- exists. Without the guard, this migration fails on every new installation
-- — and it went undetected for years because nobody ran the full chain.
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'installed_pyons'
  ) THEN
    UPDATE public.installed_pyons
    SET manifest = jsonb_set(manifest, '{type}', '"pyon"')
    WHERE manifest ->> 'type' = 'facet';
  END IF;
END $$;
