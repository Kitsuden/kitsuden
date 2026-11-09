-- Retire `kitsuden_config`: kon settings live in `modules.settings`
-- ============================================================================
--
-- `kitsuden_config` was a SECOND store of kon settings in parallel to the one
-- that already existed —the `settings` column of `modules`, where the panel writes and
-- where `PATCH /api/modules/:key` reads from—. Only kon-media used it.
--
-- Two stores for the same thing drift apart as soon as someone edits one, and here the
-- risk was concrete: the panel could save kon-media settings into
-- `modules.settings` while the kon read from the other table and never saw them.
--
-- ── WHY IT CAN BE DROPPED WITHOUT MIGRATING DATA ───────────────────────────
--
-- Because it never held any. The code created it on the fly with
-- `CREATE TABLE IF NOT EXISTS` from the application, and the API connects with a
-- role WITHOUT the CREATE privilege on the schema, so the CREATE failed, the
-- INSERT after it failed too, and `POST /api/media/config` returned 500 on every
-- server. The table only existed through migration 0039, which created it only
-- so that this code could work; it is redundant now.
--
-- Even so, anything that was there is copied before dropping: in a database where someone
-- created it by hand, those settings are real and losing them silently would be
-- exactly the class of failure this repo has been fixing for days.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'kitsuden_config'
  ) THEN
    -- Rescue any settings that existed, without overwriting those already in `modules`.
    INSERT INTO modules (key, name, category, enabled, settings)
    SELECT c.key,
           c.key,
           'optional',
           false,
           CASE WHEN jsonb_typeof(c.value) = 'object' THEN c.value ELSE '{}'::jsonb END
      FROM kitsuden_config c
     ON CONFLICT (key) DO UPDATE
        SET settings = CASE
              WHEN modules.settings IS NULL OR modules.settings = '{}'::jsonb
                THEN EXCLUDED.settings
              ELSE modules.settings
            END;

    DROP TABLE kitsuden_config;
  END IF;
END $$;
