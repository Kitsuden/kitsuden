-- 0075 — English names and comments that 0060 left behind
-- ============================================================================
--
-- 0060 renamed the core's tables, columns and functions. A few objects kept their Spanish
-- names (indexes and constraints named after renamed columns, the earlier agent helper
-- functions) and some table comments were written in Spanish by older migrations. Applied
-- migrations are never edited, so the rest is done here. Everything is idempotent: on a database
-- created from scratch most of these objects never had a Spanish name and nothing happens.

-- ── Indexes and constraints named after renamed columns ──────────────────────

ALTER INDEX IF EXISTS brain_connections_origen_idx RENAME TO brain_connections_origin_idx;
ALTER INDEX IF EXISTS data_entries_set_orden_idx RENAME TO data_entries_set_order_idx;
ALTER INDEX IF EXISTS pr_fecha RENAME TO pr_date;
ALTER INDEX IF EXISTS res_fecha RENAME TO res_date;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brain_connections_origen_check')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brain_connections_origin_check') THEN
    ALTER TABLE brain_connections RENAME CONSTRAINT brain_connections_origen_check TO brain_connections_origin_check;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brain_connections_confianza_check')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brain_connections_confidence_check') THEN
    ALTER TABLE brain_connections RENAME CONSTRAINT brain_connections_confianza_check TO brain_connections_confidence_check;
  END IF;
END $$;

-- ── Earlier names of the agent helper functions ──────────────────────────────
-- agent-functions.sql no longer creates the Spanish-named wrappers (each one only calls the
-- English function by name). Where one is left over, it is dropped, unless something still
-- depends on it (a policy of a kon migration written before the rename): then it stays, and
-- keeps working as before. It is never renamed onto the English name: the wrapper's parameter
-- names differ, and agent-functions.sql could no longer replace the function.

DO $$
DECLARE
  old_sig text;
  old_oid oid;
BEGIN
  FOREACH old_sig IN ARRAY ARRAY[
    'kitsuden_patron_cubre(text,text)',
    'kitsuden_agente_concede(text)',
    'kitsuden_agente_denegado(text)',
    'kitsuden_agente_abre_kon(text)',
    'kitsuden_admin_efectivo(text)',
    'kitsuden_staff_efectivo(text)',
    'kitsuden_agente_puede(text)',
    'kitsuden_agente_puede_en_kon(text,text)'
  ] LOOP
    old_oid := to_regprocedure(old_sig);
    IF old_oid IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_depend
       WHERE refclassid = 'pg_proc'::regclass AND refobjid = old_oid AND deptype = 'n'
    ) THEN
      EXECUTE 'DROP FUNCTION ' || old_sig;
    END IF;
  END LOOP;
END $$;

-- ── A data_entries policy under its earlier name ─────────────────────────────
-- rls-policies.sql creates it as data_entries_dataset_read.

DROP POLICY IF EXISTS data_entries_lectura_por_dataset ON data_entries;

-- ── Table and column comments ─────────────────────────────────────────────────
-- Written in Spanish by 0020, 0021 and 0026. Only objects that still exist are commented.

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('agent_identities', 'type',
       'Agent type for classification: claude-desktop, scraper, worker, webhook, mcp-server, custom'),
      ('agent_identities', 'capabilities',
       'Agent capabilities: ["web-search", "code-generation", "data-analysis", "image-processing"]'),
      ('agent_identities', 'system_prompt',
       'System prompt: the base instructions that define the agent''s personality and behavior'),
      ('agent_identities', 'allowed_tools',
       'Tools the agent may call: ["read_dataset", "write_post", "send_webhook"]'),
      ('agent_memory', NULL,
       'Cognitive memory for AI agents. Stores short- and long-term context.'),
      ('agent_memory', 'memory_type',
       'Memory type: short_term (session/temporary context), long_term (persistent), episodic (events), semantic (knowledge)'),
      ('agent_memory', 'category',
       'Memory category: conversation, task, insight, preference, context, etc.'),
      ('agent_memory', 'content',
       'Main content as JSON. Flexible structure depending on the memory type.'),
      ('agent_memory', 'importance',
       'Importance score (0-100). Used for garbage collection and prioritization.'),
      ('agent_memory', 'confidence',
       'Confidence that the information is true (0-100). Used to filter uncertain information.'),
      ('agent_memory', 'embedding',
       'Embedding vector for semantic search. Requires the pgvector extension.'),
      ('agent_memory', 'valid_until',
       'When the memory expires. NULL means it does not expire.'),
      ('brain_sources', NULL,
       'Layer 1 (Karpathy): immutable raw sources. INSERT/DELETE only, never UPDATE.')
    ) AS t(tbl, col, txt)
  LOOP
    IF c.col IS NULL THEN
      IF to_regclass('public.' || c.tbl) IS NOT NULL THEN
        EXECUTE format('COMMENT ON TABLE %I IS %L', c.tbl, c.txt);
      END IF;
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = c.tbl AND column_name = c.col
    ) THEN
      EXECUTE format('COMMENT ON COLUMN %I.%I IS %L', c.tbl, c.col, c.txt);
    END IF;
  END LOOP;
END $$;
